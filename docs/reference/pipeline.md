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

Selects datasets. A DCAT Dataset Registry is the primary way in; a local directory or a manual list serves data that has no registration:

```typescript
// From a registry
const selector = new RegistrySelector({
  registry: new Client(new URL('https://example.com/sparql')),
});

// One dataset per RDF file in a local directory
const selector = new DirectorySelector('./rdf');

// Manual
const selector = new ManualDatasetSelection([dataset]);

// Several of these in one run, in the order given
const selector = new CombinedSelector([registrySelector, directorySelector]);
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
- `'sparqlWithImportFallback'` – like `'sparql'`, but also fall back to the data dump when the endpoint passes probing yet a stage fails against it at runtime. The pipeline discards the endpoint-sourced partial output and re-runs all stages against the import. Once the re-run succeeds, the dataset is recorded under the dump’s change fingerprint, so a next run in which the endpoint fails probing can skip an [unchanged dump](../guide/skip-unchanged-datasets); a run in which the endpoint passes probing tries it again first. If the reset or the re-run fails, the record keeps the endpoint’s fingerprint and the dataset is retried. Use this when endpoints are present but unreliable for heavy aggregate queries.
- `'import'` – always import the data dump, even when a working endpoint is advertised.

`SparqlDistributionResolver` accepts a `timeout` option (default: 5000 ms) that bounds each probe request.

For custom resolution, implement the `DistributionResolver` interface. It works in two phases, so the pipeline can [skip an unchanged dataset](../guide/skip-unchanged-datasets) before paying any import cost: `probe(dataset)` probes every distribution and picks the source-to-be without importing; `resolve(probed)` turns that source into a usable SPARQL endpoint, importing a data dump only when the source is one. Two optional methods complete the contract: `resolveFallback(probed)` re-resolves to an imported dump after a probed endpoint fails stages at runtime (the reactive fallback – a resolver without it keeps the endpoint-sourced partial output), and `cleanup()`, called after each dataset, e.g. to stop a local server.

### Failure isolation

A run degrades per dataset rather than failing as a whole:

- A stage failure is caught and reported (a `stageFailed` event); the dataset is marked failed – its `flush` outcome and provenance record say `'failed'` – and the run continues with the next dataset, after the [reactive dump fallback](#distribution-resolver) has had its chance, when configured.
- A probe or resolve failure skips the dataset (a `datasetSkipped` event); the run continues.
- A per-dataset writer `flush` failure is likewise isolated to that dataset.
- A writer may leave some of a dataset’s items out rather than fail it – a search index refusing a document – and reports them through `RunContext.itemsRejected`, which the pipeline reports as an `itemsRejected` event.
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

How many of those queries reach the endpoint at once is up to the pipeline’s `limiter`, a [`HostLimiter`](host-limiter) keyed on the dataset’s IRI. Each dataset starts at one query in flight, and its limit then adapts to how the endpoint responds, up to the limiter’s per-host ceiling; see [the adaptive limit](host-limiter#an-adaptive-per-host-limit). Without one, every reader shares a default `createHostLimiter(10, 10)`, so a `maxConcurrency` above 10 needs a limiter with a higher ceiling to make a difference. A weak endpoint that falls over at two queries is therefore asked one at a time, while a strong one climbs to the ceiling within a few batches.

To share one limit with a [resolver](resolver) that loads the same backend – IIIF manifests served by the endpoint’s own server, say – create the limiter once and pass it to both, and key the resolver on the dataset too:

```typescript
const limiter = createHostLimiter(10, 8);
const pipeline = new Pipeline({ /* … */ limiter });
const manifests = createResolver({
  /* … */ limiter,
  host: (reference) => reference.dataset,
});
```

#### Queue capacity

`queueCapacity` (default: 128) bounds the queue that funnels the concurrent batches’ output items into the single write. Producers block once that many items are pending, so it bounds stage memory in items rather than in input size. Lower it when each item is heavy – a [projected](#projecting-batches-with-project) document weighs far more than a quad. Only meaningful with an item selector.

#### Expecting output

`expectsOutput` (default: `false`) marks a stage whose query must yield at least one quad. A supported stage that produces none is then treated as a hard failure rather than a legitimately empty result.

Set it for scalar aggregates such as `SELECT (COUNT(*) AS ?n)`, which always return exactly one row – so zero output can only mean the endpoint truncated or aborted the response (e.g. a timeout surfaced as an empty `HTTP 200`). The failure flows through like any other hard stage failure, triggering the [reactive dump fallback](#distribution-resolver) when `strategy: 'sparqlWithImportFallback'` is configured. Leave it `false` for stages that may legitimately be empty, such as class or property partitions of a dataset that lacks that structure.

#### Projecting batches with `project`

`project` (a `BatchTransform<Out>`) is the pipeline’s one type-changing seam: it turns each root-complete batch of quads into the stage’s output items, changing the item type `Out` of `Stage`, `Pipeline` and the [writers](#writer) from `Quad` to, say, a search document (see [ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)). The transform receives the batch’s quads plus a `BatchContext`: the dataset, distribution, stage name and the item-selector `bindings` the readers were given as a `VALUES` block – so the batch is root-complete by construction. A transform that cannot read a value and leaves it out of its item reports it through `context.valueUnread(target, field, { id, value })`; the pipeline tallies these per field – a count and at most 5 distinct examples – and passes them to the reporter (`valuesUnread`) when the dataset completes.

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

The distribution is received at run time, so selectors don't need the endpoint URL at construction time. The `batchSize` parameter is set by the stage; `options` carries the per-dataset [timeout policy](#timeout-policies) and the same [dataset bindings](#dataset-bindings) a reader gets. Use `SparqlItemSelector` for SPARQL-based selection with automatic pagination:

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
3. Per-item (selector) bindings, if any, are injected as a `VALUES` clause into the innermost sub-SELECT.
4. [Dataset bindings](#dataset-bindings) the query references are injected as a `VALUES` clause at the outermost scope. A `Stage` passes these. When calling `read()` yourself, pass them as `datasetBindings`, for example `predefinedDatasetBindings(dataset)`, or nothing is bound.

`SparqlConstructReaderOptions.fetcher` injects a custom `SparqlEndpointFetcher`, intended for tests; the reader then uses it as-is, so the per-request budget from the [timeout policy](#timeout-policies) is not enforced (the policy’s hooks still fire, but its own `timeout` governs), and a `Retry-After` header goes unread.

#### When the endpoint fails

Each query waits for a slot in the [pipeline’s limiter](#concurrency) and holds it until the endpoint starts answering. What the reader does then depends on the answer:

| Answer                                       | Means                                 | Limit      | Then                                                                                                                   |
| -------------------------------------------- | ------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| HTTP 502, 503 or 504, or a network error     | The endpoint is down or struggling    | Lowered    | Pause the dataset and try again, at most five times: 5, 15, 45, 135 and 405 s, or what `Retry-After` says, up to 405 s |
| A timeout                                    | The query took longer than its budget | Lowered    | Fail the read                                                                                                          |
| HTTP 500                                     | This query failed, not the endpoint   | Left alone | Split the batch, down to one root, which is reported as `rootSkipped` and left out                                     |
| Anything else, such as a 400 for a bad query | The query is wrong                    | Left alone | Fail the read                                                                                                          |

The backoff adds up to about 10 minutes, long enough to outlast a backend restart; a failed read then fails its stage, and the [reactive dump fallback](#distribution-resolver) takes over if configured. A pause drops the dataset’s limit to 1, so after it only one query goes out, and that query is the probe: if it is answered, the limit climbs back; if not, the next, longer pause follows.

A 500 that keeps coming back usually means the query does not fit in the endpoint’s memory for these roots, at any load. The reader reads each half of the batch, one after the other, splitting again where a half still fails, so a single root that will not extract does not cost the rest of its batch. A batch of 10 with one such root costs at most 19 queries. Each half is asked for only once the one before it has been read, so a split adds no load of its own. When not one root of the batch answers, the endpoint fails this query whatever the roots, and the read fails rather than coming out empty. A read without bindings has nothing to split, and fails.

When querying endpoints that return line-oriented formats like N-Triples (e.g. QLever), enable `lineBuffer` to work around an [N3.js chunk-splitting bug](https://github.com/rdfjs/N3.js/issues/578) that causes intermittent parse errors on large responses:

```typescript
const reader = new SparqlConstructReader({
  query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
  lineBuffer: true,
});
```

SPARQL CONSTRUCT queries can produce duplicate triples – for example, constant triples (like `$this a edm:ProvidedCHO`) are emitted for every solution row. Enable `deduplicate` to remove duplicates inline on the stream using a string-based identity set (inspired by [Comunica's `distinctConstruct`](https://comunica.dev/docs/query/advanced/context/#14--distinct-construct)):

```typescript
const reader = new SparqlConstructReader({
  query: 'CONSTRUCT { ?s a edm:ProvidedCHO . ?s ?p ?o } WHERE { ?s ?p ?o }',
  deduplicate: true,
});
```

This happens in the client: the endpoint still computes and sends every duplicate, and they still count towards a `LIMIT` in the query. The dedup set is scoped to each `read()` call, so memory stays bounded to the number of unique quads per batch, and duplicates across batches or readers remain. A standalone `deduplicateQuads()` function is also exported for use outside the reader.

Logic that is hard to express in pure SPARQL – cleaning up messy date notations, converting locale-specific dates to ISO 8601 – can be attached to a reader as a **quad transform**, a plain function that post-processes the reader’s output. See the how-to guide [Extend a stage with a quad transform](../guide/extend-a-stage-with-a-quad-transform).

### Dataset bindings

Beyond `?dataset`, a reader or `SparqlItemSelector` can reach a handful of DCAT properties from the `Dataset` in hand, under reserved variable names. Don't reuse these for an unrelated query variable.

| Variable                | From                                         | Multi-valued?                |
| ----------------------- | -------------------------------------------- | ---------------------------- |
| `?dataset`              | `dataset.iri`                                | No                           |
| `?datasetPublisher`     | `dataset.publisher.iri`                      | No                           |
| `?datasetPublisherName` | `dataset.publisher.name` (language → string) | Yes, one row per translation |
| `?datasetLicense`       | `dataset.license`                            | No                           |
| `?datasetLanguage`      | `dataset.language` (IRIs)                    | Yes, one row per language    |

A property absent for a given dataset (no `publisher`, no `license`) leaves its variable unbound rather than `UNDEF`.

As in DCAT-AP, `?datasetLanguage` is an IRI, such as `<http://publications.europa.eu/resource/authority/language/NLD>`, not a language tag, so compare it with `dct:language` values, not with `LANG()`. A language that isn't an IRI, such as `nl`, is bound as a relative IRI and won't match DCAT-AP data.

