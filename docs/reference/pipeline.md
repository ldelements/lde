# @lde/pipeline

A framework for transforming large RDF datasets, primarily using [SPARQL](https://www.w3.org/TR/sparql11-query/) queries with TypeScript for the parts that are hard to express in SPARQL alone.

- **SPARQL-native.** Data transformations are plain SPARQL query files – portable, transparent, testable and version-controlled.
- **Composable.** Readers are an interface: wrap a SPARQL reader with custom TypeScript to handle edge cases like date parsing or string normalisation (see [Reader](#reader)).
- **Extensible.** A plugin system lets packages like [@lde/pipeline-void](./pipeline-void) (or your own plugins) hook into the pipeline lifecycle.

## Installation

```sh
npm install @lde/pipeline
```

## Usage

```typescript
import {
  Pipeline,
  Stage,
  SparqlConstructReader,
  SparqlItemSelector,
  SparqlUpdateWriter,
  ManualDatasetSelection,
} from '@lde/pipeline';

const pipeline = new Pipeline({
  datasetSelector: new ManualDatasetSelection([dataset]),
  stages: [
    new Stage({
      name: 'per-class',
      itemSelector: new SparqlItemSelector({
        query: 'SELECT DISTINCT ?class WHERE { ?s a ?class }',
      }),
      readers: new SparqlConstructReader({
        query:
          'CONSTRUCT { ?class a <http://example.org/Class> } WHERE { ?s a ?class }',
      }),
    }),
  ],
  writers: new SparqlUpdateWriter({
    endpoint: new URL('http://localhost:7200/repositories/lde/statements'),
  }),
});

await pipeline.run();
```

## Components

A **Pipeline** consists of:

- a **Dataset Selector** that selects which datasets to process
- a **Distribution Resolver** that resolves each dataset to a usable SPARQL endpoint
- one or more **Stages**, each consisting of:
  - an optional **Item Selector** that selects resources (as variable bindings) for fan-out
  - one or more **Readers** that generate triples

### Dataset Selector

Selects datasets, either manually or by querying a DCAT Dataset Registry:

```typescript
// From a registry
const selector = new RegistrySelector({
  registry: new Client(new URL('https://example.com/sparql')),
});

// Manual
const selector = new ManualDatasetSelection([dataset]);
```

### Distribution Resolver

Resolves each dataset to a usable SPARQL endpoint. `SparqlDistributionResolver` probes a dataset’s own endpoint; wrap it in `ImportResolver` to add the ability to import a data dump into a local SPARQL server.

`ImportResolver`’s `strategy` controls how the source is chosen, ordered by how eagerly a dump is imported:

```typescript
const resolver = new ImportResolver(new SparqlDistributionResolver(), {
  importer,
  server,
  strategy: 'sparqlWithImportFallback',
});
```

- `'sparql'` (default) – use the dataset’s own SPARQL endpoint when one is available; import a data dump only when no endpoint responds.
- `'sparqlWithImportFallback'` – like `'sparql'`, but also fall back to the data dump when the endpoint passes probing yet a stage fails against it at runtime. The pipeline discards the endpoint-sourced partial output and re-runs all stages against the import. Use this when endpoints are present but unreliable for heavy aggregate queries.
- `'import'` – always import the data dump, even when a working endpoint is advertised.

`SparqlDistributionResolver` accepts a `timeout` option (default: 5000 ms) that bounds each probe request.

For custom resolution, implement the `DistributionResolver` interface. It works in two phases, so the pipeline can [skip an unchanged dataset](../guide/skip-unchanged-datasets) before paying any import cost: `probe(dataset)` probes every distribution and picks the source-to-be without importing; `resolve(probed)` turns that source into a usable SPARQL endpoint, importing a data dump only when the source is one. Two optional methods complete the contract: `resolveFallback(probed)` re-resolves to an imported dump after a probed endpoint fails stages at runtime (the reactive fallback – a resolver without it keeps the endpoint-sourced partial output), and `cleanup()`, called after each dataset, e.g. to stop a local server.

### Failure isolation

A run degrades per dataset rather than failing as a whole:

- A stage failure is caught and reported (`stageFailed`); the dataset is marked failed – its `flush` outcome and provenance record say `'failed'` – and the run continues with the next dataset, after the [reactive dump fallback](#distribution-resolver) has had its chance, when configured.
- A probe or resolve failure skips the dataset (`datasetSkipped`); the run continues.
- A per-dataset writer `flush` failure is likewise isolated to that dataset.
- Only failures outside per-dataset processing abort the run – the dataset selector’s iteration and the writer’s `commit` – in which case the pipeline calls `writer.abort(error)` and rethrows.
- An [empty selection](#empty-selections) also aborts the run, but does **not** rethrow: the run is abandoned rather than failed.

#### Empty selections

A run whose selector produces no datasets is **abandoned**, not committed: the pipeline calls `writer.abort(new EmptySelection())`, reports `selectionEmpty`, and returns normally.

Every writer reads the run’s selection as the authoritative membership of its destination – that is what lets an In-place writer sweep departed sources and a Blue/green writer ship a fresh collection. An empty selection would make that reading catastrophic: the In-place sweep classifies every indexed source as departed and deletes the lot, and the Blue/green swap makes an empty collection live and drops the one that held the data. Since an empty result is indistinguishable from a registry outage, a store mid-reload or a mistyped `DATASET_CRITERIA`, it is never treated as membership.

The run does not throw, because an empty registry is a legitimate state rather than a failure, and it still reports `pipelineComplete`: it completed, it simply applied nothing. A consumer that needs to tell the two apart keys on `selectionEmpty`, which precedes it.

To empty a destination deliberately, drop it.

Two consequences worth knowing:

- **A partial collapse is not covered.** A selector returning 3 of 2731 datasets sweeps the other 2728, exactly as before. Any “suspiciously fewer than last time” threshold would be arbitrary, so only the all-or-nothing case is guarded.
- **A Blue/green destination is not created by an abandoned run.** The alias is upserted on `commit`, so a first-ever run against an empty registry leaves no collection and no alias behind, and a reader querying the alias meets a missing collection rather than an empty result. The alias appears as soon as one run selects something.

### Stage

A stage groups an item selector, one or more readers, and configuration:

```typescript
new Stage({
  name: 'per-class',
  itemSelector: new SparqlItemSelector({
    query: 'SELECT DISTINCT ?class WHERE { ?s a ?class }',
  }),
  readers: reader,
  batchSize: 100,
  maxConcurrency: 5,
});
```

#### Batch size

`batchSize` (default: 10) controls how many variable bindings are passed to each reader call as a `VALUES` clause. It also sets the page size for the item selector's SPARQL requests, so that each paginated request fills exactly one reader batch.

Some SPARQL endpoints enforce different result limits for SELECT and CONSTRUCT queries. Since the selector uses SELECT and the reader uses CONSTRUCT, a `LIMIT` clause in the selector query overrides `batchSize` as the page size. Use this when the endpoint caps SELECT results below your desired batch size:

```typescript
// Endpoint caps SELECT results at 500, but each CONSTRUCT can handle 1000 bindings.
new Stage({
  name: 'per-class',
  itemSelector: new SparqlItemSelector({
    query: 'SELECT DISTINCT ?class WHERE { ?s a ?class } LIMIT 500',
  }),
  readers: reader,
  batchSize: 1000, // Two SELECT pages fill one CONSTRUCT batch.
});
```

#### Concurrency

`maxConcurrency` (default: 10) limits the total number of concurrent SPARQL queries. Within each batch, all readers run in parallel; the number of concurrent batches is automatically reduced to `⌊maxConcurrency / readerCount⌋` so the total query pressure stays within the limit. For example, with `maxConcurrency: 10` and two readers per stage, up to 5 batches run concurrently (10 SPARQL queries total).

#### Queue capacity

`queueCapacity` (default: 128) bounds the queue that funnels the concurrent batches’ output items into the single write. Producers block once that many items are pending, so it bounds stage memory in items rather than in input size. Lower it when each item is heavy – a [projected](#projecting-batches-with-project) document weighs far more than a quad. Only meaningful with an item selector.

#### Expecting output

`expectsOutput` (default: `false`) marks a stage whose query must yield at least one quad. A supported stage that produces none is then treated as a hard failure rather than a legitimately empty result.

Set it for scalar aggregates such as `SELECT (COUNT(*) AS ?n)`, which always return exactly one row – so zero output can only mean the endpoint truncated or aborted the response (e.g. a timeout surfaced as an empty `HTTP 200`). The failure flows through like any other hard stage failure, triggering the [reactive dump fallback](#distribution-resolver) when `strategy: 'sparqlWithImportFallback'` is configured. Leave it `false` for stages that may legitimately be empty, such as class or property partitions of a dataset that lacks that structure.

#### Projecting batches with `project`

`project` (a `BatchTransform<Out>`) is the pipeline’s one type-changing seam: it turns each root-complete batch of quads into the stage’s output items, changing the item type `Out` of `Stage`, `Pipeline` and the [writers](#writer) from `Quad` to, say, a search document (see [ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)). The transform receives the batch’s quads plus a `BatchContext`: the dataset, distribution, stage name and the item-selector `bindings` the readers were given as a `VALUES` block – so the batch is root-complete by construction.

`project` requires an `itemSelector` (without one there is no batch, only the readers’ whole output) and cannot combine with chained `stages` (scratch files are N-Triples, which a projected item cannot serialize to). A projecting pipeline also cannot use quad-level [plugins](#plugins); reader-attached quad transforms are unaffected, since they run before the projection. [@lde/search-pipeline](./search-pipeline) is the flagship user, projecting each batch into search documents.

#### Skipped stages

A stage that cannot run against a dataset is skipped, not failed: when every reader returns `NotSupported`, or the item selector yields no items, the pipeline reports `stageSkipped` and moves on. The selector is peeked before the writer’s first write, so a destructive writer – `SparqlUpdateWriter` issues `CLEAR GRAPH` on first write – does not clear anything for a stage that turns out to be empty. Inside a [chain](#chaining-stages), `NotSupported` fails the chain instead.

### Chaining stages

A stage can declare sub-stages via `stages`; each sub-stage queries the previous stage’s output instead of the dataset’s distribution. Every stage in a chain writes N-Triples to a scratch file under a configured `outputDir`, a `StageOutputResolver` turns that file into the `Distribution` the next stage queries, and the chain’s concatenated output is written to the pipeline’s [writers](#writer) under the parent stage’s name.

When any stage has sub-stages, the pipeline’s `chaining` option is required – the constructor throws without it:

```typescript
new Pipeline({
  // …
  chaining: {
    stageOutputResolver, // implements StageOutputResolver
    outputDir: './scratch', // where the intermediate N-Triples files go
  },
});
```

Because the scratch files are N-Triples, chains are quad-only: a stage with `stages` cannot `project`. A chained stage that returns `NotSupported` fails the chain rather than being skipped. See the how-to guide [Chain stage outputs](../guide/chain-stage-outputs).

### Item Selector

Selects resources from the distribution and fans out reader calls per batch of results. Implements the `ItemSelector` interface:

```typescript
interface ItemSelector {
  select(
    distribution: Distribution,
    batchSize?: number,
    options?: SelectOptions,
  ): AsyncIterable<VariableBindings>;
}
```

The distribution is received at run time, so selectors don't need the endpoint URL at construction time. The `batchSize` parameter is set by the stage; `options` carries the per-dataset [timeout policy](#timeout-policies). Use `SparqlItemSelector` for SPARQL-based selection with automatic pagination:

```typescript
new SparqlItemSelector({
  query: 'SELECT DISTINCT ?class WHERE { ?s a ?class }',
});
```

A row is yielded only when **every** projected variable binds a `NamedNode` – binding values double as stable item identities downstream, which a blank-node label or literal cannot provide. Other rows are dropped client-side but still count toward pagination, so they are fetched first; to skip them at the endpoint, filter in the query itself (e.g. `FILTER(isIRI(?s))`, as `selectByClass` in [@lde/search-pipeline](./search-pipeline) does with `FILTER(!isBlank(?root))`).

#### Capping total results with `maxResults`

By default, `SparqlItemSelector` paginates through **all** matching rows: any `LIMIT` clause in the query is interpreted as the page size, then it walks pages with `OFFSET` until the source is exhausted. To cap the total bindings yielded across all pages – for sampling, testing, prototyping, or just safety – set `maxResults`:

```typescript
new SparqlItemSelector({
  query: 'SELECT DISTINCT ?s WHERE { ?s a <http://example.com/Class> }',
  maxResults: 50,
});
```

When `maxResults` is set:

- Pagination stops as soon as `maxResults` bindings have been yielded – no wasted page request after the cap is hit.
- As long as no row has been dropped, the last (partial) page's `LIMIT` is shrunk to the remaining cap so the endpoint doesn't over-fetch on the remainder (e.g. with `maxResults: 85` and `pageSize: 10`, the 9th page request is `LIMIT 5`, not `LIMIT 10`). Once rows have been dropped, pages stay at full size – shrinking to the yielded remainder would crawl a dropped-row region one row per request.
- The first page uses the configured page size as-is; `maxResults` and page size stay orthogonal. If `maxResults < pageSize`, the first page may return a few rows that aren't yielded.
- `maxResults: 0` is a valid no-op; the selector yields nothing without issuing any SPARQL request.
- `maxResults` is independent of any `LIMIT` clause in the query, which still controls page size when the cap is larger than one page.

For dynamic queries that depend on the distribution, implement `ItemSelector` directly. Pass `options` through to the inner selector – it carries the per-dataset timeout policy, and a custom selector that drops it silently loses timeout-policy enforcement:

```typescript
const itemSelector: ItemSelector = {
  select: (distribution, batchSize, options) => {
    const query = buildQuery(distribution);
    return new SparqlItemSelector({ query }).select(
      distribution,
      batchSize,
      options,
    );
  },
};
```

### Reader

Generates RDF triples. The built-in `SparqlConstructReader` runs a SPARQL CONSTRUCT query with template substitution and variable bindings:

```typescript
const reader = new SparqlConstructReader({
  query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
});
```

The query is templated per dataset and distribution, in order:

1. `#subjectFilter#` is replaced with `distribution.subjectFilter` (the empty string when unset).
2. When the distribution has a `namedGraph`, a `FROM <graph>` clause is injected for it.
3. Every literal `?dataset` occurrence is replaced with the dataset’s IRI. This includes a genuine `?dataset` variable, which gets rewritten too – don’t name an ordinary query variable `?dataset`.

Transient failures – network errors and HTTP 502/503/504 – are retried; `retries` (default: 3) sets how many times. `SparqlConstructReaderOptions.fetcher` injects a custom `SparqlEndpointFetcher`, intended for tests; the reader then uses it as-is, so the per-request budget from the [timeout policy](#timeout-policies) is not enforced (the policy’s hooks still fire, but its own `timeout` governs).

When querying endpoints that return line-oriented formats like N-Triples (e.g. QLever), enable `lineBuffer` to work around an [N3.js chunk-splitting bug](https://github.com/rdfjs/N3.js/issues/578) that causes intermittent parse errors on large responses:

```typescript
const reader = new SparqlConstructReader({
  query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
  lineBuffer: true,
});
```

SPARQL CONSTRUCT queries can produce duplicate triples – for example, constant triples (like `?dataset a edm:ProvidedCHO`) are emitted for every solution row. Enable `deduplicate` to remove duplicates inline on the stream using a string-based identity set (inspired by [Comunica's `distinctConstruct`](https://comunica.dev/docs/query/advanced/context/#14--distinct-construct)):

```typescript
const reader = new SparqlConstructReader({
  query: 'CONSTRUCT { ?s a edm:ProvidedCHO . ?s ?p ?o } WHERE { ?s ?p ?o }',
  deduplicate: true,
});
```

The dedup set is scoped to each `read()` call, so memory stays bounded to the number of unique quads per batch. A standalone `deduplicateQuads()` function is also exported for use outside the reader.

Logic that is hard to express in pure SPARQL – cleaning up messy date notations, converting locale-specific dates to ISO 8601 – can be attached to a reader as a **quad transform**, a plain function that post-processes the reader’s output. See the how-to guide [Extend a stage with a quad transform](../guide/extend-a-stage-with-a-quad-transform).

### Timeout policies

By default, every SPARQL request uses the same 5-minute budget. When a pipeline runs against many third-party endpoints, that fixed budget can cost ~80 minutes on a single dataset whose endpoint times out repeatedly on heavy queries – light stages on the same endpoint then sit behind the heavy ones that will never succeed.

A `TimeoutPolicy` decides the budget for each SPARQL request and observes the outcome. Two are built in:

- **`ConstantTimeoutPolicy(timeoutMs)`** – returns the same budget for every request. The implicit default when `PipelineOptions.timeout` is omitted (`constantTimeoutPolicy(300_000)`).
- **`AdaptiveTimeoutPolicy({ defaultMs, tightenedMs, tightenAfterTimeouts })`** – per-endpoint state machine. Each endpoint is either _healthy_ (use `defaultMs`) or _tightened_ (use `tightenedMs`). After `tightenAfterTimeouts` consecutive `timeout` outcomes the endpoint flips to _tightened_; a single `ok` flips it back to _healthy_.

`PipelineOptions.timeout` accepts a `() => TimeoutPolicy` factory. The pipeline invokes it once per dataset, so policy state resets between datasets and one bad dataset can’t poison the next:

```typescript
import { adaptiveTimeoutPolicy } from '@lde/pipeline';

new Pipeline({
  // …
  timeout: adaptiveTimeoutPolicy({
    defaultMs: 300_000, //         5 min while the endpoint is healthy
    tightenedMs: 10_000, //        10 s once the endpoint is tightened
    tightenAfterTimeouts: 2, //    flip to tightened after 2 consecutive timeouts
  }),
});
```

Outcomes are classified as:

| outcome   | source                                                                   |
| --------- | ------------------------------------------------------------------------ |
| `ok`      | the request resolved                                                     |
| `timeout` | client-side `AbortSignal.timeout()` fired, or upstream returned HTTP 504 |
| `error`   | anything else (other HTTP errors, parse errors, …) – neutral             |

Transitions are forwarded to the `ProgressReporter` via `timeoutTightened` / `timeoutRelaxed`; `ConsoleReporter` prints them as `↘ Tightened` / `↗ Relaxed` lines so operators can tell a fast-failed stage from an unexpected speedup.

Implement `TimeoutPolicy` directly for custom strategies (closing over shared state in the factory if you want it to span datasets).

Timeouts live at the pipeline level – neither `SparqlConstructReader` nor `SparqlItemSelector` accept their own `timeout` option. Per-endpoint state belongs in the adaptive policy, and per-stage budgets aren’t supported. Reusable stage facades ([@lde/pipeline-void](./pipeline-void), [@lde/pipeline-shacl-sampler](./pipeline-shacl-sampler)) follow the same convention.

### Validation

Stages can optionally validate their output quads against a `Validator`. The unit of validation depends on the stage: with an item selector, validation operates on the **combined output of all readers per batch** – each batch is a self-contained cluster of linked resources that can be meaningfully matched against SHACL shapes. Without an item selector, the stage’s **entire output** is buffered and validated as one unit, so memory grows with the stage’s whole output – keep validated selector-less stages small, or give the stage an item selector. Quads are buffered, validated, and then written or discarded based on the `onInvalid` policy (`'write'`, `'skip'` or `'halt'`); when no validator is configured, quads stream directly with zero overhead.

`Validator` is an interface, so you can implement your own validation strategy; [@lde/pipeline-shacl-validator](./pipeline-shacl-validator) is the SHACL implementation. See the how-to guide [Validate pipeline output with SHACL](../guide/validate-pipeline-output) for configuration, failure policies and per-dataset reporting.

### Writer

Writes generated quads to a destination. A `Writer` is transactional: each pipeline run opens one run on it (`openRun(context)`), writes every dataset through the resulting `RunWriter`, and ends with exactly one `commit()` or `abort(error)`. A run commits when it processed a selection; it aborts on failure **and on an [empty selection](#empty-selections)**, so `abort` means “this run’s output must not be applied”, not necessarily “this run failed”. A writer that alerts or exits non-zero on `abort` should distinguish the two by the error it receives (`EmptySelection`). The run lifecycle is the home of destination-level concerns such as atomic swaps, deletion sweeps and cross-pod locks; the pipeline drives `openRun → write* → commit/abort` uniformly and never branches on the writer’s update mode. After a dataset’s stages complete, its `flush(dataset, outcome)` says whether the dataset succeeded, so a writer can gate destructive finalization (e.g. an In-place stale-document sweep) on `'success'`.

A `RunWriter` may also implement the optional `reset(dataset)`, which discards a dataset’s already-written output. The pipeline invokes it before re-running all stages against a fallback dump ([reactive fallback](#distribution-resolver)); a custom writer without `reset` appends the re-run’s output to the endpoint-sourced partial output instead of replacing it.

#### `SparqlUpdateWriter`

Writes to a SPARQL endpoint via SPARQL UPDATE queries (options: `SparqlWriterOptions`):

- Each dataset’s quads land in a named graph derived by `graphIri(dataset)` – by default the dataset’s own IRI. Override it when the quads are an enrichment (e.g. a validation report) that belongs in a different graph.
- The graph is cleared with `CLEAR GRAPH` before the first write per dataset per run – destructive: a re-run replaces each graph. `reset` re-arms the clear, so a fallback re-run replaces rather than appends.
- Quads are chunked into `INSERT DATA` requests of `batchSize` (default: 10 000) triples, so the whole dataset never accumulates in memory.
- `auth` sets the `Authorization` header value verbatim (e.g. `'Basic …'`, `'Bearer …'`); `fetch` injects a custom fetch implementation (default: `globalThis.fetch`).
- Writes are visible as they land, so `commit`/`abort` are no-ops: an aborted run leaves the graphs written so far, to be replaced by the next run.

#### `FileWriter`

Writes one file per dataset under `outputDir`, named after the dataset IRI. Each file is streamed to a sibling temp file and atomically renamed on flush, `commit` finalizes any files still open, and `abort` discards temp output. Options:

- `format` – `'n-triples'` (default), `'turtle'` or `'n-quads'`.
- `prefixes` – prefix declarations, used only with `format: 'turtle'`.
- `replacementCharacter` (default: `'-'`) – replaces URL-unsafe characters when deriving filenames from dataset IRIs.
- `graphIri` – an `(dataset: Dataset) => URL` callback, meaningful only for `'n-quads'` (the other formats have no graph slot): every quad is re-emitted with the derived graph term, regardless of the quad’s own graph, mirroring `SparqlUpdateWriter`’s `graphIri`.

In `n-quads` format it skolemises blank nodes to dataset-scoped IRIs, because such files are typically `cat`-indexed into one served graph where document-scoped blank-node labels from different datasets would otherwise fuse (see ldelements/lde#474). Scoping the skolem IRIs hashes the write, so each `n-quads` write is buffered in memory; Turtle/N-Triples output streams through unchanged.

#### Multiple writers

`writers` accepts a single `Writer` or an array. With an array, output fans out to every writer: each item stream is teed with backpressure from the slowest consumer, so no branch buffers ahead. If one writer fails to open its run, already-opened sibling runs are rolled back with `abort` so their locks and collections don’t leak; commits run concurrently, since destinations are independent.

#### Using a writer standalone

The `RunContext` handed to `openRun` carries the run’s identity (`runId`, `startedAt`), the full selection (`selectedSources()`, complete by commit time – including datasets skipped as unchanged) and the pipeline’s provenance store, when configured. Outside a pipeline, drive the same lifecycle yourself:

```typescript
const run = await writer.openRun({
  runId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
  selectedSources: () => [dataset.iri.toString()],
});
try {
  await run.write(dataset, quads);
  await run.flush?.(dataset, 'success');
  await run.commit();
} catch (error) {
  await run.abort(error);
  throw error;
}
```

A destination without run-level state implements the same contract with no-op `commit`/`abort` – `SparqlUpdateWriter` shows the pattern:

```typescript
async openRun(): Promise<RunWriter> {
  return {
    write: async (dataset, quads) => {
      // send quads somewhere
    },
    commit: () => Promise.resolve(),
    abort: () => Promise.resolve(),
  };
}
```

### Reporter

A `ProgressReporter` observes the run, receiving lifecycle events such as `pipelineStart`, `stageComplete`, `datasetValidated` and `pipelineComplete`. Every method is optional, so a reporter implements only the events it cares about.

Pass a single reporter, or an array to have several observe the same run – for example a console reporter alongside one that collects validation verdicts:

```typescript
new Pipeline({
  // …
  reporter: [new ConsoleReporter(), verdictCollector],
});
```

Each reporter receives every event, in array order; a reporter that does not implement a given event is skipped for it. See the how-to guide [Observe a run with a reporter](../guide/observe-a-run-with-a-reporter).

The full event set, in rough lifecycle order:

| Event                                                                                       | Fired                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pipelineStart(name)`                                                                       | Once, when the run starts.                                                                                                                |
| `datasetsSelected(count, duration)`                                                         | After the dataset selector returns, with the selection size and duration (ms).                                                            |
| `selectionEmpty(reason)`                                                                    | When the run is abandoned because the selection was empty – no commit, destination unchanged (see [Empty selections](#empty-selections)). |
| `datasetStart(dataset)`                                                                     | When a dataset’s processing begins; datasets are processed one at a time, so it precedes all of that dataset’s later events.              |
| `distributionProbed(result)`                                                                | Each time a single distribution probe completes, with a `DistributionAnalysisResult`.                                                     |
| `importStarted()`                                                                           | When a data-dump import begins.                                                                                                           |
| `importFailed(distribution, error)`                                                         | When importing a distribution fails.                                                                                                      |
| `distributionValidated(distribution, verdict)`                                              | With the RDF-validity verdict for each distribution the pipeline attempted – even when the dataset is otherwise skipped.                  |
| `distributionSelected(dataset, distribution, importedFrom?, importDuration?, tripleCount?)` | When a dataset’s source is resolved; the optional arguments are set when it was imported from a dump.                                     |
| `stageStart(stage)`                                                                         | When a stage begins.                                                                                                                      |
| `stageProgress({ itemsProcessed, quadsGenerated, memoryUsageBytes, heapUsedBytes })`        | After each batch a stage processes.                                                                                                       |
| `stageComplete(stage, { itemsProcessed, quadsGenerated, duration })`                        | When a stage finishes successfully.                                                                                                       |
| `stageSkipped(stage, reason)`                                                               | When a stage is [skipped](#skipped-stages) (`NotSupported` or an empty selector).                                                         |
| `stageFailed(stage, error)`                                                                 | When a stage hard-fails; the run continues (see [Failure isolation](#failure-isolation)).                                                 |
| `datasetValidated(dataset, report)`                                                         | Once per (dataset, validator) pair after all stages, even when nothing was validated – read `quadsValidated` to distinguish ‘not tested’. |
| `datasetSkipped(dataset, reason)`                                                           | When a dataset is skipped: probe/resolve failure, no distribution available, or unchanged since the last run.                             |
| `datasetComplete(dataset, { memoryUsageBytes, heapUsedBytes })`                             | When a dataset’s processing ends.                                                                                                         |
| `pipelineComplete({ duration, memoryUsageBytes, heapUsedBytes })`                           | Once, when the run ends.                                                                                                                  |
| `timeoutTightened(event)`                                                                   | When a [timeout policy](#timeout-policies) tightens an endpoint’s budget after consecutive timeouts.                                      |
| `timeoutRelaxed(event)`                                                                     | When a timeout policy relaxes a previously-tightened endpoint back to the default budget.                                                 |

### Provenance store

A `ProvenanceStore` gives the pipeline a small per-dataset memory, so a future run can skip datasets that are genuinely unchanged. It is purely a storage seam: the framework owns the skip decision, the store owns only how each record is persisted. See the how-to guide [Skip unchanged datasets](../guide/skip-unchanged-datasets) for enabling it and the skip semantics.

```typescript
interface ProvenanceStore {
  check?(): Promise<void>;
  get(datasetUri: URL): Promise<ProcessingRecord | null>;
  set(datasetUri: URL, record: ProcessingRecord): Promise<void>;
}
```

The optional `check` verifies the store can persist records; the pipeline calls it once at the start of a run, so a store that would fail every write fails the run immediately instead of silently disabling skip-unchanged. A record write that fails mid-run is reported through the reporter (`stageFailed` with stage `'provenance'`) and does not abort the run.

A `ProcessingRecord` holds the two opaque change fields – `sourceFingerprint` (derived automatically from source metadata) and `pipelineVersion` (consumer-declared) – plus `generatedAt` and a `status` of `'success'` or `'failed'`. The two change fields are compared only for equality, never parsed or ordered.

Two implementations ship with the package:

- **`FileLoadedSparqlProvenanceStore`** targets a triplestore that is served read-only and rebuilt by bulk-loading files (e.g. [QLever](https://github.com/ad-freiburg/qlever)). It reads through named-graph-scoped SPARQL queries against the live endpoint, and writes one flat [PROV-O](https://www.w3.org/TR/prov-o/) N-Quads file per dataset for the next bulk-load – because the endpoint accepts no SPARQL UPDATE. Scoping every record by `pipelineIri` (used as the named graph) lets multiple pipelines share one triplestore without colliding.
- **`FileProvenanceStore`** persists all records to a single JSON file, keyed by dataset URI, for pipelines that run without a triplestore. Writes are atomic (temp file + rename), so a run killed mid-write cannot corrupt the next run’s skip decisions. Safe for a single writer only. The file’s directory must be writable by the user the pipeline runs as – `check` probes this with a real write at the start of the run, so a read-only or root-owned mount fails loudly instead of silently disabling skipping.

#### Source-change fingerprint

`sourceFingerprint(distribution, probeResult)` derives a cheap, opaque change signal for a distribution from metadata the probe already collected – no body download. For a data dump it combines the most recent of the register’s `dct:modified` and the artifact’s HTTP `Last-Modified` with the byte size (the probe’s `Content-Length`, falling back to the declared `dcat:byteSize`). It returns `null` for a live SPARQL endpoint, or when no date and no size can be established – a `null` fingerprint never compares equal, so such a distribution is always reprocessed.

### Plugins

Plugins hook into the pipeline lifecycle via the `PipelinePlugin` interface. Register them in the `plugins` array when constructing a `Pipeline`. A plugin can implement either or both of two hooks, each a `QuadTransform`:

- **`beforeStageWrite`** runs over each stage’s output as it is written – scoped to one stage’s quads for one dataset.
- **`beforeDatasetWrite`** runs once over a dataset’s combined cross-stage output, just before it is written – scoped to the whole dataset, so it can reconcile quads that different stages produced. The output is streamed through a single queue rather than materialized, so memory stays bounded by whatever the transform itself buffers; it honors the writer’s run lifecycle (`flush`/`reset`/`commit`/`abort`), and a failure is isolated to the dataset being written.

Both hooks are domain-agnostic – dedup, roll-ups, provenance stamping, or namespace rewriting can use them. This package ships `provenancePlugin()`, `namespaceNormalizationPlugin()`, and `schemaOrgNormalizationPlugin()` (all `beforeStageWrite` plugins). Plugins that must understand a particular RDF shape live with that vocabulary: for example, [@lde/pipeline-void](./pipeline-void) ships `schemaOrgPartitionMergePlugin()`, a `beforeDatasetWrite` plugin that merges the VoID partition _nodes_ that Schema.org `http`/`https` variants produce.

#### `provenancePlugin()`

Appends [PROV-O](https://www.w3.org/TR/prov-o/) provenance quads (`prov:Entity`, `prov:Activity`, `prov:startedAtTime`, `prov:endedAtTime`) to every stage’s output. The `prov:Activity` is a stable IRI keyed on `(dataset, stage)`, not a blank node, so activities stay distinct – and a re-run stays idempotent – when per-dataset outputs are merged into one graph (blank-node labels are not unique across separately serialised documents and would fuse unrelated activities).

#### `namespaceNormalizationPlugin(options)`

Rewrites every IRI in the `from` namespace to the `to` namespace, in subject, predicate and object position alike. A blanket, vocabulary-agnostic rewrite for standardizing a namespace across a dataset’s own quads – for example when mapping instance data to an application profile.

```typescript
import { namespaceNormalizationPlugin } from '@lde/pipeline';

new Pipeline({
  // ...
  plugins: [
    namespaceNormalizationPlugin({
      from: 'http://example.org/',
      to: 'https://example.org/',
    }),
  ],
});
```

#### `schemaOrgNormalizationPlugin(options?)`

Convenience wrapper around `namespaceNormalizationPlugin` for the common case: rewrites `http://schema.org/` to `https://schema.org/` (pass `{ reverse: true }` for the opposite direction).

```typescript
import { schemaOrgNormalizationPlugin, provenancePlugin } from '@lde/pipeline';

new Pipeline({
  // ...
  plugins: [schemaOrgNormalizationPlugin(), provenancePlugin()],
});
```

This is a plain rewrite and knows nothing about VoID. If your pipeline emits VoID partitions and a dataset mixes both schema.org namespaces, rewriting the `void:class` objects alone still leaves two `void:classPartition` nodes for one class – use [`schemaOrgPartitionMergePlugin`](./pipeline-void) from `@lde/pipeline-void`, which also merges those nodes.
