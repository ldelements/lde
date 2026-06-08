# Pipeline

A framework for transforming large RDF datasets, primarily using [SPARQL](https://www.w3.org/TR/sparql11-query/) queries with TypeScript for the parts that are hard to express in SPARQL alone.

- **SPARQL-native.** Data transformations are plain SPARQL query files — portable, transparent, testable and version-controlled.
- **Composable.** Executors are an interface: wrap a SPARQL executor with custom TypeScript to handle edge cases like date parsing or string normalisation (see [Executor](#executor)).
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

### Stage

A stage groups an item selector, one or more executors, and configuration:

```typescript
new Stage({
  name: 'per-class',
  itemSelector: new SparqlItemSelector({
    query: 'SELECT DISTINCT ?class WHERE { ?s a ?class }',
  }),
  executors: executor,
  batchSize: 100,
  maxConcurrency: 5,
});
```

#### Batch size

`batchSize` (default: 10) controls how many variable bindings are passed to each executor call as a `VALUES` clause. It also sets the page size for the item selector's SPARQL requests, so that each paginated request fills exactly one executor batch.

Some SPARQL endpoints enforce different result limits for SELECT and CONSTRUCT queries. Since the selector uses SELECT and the executor uses CONSTRUCT, a `LIMIT` clause in the selector query overrides `batchSize` as the page size. Use this when the endpoint caps SELECT results below your desired batch size:

```typescript
// Endpoint caps SELECT results at 500, but each CONSTRUCT can handle 1000 bindings.
new Stage({
  name: 'per-class',
  itemSelector: new SparqlItemSelector({
    query: 'SELECT DISTINCT ?class WHERE { ?s a ?class } LIMIT 500',
  }),
  executors: executor,
  batchSize: 1000, // Two SELECT pages fill one CONSTRUCT batch.
});
```

#### Concurrency

`maxConcurrency` (default: 10) limits the total number of concurrent SPARQL queries. Within each batch, all executors run in parallel; the number of concurrent batches is automatically reduced to `⌊maxConcurrency / executorCount⌋` so the total query pressure stays within the limit. For example, with `maxConcurrency: 10` and two executors per stage, up to 5 batches run concurrently (10 SPARQL queries total).

### Item Selector

Selects resources from the distribution and fans out executor calls per batch of results. Implements the `ItemSelector` interface:

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

### Executor

Generates RDF triples. The built-in `SparqlConstructExecutor` runs a SPARQL CONSTRUCT query with template substitution and variable bindings:

```typescript
const executor = new SparqlConstructExecutor({
  query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
});
```

When querying endpoints that return line-oriented formats like N-Triples (e.g. QLever), enable `lineBuffer` to work around an [N3.js chunk-splitting bug](https://github.com/rdfjs/N3.js/issues/578) that causes intermittent parse errors on large responses:

```typescript
const executor = new SparqlConstructExecutor({
  query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
  lineBuffer: true,
});
```

SPARQL CONSTRUCT queries can produce duplicate triples — for example, constant triples (like `?dataset a edm:ProvidedCHO`) are emitted for every solution row. Enable `deduplicate` to remove duplicates inline on the stream using a string-based identity set (inspired by [Comunica's `distinctConstruct`](https://comunica.dev/docs/query/advanced/context/#14--distinct-construct)):

```typescript
const executor = new SparqlConstructExecutor({
  query: 'CONSTRUCT { ?s a edm:ProvidedCHO . ?s ?p ?o } WHERE { ?s ?p ?o }',
  deduplicate: true,
});
```

The dedup set is scoped to each `execute()` call, so memory stays bounded to the number of unique quads per batch. A standalone `deduplicateQuads()` function is also exported for use outside the executor.

### Extending a stage with a quad transform

Some logic is hard to express in pure SPARQL — cleaning up messy date notations, converting locale-specific dates to ISO 8601, or sampling an executor’s output and firing follow-up queries. Rather than subclass `Executor`, attach a `QuadTransform` to it as data: a plain function `(quads, context) => quads` that post-processes one executor’s output before the stage merges it with its siblings. This is extension point 1 of [ADR 2](../../docs/decisions/0002-unify-pipeline-extension-on-quad-transforms.md).

A transform receives an `ExecutorContext` — the `dataset`, the `distribution` (so it can fire its own SPARQL queries), and the `stage` name. It runs once per executor call, so **write it to accept being called more than once**: a global stage calls it once over the executor’s complete output, but a per-class stage with batching enabled calls it once per batch (one class at `batchSize: 1`). Accumulate within an invocation, not across invocations — or keep the transform per-quad, where the number of calls makes no difference.

```typescript
import { DataFactory } from 'n3';
import {
  Stage,
  SparqlConstructExecutor,
  type QuadTransform,
  type ExecutorContext,
} from '@lde/pipeline';

const cleanDates: QuadTransform<ExecutorContext> = async function* (quads) {
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
  executors: {
    executor: await SparqlConstructExecutor.fromFile('dates.rq'),
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

Timeouts live at the pipeline level — neither `SparqlConstructExecutor` nor `SparqlItemSelector` accept their own `timeout` option. Per-endpoint state belongs in the adaptive policy, and per-stage budgets aren’t supported. Reusable stage facades (`@lde/pipeline-void`, `@lde/pipeline-shacl-sampler`) follow the same convention.

### Validation

Stages can optionally validate their output quads against a `Validator`. Validation operates on the **combined output of all executors per batch**, not on individual quads or per-executor output. A batch produces a complete result set — a self-contained cluster of linked resources — that can be meaningfully matched against SHACL shapes. Even with a single executor, each batch is a complete unit; with multiple executors, shapes that reference triples from different executors are validated correctly.

Validating individual quads would be meaningless, since a single quad carries no structural context for shape matching. Validating the full pipeline output would also be problematic: because the pipeline streams results in batches, it doesn’t know where resource cluster boundaries fall. Batching the output could split a valid cluster across two batches, causing partial resources to fail validation even though the complete cluster is valid.

Quads are buffered, validated, and then written or discarded based on the `onInvalid` policy. When no validator is configured, quads stream directly with zero overhead.

```typescript
import { ShaclValidator } from '@lde/pipeline-shacl-validator';
import { FileWriter } from '@lde/pipeline';

new Stage({
  name: 'transform',
  executors: await SparqlConstructExecutor.fromFile('transform.rq'),
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

Appends [PROV-O](https://www.w3.org/TR/prov-o/) provenance quads (`prov:Entity`, `prov:Activity`, `prov:startedAtTime`, `prov:endedAtTime`) to every stage’s output.

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
  SparqlConstructExecutor,
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
      executors: new SparqlConstructExecutor({
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