Use these like any other variable: the pipeline binds the ones your query references, and a query that references none runs unchanged. A variable your query assigns itself, with `BIND`, `VALUES` or `AS`, keeps the query's value. A variable the item selector also binds keeps the item's value. Bindings don't reach inside a sub-SELECT, so a variable used only there stays unbound.

A multi-valued variable takes each of its values:

- Used only in the `CONSTRUCT` template, each value produces its own triple, independently of other multi-valued variables. To get every combination of two of them, use both in one template triple.
- Used anywhere else, such as in a pattern, `FILTER` or `BIND`, the query runs for every combination of its values with those of other multi-valued variables it references.

Either way, the query's other triples repeat once per value. Enable [`deduplicate`](#reader) if that matters. In a selector, a multi-valued variable repeats the selected items, so use `SELECT DISTINCT`.

For a value this library can't know implement `DatasetBindingsProvider` and pass it to `Stage`:

```typescript
const bindingsProvider: DatasetBindingsProvider = {
  bindings(dataset) {
    return [{ type: namedNode(lookupLocalType(dataset)) }];
  },
};

new Stage({
  name: 'enrich',
  readers: reader,
  bindingsProvider,
});
```

A provider's rows go to every reader and, when configured, the item selector. They follow the same rules, with several rows acting as one multi-valued variable. Values that must appear in one solution together, such as a language and a name in that language, belong in the same row. A variable the rows bind replaces the predefined binding of that name. It may return a `Promise`.

