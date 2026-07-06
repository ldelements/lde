# Pipeline

A framework for transforming large RDF datasets, primarily using [SPARQL](https://www.w3.org/TR/sparql11-query/) queries with TypeScript for the parts that are hard to express in SPARQL alone.

- **SPARQL-native.** Data transformations are plain SPARQL query files — portable, transparent, testable and version-controlled.
- **Composable.** Executors are an interface: wrap a SPARQL reader with custom TypeScript to handle edge cases like date parsing or string normalisation (see [Reader](#reader)).
- **Extensible.** A plugin system lets packages like [@lde/pipeline-void](../pipeline-void) (or your own plugins) hook into the pipeline lifecycle.

## Components

A **Pipeline** consists of:

- a **Dataset Selector** that selects which datasets to process
- a **Distribution Resolver** that resolves each dataset to a usable SPARQL endpoint
- one or more **Stages**, each consisting of:
  - an optional **Item Selector** that selects resources (as variable bindings) for fan-out
  - one or more **Executors** that generate triples

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

- `'sparql'` (default) — use the dataset’s own SPARQL endpoint when one is available; import a data dump only when no endpoint responds.
- `'sparqlWithImportFallback'` — like `'sparql'`, but also fall back to the data dump when the endpoint passes probing yet a stage fails against it at runtime. The pipeline discards the endpoint-sourced partial output and re-runs all stages against the import. Use this when endpoints are present but unreliable for heavy aggregate queries.
- `'import'` — always import the data dump, even when a working endpoint is advertised.

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

`maxConcurrency` (default: 10) limits the total number of concurrent SPARQL queries. Within each batch, all readers run in parallel; the number of concurrent batches is automatically reduced to `⌊maxConcurrency / executorCount⌋` so the total query pressure stays within the limit. For example, with `maxConcurrency: 10` and two readers per stage, up to 5 batches run concurrently (10 SPARQL queries total).

#### Expecting output

`expectsOutput` (default: `false`) marks a stage whose query must yield at least one quad. A supported stage that produces none is then treated as a hard failure rather than a legitimately empty result.

Set it for scalar aggregates such as `SELECT (COUNT(*) AS ?n)`, which always return exactly one row — so zero output can only mean the endpoint truncated or aborted the response (e.g. a timeout surfaced as an empty `HTTP 200`). The failure flows through like any other hard stage failure, triggering the [reactive dump fallback](#distribution-resolver) when `strategy: 'sparqlWithImportFallback'` is configured. Leave it `false` for stages that may legitimately be empty, such as class or property partitions of a dataset that lacks that structure.

### Item Selector

Selects resources from the distribution and fans out reader calls per batch of results. Implements the `ItemSelector` interface:

```typescript
interface ItemSelector {
  select(
    distribution: Distribution,
    batchSize?: number,
  ): AsyncIterable<VariableBindings>;
}
```

The distribution is received at run time, so selectors don't need the endpoint URL at construction time. The `batchSize` parameter is set by the stage. Use `SparqlItemSelector` for SPARQL-based selection with automatic pagination:

```typescript
new SparqlItemSelector({
  query: 'SELECT DISTINCT ?class WHERE { ?s a ?class }',
});
```

#### Capping total results with `maxResults`

By default, `SparqlItemSelector` paginates through **all** matching rows: any `LIMIT` clause in the query is interpreted as the page size, then it walks pages with `OFFSET` until the source is exhausted. To cap the total bindings yielded across all pages — for sampling, testing, prototyping, or just safety — set `maxResults`:

```typescript
new SparqlItemSelector({
  query: 'SELECT DISTINCT ?s WHERE { ?s a <http://example.com/Class> }',
  maxResults: 50,
});
```

When `maxResults` is set:

- Pagination stops as soon as `maxResults` bindings have been yielded — no wasted page request after the cap is hit.
- The last (partial) page's `LIMIT` is shrunk to the remaining cap so the endpoint doesn't over-fetch on the remainder (e.g. with `maxResults: 85` and `pageSize: 10`, the 9th page request is `LIMIT 5`, not `LIMIT 10`).
- The first page uses the configured page size as-is; `maxResults` and page size stay orthogonal. If `maxResults < pageSize`, the first page may return a few rows that aren't yielded.
- `maxResults: 0` is a valid no-op; the selector yields nothing without issuing any SPARQL request.
- `maxResults` is independent of any `LIMIT` clause in the query, which still controls page size when the cap is larger than one page.

For dynamic queries that depend on the distribution, implement `ItemSelector` directly:

```typescript
const itemSelector: ItemSelector = {
  select: (distribution, batchSize) => {
    const query = buildQuery(distribution);
    return new SparqlItemSelector({ query }).select(distribution, batchSize);
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

When querying endpoints that return line-oriented formats like N-Triples (e.g. QLever), enable `lineBuffer` to work around an [N3.js chunk-splitting bug](https://github.com/rdfjs/N3.js/issues/578) that causes intermittent parse errors on large responses:

```typescript
const reader = new SparqlConstructReader({
  query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
  lineBuffer: true,
});
```

SPARQL CONSTRUCT queries can produce duplicate triples — for example, constant triples (like `?dataset a edm:ProvidedCHO`) are emitted for every solution row. Enable `deduplicate` to remove duplicates inline on the stream using a string-based identity set (inspired by [Comunica's `distinctConstruct`](https://comunica.dev/docs/query/advanced/context/#14--distinct-construct)):

```typescript
const reader = new SparqlConstructReader({
  query: 'CONSTRUCT { ?s a edm:ProvidedCHO . ?s ?p ?o } WHERE { ?s ?p ?o }',
  deduplicate: true,
});
```

The dedup set is scoped to each `read()` call, so memory stays bounded to the number of unique quads per batch. A standalone `deduplicateQuads()` function is also exported for use outside the reader.

### Extending a stage with a quad transform

Some logic is hard to express in pure SPARQL — cleaning up messy date notations, converting locale-specific dates to ISO 8601, or sampling a reader’s output and firing follow-up queries. Rather than subclass `Reader`, attach a `QuadTransform` to it as data: a plain function `(quads, context) => quads` that post-processes one reader’s output before the stage merges it with its siblings. This is extension point 1 of [ADR 2](../../docs/decisions/0002-unify-pipeline-extension-on-quad-transforms.md).

A transform receives an `ReaderContext` — the `dataset`, the `distribution` (so it can fire its own SPARQL queries), and the `stage` name. It runs once per reader call, so **write it to accept being called more than once**: a global stage calls it once over the reader’s complete output, but a per-class stage with batching enabled calls it once per batch (one class at `batchSize: 1`). Accumulate within an invocation, not across invocations — or keep the transform per-quad, where the number of calls makes no difference.

```typescript
import { DataFactory } from 'n3';
import {
  Stage,
  SparqlConstructReader,
  type QuadTransform,
  type ReaderContext,
} from '@lde/pipeline';

const cleanDates: QuadTransform<ReaderContext> = async function* (quads) {
  for await (const quad of quads) {
    if (quad.object.termType === 'Literal' && isMessyDate(quad.object)) {
      yield DataFactory.quad(
        quad.subject,
        quad.predicate,
        DataFactory.literal(
          parseDutchDate(quad.object.value),
          DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#date'),
        ),
      );
    } else {
      yield quad;
    }
  }
};

new Stage({
  name: 'dates',
  readers: {
    reader: await SparqlConstructReader.fromFile('dates.rq'),
    transform: cleanDates,
  },
});
```

`transform` accepts a single transform or an array applied in order, so a stage can compose several. This keeps SPARQL doing the heavy lifting while TypeScript handles the edge cases. See [@lde/pipeline-void](../pipeline-void)'s `withVocabularies` for a real-world example of this pattern.

#### Adaptive timeouts

By default, every SPARQL request uses the same 5-minute budget. When a pipeline runs against many third-party endpoints, that fixed budget can cost ~80 minutes on a single dataset whose endpoint times out repeatedly on heavy queries — light stages on the same endpoint then sit behind the heavy ones that will never succeed.

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

Timeouts live at the pipeline level — neither `SparqlConstructReader` nor `SparqlItemSelector` accept their own `timeout` option. Per-endpoint state belongs in the adaptive policy, and per-stage budgets aren’t supported. Reusable stage facades (`@lde/pipeline-void`, `@lde/pipeline-shacl-sampler`) follow the same convention.

### Validation

Stages can optionally validate their output quads against a `Validator`. Validation operates on the **combined output of all readers per batch**, not on individual quads or per-reader output. A batch produces a complete result set — a self-contained cluster of linked resources — that can be meaningfully matched against SHACL shapes. Even with a single reader, each batch is a complete unit; with multiple readers, shapes that reference triples from different readers are validated correctly.

Validating individual quads would be meaningless, since a single quad carries no structural context for shape matching. Validating the full pipeline output would also be problematic: because the pipeline streams results in batches, it doesn’t know where resource cluster boundaries fall. Batching the output could split a valid cluster across two batches, causing partial resources to fail validation even though the complete cluster is valid.

Quads are buffered, validated, and then written or discarded based on the `onInvalid` policy. When no validator is configured, quads stream directly with zero overhead.

```typescript
import { ShaclValidator } from '@lde/pipeline-shacl-validator';
import { FileWriter } from '@lde/pipeline';

new Stage({
  name: 'transform',
  readers: await SparqlConstructReader.fromFile('transform.rq'),
  validation: {
    validator: new ShaclValidator({
      shapesFile: './shapes.ttl',
      reportWriters: [
        new FileWriter({ outputDir: './validation', format: 'turtle' }),
      ],
    }),
    onInvalid: 'write', // 'write' (default) | 'skip' | 'halt'
  },
});
```

| `onInvalid` | Behaviour                                          |
| ----------- | -------------------------------------------------- |
| `'write'`   | Write quads even if validation fails **(default)** |
| `'skip'`    | Discard the batch silently                         |
| `'halt'`    | Throw an error, stopping the pipeline              |

`Validator` is an interface, so you can implement your own validation strategy. See [@lde/pipeline-shacl-validator](../pipeline-shacl-validator) for the SHACL implementation.

#### Per-dataset reporting

After all stages for a dataset have run, the pipeline calls `validator.report(dataset)` once for each distinct validator attached to any stage and emits a `datasetValidated(dataset, report)` event on the reporter. The call happens **regardless of whether any stage actually invoked `validate()`** — for SHACL that means a dataset whose stages produced no input typically reports `quadsValidated: 0` and `conforms: true` (the SHACL vacuous-truth default). Consumers that want to distinguish ‘not tested’ from ‘tested and passed’ can read `quadsValidated`.

### Writer

Writes generated quads to a destination:

- `SparqlUpdateWriter` — writes to a SPARQL endpoint via UPDATE queries
- `FileWriter` — writes to local files

### Reporter

A `ProgressReporter` observes the run, receiving lifecycle events such as `pipelineStart`, `stageComplete`, `datasetValidated` and `pipelineComplete`. Every method is optional, so a reporter implements only the events it cares about.

Pass a single reporter, or an array to have several observe the same run — for example a console reporter alongside one that collects validation verdicts:

```typescript
new Pipeline({
  // …
  reporter: [new ConsoleReporter(), verdictCollector],
});
```

Each reporter receives every event, in array order; a reporter that does not implement a given event is skipped for it.

### Provenance store

A `ProvenanceStore` gives the pipeline a small per-dataset memory, so a future run can skip datasets that are genuinely unchanged. It is purely a storage seam: the framework owns the skip decision (see [`sourceFingerprint`](#source-change-fingerprint) and `shouldReprocess`), the store owns only how each record is persisted.

```typescript
interface ProvenanceStore {
  get(datasetUri: URL): Promise<ProcessingRecord | null>;
  set(datasetUri: URL, record: ProcessingRecord): Promise<void>;
}
```

A `ProcessingRecord` holds the two opaque change fields — `sourceFingerprint` (derived automatically from source metadata) and `pipelineVersion` (consumer-declared) — plus `generatedAt` and a `status` of `'success'` or `'failed'`. The two change fields are compared only for equality, never parsed or ordered.

#### `FileLoadedSparqlProvenanceStore`

The reference implementation targets a triplestore that is served read-only and rebuilt by bulk-loading files (e.g. [QLever](https://github.com/ad-freiburg/qlever)). It reads through SPARQL queries against the live endpoint, and writes records as files for the next bulk-load — because the endpoint accepts no SPARQL UPDATE.

```typescript
import { FileLoadedSparqlProvenanceStore } from '@lde/pipeline';

const store = new FileLoadedSparqlProvenanceStore({
  queryEndpoint: new URL('http://localhost:7001/sparql'),
  pipelineIri: new URL('https://example.org/pipelines/dkg'),
  outputDir: './provenance',
});
```

- `get` runs a named-graph-scoped SPARQL `SELECT` against `queryEndpoint`, reading the records a previous run loaded.
- `set` writes one flat [PROV-O](https://www.w3.org/TR/prov-o/) N-Quads file per dataset into `outputDir`, in the pipeline-scoped named graph, to be bulk-loaded after the run.

Each record is stored as flat PROV-O on the dataset entity — `prov:generatedAtTime` plus `sourceFingerprint`, `pipelineVersion` and `status` under the `https://w3id.org/lde/provenance#` namespace. Scoping every record by `pipelineIri` (used as the named graph) lets multiple pipelines share one triplestore without colliding.

#### Enabling skipping

Skipping is opt-in. Pass a `provenanceStore` and a `pipelineVersion` to the `Pipeline`:

```typescript
new Pipeline({
  // …
  provenanceStore: store,
  pipelineVersion: 'v3', // rotate only on releases that change output
});
```

For each dataset the pipeline probes its distributions, derives the source-change fingerprint, reads the stored record, and **skips before importing** when both change fields match:

```
skip iff  recorded.sourceFingerprint === current.sourceFingerprint
     AND  recorded.pipelineVersion   === current.pipelineVersion
```

Otherwise it imports (if needed), runs the stages, and writes an updated record. `pipelineVersion` is consumer-owned and opaque: rotate it only on releases that change output, and every dataset reprocesses on the next run. It is **required** when a `provenanceStore` is configured (a skip-enabled pipeline with no version would silently freeze); when no store is configured, every dataset is reprocessed — today’s behaviour. A dataset that failed but whose source is unchanged is recorded as `'failed'` and skipped on later runs until its source changes or the version rotates, so a deterministically failing import is not retried every run.

### Source-change fingerprint

`sourceFingerprint(distribution, probeResult)` derives a cheap, opaque change signal for a distribution from metadata the probe already collected — no body download. For a data dump it combines the most recent of the register’s `dct:modified` and the artifact’s HTTP `Last-Modified` with the byte size (the probe’s `Content-Length`, falling back to the declared `dcat:byteSize`). It returns `null` for a live SPARQL endpoint, or when no date and no size can be established — a `null` fingerprint never compares equal, so such a distribution is always reprocessed.

### Plugins

Plugins hook into the pipeline lifecycle via the `PipelinePlugin` interface. Register them in the `plugins` array when constructing a `Pipeline`.

#### `namespaceNormalizationPlugin(options)`

Generic plugin that rewrites namespace prefixes in `void:class` and `void:property` quad objects. Accepts `from` and `to` options specifying the source and target namespace URI prefixes. `void:vocabulary` quads are left unchanged so consumers can see which namespace the source dataset actually uses.

```typescript
import { namespaceNormalizationPlugin } from ‘@lde/pipeline’;

new Pipeline({
  // ...
  plugins: [
    namespaceNormalizationPlugin({
      from: ‘http://example.org/’,
      to: ‘https://example.org/’,
    }),
  ],
});
```

#### `provenancePlugin()`

Appends [PROV-O](https://www.w3.org/TR/prov-o/) provenance quads (`prov:Entity`, `prov:Activity`, `prov:startedAtTime`, `prov:endedAtTime`) to every stage’s output. The `prov:Activity` is a stable IRI keyed on `(dataset, stage)`, not a blank node, so activities stay distinct – and a re-run stays idempotent – when per-dataset outputs are merged into one graph (blank-node labels are not unique across separately serialised documents and would fuse unrelated activities).

#### `schemaOrgNormalizationPlugin(options?)`

Normalizes Schema.org namespace prefixes in `void:class` and `void:property` quad objects. By default, rewrites `http://schema.org/` to `https://schema.org/`. Pass `{ reverse: true }` to normalize in the opposite direction (`https://` to `http://`). `void:vocabulary` quads are left unchanged so consumers can see which namespace the source dataset actually uses.

This is a convenience wrapper around `namespaceNormalizationPlugin`.

```typescript
import { schemaOrgNormalizationPlugin, provenancePlugin } from ‘@lde/pipeline’;

new Pipeline({
  // ...
  plugins: [schemaOrgNormalizationPlugin(), provenancePlugin()],
});

// Or reverse: normalize https to http
new Pipeline({
  // ...
  plugins: [schemaOrgNormalizationPlugin({reverse: true})],
});
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