The pipeline calls `bindings()` once per stage for each dataset, so a provider shared by several stages should cache expensive lookups itself, such as reading a file or calling a service.

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

Transitions are reported as `timeoutTightened` / `timeoutRelaxed` events; `ConsoleReporter` prints them as `↘ Tightened` / `↗ Relaxed` lines so operators can tell a fast-failed stage from an unexpected speedup.

Implement `TimeoutPolicy` directly for custom strategies (closing over shared state in the factory if you want it to span datasets).

Timeouts live at the pipeline level – neither `SparqlConstructReader` nor `SparqlItemSelector` accept their own `timeout` option. Per-endpoint state belongs in the adaptive policy, and per-stage budgets aren’t supported. Reusable stage facades ([@lde/pipeline-void](./pipeline-void), [@lde/pipeline-shacl-sampler](./pipeline-shacl-sampler)) follow the same convention.

### Validation

Stages can optionally validate their output quads against a `Validator`. The unit of validation depends on the stage: with an item selector, validation operates on the **combined output of all readers per batch** – each batch is a self-contained cluster of linked resources that can be meaningfully matched against SHACL shapes. Without an item selector, the stage’s **entire output** is buffered and validated as one unit, so memory grows with the stage’s whole output – keep validated selector-less stages small, or give the stage an item selector. Quads are buffered, validated, and then written or discarded based on the `onInvalid` policy (`'write'`, `'skip'` or `'halt'`); when no validator is configured, quads stream directly with zero overhead.

`Validator` is an interface, so you can implement your own validation strategy; [@lde/pipeline-shacl-validator](./pipeline-shacl-validator) is the SHACL implementation. See the how-to guide [Validate pipeline output with SHACL](../guide/validate-pipeline-output) for configuration, failure policies and per-dataset reporting.

### Writer

Writes generated quads to a destination. A `Writer` is transactional: each pipeline run opens one run on it (`openRun(context)`), writes every dataset through the resulting `RunWriter`, and ends with exactly one `commit()` or `abort(error)`. A run commits when it processed a selection; it aborts on failure **and on an [empty selection](#empty-selections)**, so `abort` means “this run’s output must not be applied”, not necessarily “this run failed”. A writer that alerts or exits non-zero on `abort` should distinguish the two by the error it receives (`EmptySelection`). The run lifecycle is the home of destination-level concerns such as atomic swaps, deletion sweeps and cross-pod locks; the pipeline drives `openRun → write* → commit/abort` uniformly and never branches on the writer’s update mode. After a dataset’s stages complete, its `flush(dataset, outcome)` says whether the dataset succeeded, so a writer can gate destructive finalization (e.g. an In-place stale-document sweep) on `'success'`.

A `RunWriter` may also implement the optional `reset(dataset)`, which discards a dataset’s already-written output. The pipeline invokes it before re-running all stages against a fallback dump ([reactive fallback](#distribution-resolver)); a custom writer without `reset` appends the re-run’s output to the endpoint-sourced partial output instead of replacing it.

The other optional method, `abandon(error)`, is the half-way house between `commit` and `abort`: **finalize, release run-level resources, keep what you built**. The pipeline never calls it – it exists for a caller coordinating several writers whose outputs reference one another, where one has already gone live pointing at what another built, so dropping that half-built output would break the live one ([`@lde/search-pipeline`](./search-pipeline#per-component-isolation) is the case it was added for). It falls back to `abort`, which is already correct for every writer whose abort does not discard built state; a writer whose abort _does_ discard should implement it, or such a caller has to choose between leaking its lock and breaking a live destination.

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

The `RunContext` handed to `openRun` carries the run’s identity (`runId`, `startedAt`), the full selection (`selectedSources()`, complete by commit time – including datasets skipped as unchanged), `itemsRejected(dataset, rejection)` to report items the writer left out, and the pipeline’s provenance store, when configured. Outside a pipeline, drive the same lifecycle yourself:

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

The pipeline reports everything it does as `PipelineEvent`s: plain objects of a discriminated union, each carrying a `type`, a severity `defaultLevel` (`debug`, `info`, `warn` or `error`), a `timestamp`, the `runId` shared by every event of a run, and its own payload. A reporter is any object with an `onEvent` method:

```typescript
interface Reporter {
  onEvent(event: PipelineEvent): void;
}
```

Pass a single reporter, or an array to have several observe the same run – for example a console reporter for a terminal alongside a structured log file:

```typescript
import { Pipeline } from '@lde/pipeline';
import { ConsoleReporter } from '@lde/pipeline-console-reporter';
import { LoggerReporter } from '@lde/pipeline-logger-reporter';

new Pipeline({
  // …
  reporter: [
    new ConsoleReporter(),
    new LoggerReporter(logger), // your application’s structured logger
  ],
});
```

Each reporter receives every event, synchronously and in array order, and decides itself what to do with `defaultLevel`. A reporter cannot break a run: if one throws, the others still get the event, the run carries on, and the error is emitted as a `ReporterWarning` process warning. See the how-to guide [Observe a run with a reporter](../guide/observe-a-run-with-a-reporter).

Two reporters ship as their own packages: [@lde/pipeline-console-reporter](./pipeline-console-reporter) for a terminal and [@lde/pipeline-logger-reporter](./pipeline-logger-reporter) for a structured logger of your choice.

#### Levels

The `defaultLevel` is the pipeline’s default, decided in one place (`levelOf`), not a verdict: a reporter that wants a skipped dataset to page someone can remap on `type` and the payload. Skip reasons are `{ code, message }` objects and failures carry `Error` values, so a reporter never matches on message strings. The library has no `fatal`: it never ends the process, and an unrecoverable failure rejects `run()`.

#### Events

In rough lifecycle order. Every event below the first four belongs to one dataset: it extends `DatasetEventEnvelope`, so it always carries that `dataset` and a reporter can find it with `'dataset' in event`. Stage events also carry the `stage` name.

| `type`                  | Level                                     | Payload                                                                                                                                    | Reported                                                                                                                                                |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipelineStart`         | `info`                                    | `name`                                                                                                                                     | Once, when the run starts.                                                                                                                              |
| `datasetsSelected`      | `info`                                    | `count`, `durationMs`                                                                                                                      | After the dataset selector returns.                                                                                                                     |
| `selectionEmpty`        | `warn`                                    | `message`                                                                                                                                  | When the run is abandoned because the selection was empty – no commit, destination unchanged (see [Empty selections](#empty-selections)).               |
| `pipelineComplete`      | `info`                                    | `durationMs`, `memoryUsageBytes`, `heapUsedBytes`                                                                                          | Once, when the run ends.                                                                                                                                |
| `datasetStart`          | `info`                                    | –                                                                                                                                          | When a dataset’s processing begins.                                                                                                                     |
| `distributionProbed`    | `debug`                                   | `distribution`, `result` (a `DistributionAnalysisResult`)                                                                                  | Each time a single distribution probe completes.                                                                                                        |
| `distributionValidated` | `info` when valid, else `warn`            | `distribution`, `verdict`                                                                                                                  | With the RDF-validity verdict for each distribution the pipeline attempted – even when the dataset is otherwise skipped.                                |
| `importStarted`         | `debug`                                   | –                                                                                                                                          | When a data-dump import begins.                                                                                                                         |
| `importFailed`          | `warn`                                    | `distribution`, `error`                                                                                                                    | When importing a distribution fails.                                                                                                                    |
| `distributionSelected`  | `info`                                    | `distribution`, `imported?` (`{ from, durationMs, tripleCount?, engine? }`)                                                                | When a dataset’s source is resolved; `imported` is set when it was imported from a dump.                                                                |
| `stageStart`            | `debug`                                   | `stage`                                                                                                                                    | When a stage begins.                                                                                                                                    |
| `stageProgress`         | `debug`                                   | `stage`, `itemsProcessed`, `quadsGenerated`, `memoryUsageBytes`, `heapUsedBytes`                                                           | After each batch a stage processes.                                                                                                                     |
| `stageComplete`         | `info`                                    | `stage`, `itemsProcessed`, `quadsGenerated`, `durationMs`, `phases`, `counts` (see [Stage phases and counts](#stage-phases-and-counts))    | When a stage finishes successfully.                                                                                                                     |
| `stageSkipped`          | `info` for `noItemsSelected`, else `warn` | `stage`, `reason` (code `noItemsSelected` or `notSupported`)                                                                               | When a stage is [skipped](#skipped-stages): `noItemsSelected` for an empty selector, `notSupported` otherwise.                                          |
| `rootSkipped`           | `warn`                                    | `stage`, `root` (the selector’s bindings for it), `error`                                                                                  | When a reader [leaves a root out](#when-the-endpoint-fails) because the endpoint answered HTTP 500 to a query for that root alone.                      |
| `stageFailed`           | `error`                                   | `stage`, `error`                                                                                                                           | When a stage hard-fails, or a per-dataset `write`, `provenance` or `reactive-dump-fallback` step fails; the run continues.                              |
| `datasetValidated`      | `info` when conforming, else `warn`       | `report`                                                                                                                                   | Once per (dataset, validator) pair after all stages, even when nothing was validated – read `quadsValidated` to distinguish ‘not tested’.               |
| `datasetSkipped`        | `info` for `unchanged`, else `warn`       | `reason` (code `unchanged`, `probeFailed`, `resolveFailed` or `noDistributionAvailable`), `error?` (for `probeFailed` and `resolveFailed`) | When a dataset is skipped without running its stages.                                                                                                   |
| `itemsRejected`         | `warn`                                    | `rejection` (`{ target, written, rejected, reasons }`)                                                                                     | When a writer finalizes a dataset it left items out of; `reasons` counts each reason, with a few example ids.                                           |
| `valuesUnread`          | `warn`                                    | `unread` (`{ target, field, unread, examples }`)                                                                                           | Once per field a `project` [could not read values for](#projecting-batches-with-project), just before `datasetComplete`; not for a dataset that failed. |
| `datasetComplete`       | `info`                                    | `durationMs`, `memoryUsageBytes`, `heapUsedBytes`                                                                                          | When a dataset’s processing ends.                                                                                                                       |
| `timeoutTightened`      | `warn`                                    | `endpoint`, `fromTimeoutMs`, `toTimeoutMs`, `consecutiveTimeouts`                                                                          | When a [timeout policy](#timeout-policies) tightens an endpoint’s budget after consecutive timeouts.                                                    |
| `timeoutRelaxed`        | `info`                                    | `endpoint`, `fromTimeoutMs`, `toTimeoutMs`, `consecutiveTimeouts`                                                                          | When a timeout policy relaxes a previously-tightened endpoint back to the default budget.                                                               |

#### Stage phases and counts

A stage’s `durationMs` says how long it took, `phases` where that time went, in milliseconds:

| Phase        | Time spent                                                                     |
| ------------ | ------------------------------------------------------------------------------ |
| `selectMs`   | Selecting the stage’s items, page by page.                                     |
| `readMs`     | Running the readers’ queries and reading their results.                        |
| `transforms` | In each transform attached to a [reader](#reader), as `{ name, durationMs }`.  |
| `validateMs` | Validating the readers’ quads.                                                 |
| `projectMs`  | Turning batches into items with [`project`](#projecting-batches-with-project). |
| `writeMs`    | The writer’s own work, not counting the time it waited for items.              |

A stage runs up to `maxConcurrency` batches at once, so each phase is added up over all of them, and together the phases can exceed `durationMs`. A phase that does is the one the batches were waiting on. Each phase counts only its own time: a transform waiting on the reader it pulls from adds to `readMs`, not to its own entry. A transform is named after its function, or `transform N` when the function has none.

A transform or `project` can count things through its context’s `count(name, amount = 1)` – images fetched, terms served from a store. The stage adds up each name and reports the totals as `counts`, `{ name: total }`; [`@lde/resolver`](./resolver#counting-a-run) counts into it when handed `context.count`.

The console reporter appends both to a stage’s line:

```
✔ Stage CreativeWork 729 items, 729 quads, took 24m 3s (busy: read 1m 40s, anyUriToIri 2s, enrich 41m 12s, project 3s, write 5s) (manifests fetched 249, manifests from store 480)
```

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
