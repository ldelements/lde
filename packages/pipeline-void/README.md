# Pipeline VoID

Extensions to [@lde/pipeline](../pipeline) for VoID (Vocabulary of Interlinked Datasets) statistical analysis of RDF datasets.

## Stage factories

### `voidStages(options?)`

Returns all VoID stages in their recommended execution order. The ordering is optimised for cache warming: `classPartitions()` runs before the per-class stages, so the `?s a ?class` pattern is already cached on the SPARQL endpoint when the heavier per-class queries execute — preventing 504 timeouts on cold caches.

Accepts an optional `VoidStagesOptions` object:

| Option           | Default | Description                                                                      |
| ---------------- | ------- | -------------------------------------------------------------------------------- |
| `timeout`        | 60 000  | SPARQL query timeout in milliseconds                                             |
| `batchSize`      | 10      | Maximum class bindings per executor call (per-class stages only)                 |
| `maxConcurrency` | 10      | Maximum concurrent in-flight executor batches (per-class stages only)            |
| `perClass`       | —       | Override per-class iteration for all five per-class stages                       |
| `uriSpaces`      | —       | When provided, includes the object URI space stage                               |
| `vocabularies`   | —       | Additional vocabulary namespace URIs to detect beyond the built-in defaults      |
| `decorators`     | —       | Per-stage executor decorators, keyed by `VoidStageName` (use `VOID_STAGE_NAMES`) |

```typescript
import { voidStages } from '@lde/pipeline-void';
import { Pipeline, SparqlUpdateWriter, provenancePlugin } from '@lde/pipeline';

const stages = await voidStages({ uriSpaces: uriSpaceMap });

await new Pipeline({
  datasetSelector: selector,
  stages,
  plugins: [provenancePlugin()],
  writers: new SparqlUpdateWriter({
    endpoint: new URL('http://localhost:7200/repositories/lde/statements'),
  }),
}).run();
```

### Individual stage factories

Global and domain-specific factories accept `VoidStageOptions` (`timeout`) and return `Promise<Stage>`. Per-class factories accept `PerClassVoidStageOptions` (`timeout`, `batchSize`, `maxConcurrency`, `perClass`) — they default `perClass` to `true`; set it to `false` to run them as monolithic queries instead.

Every factory additionally accepts `DecoratableStageOptions` with an optional `decorate?: ExecutorDecorator`, letting a single stage be decorated in isolation. The factory always builds its own default executor (including any built-in decorator such as `UriSpaceExecutor` or `VocabularyExecutor`); `decorate` wraps that from the outside, so it composes over the built-in behaviour rather than replacing it. The `voidStages()` bundle exposes the same capability per stage through its `decorators` map.

#### Global stages (one CONSTRUCT query per dataset):

| Factory                 | Query                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| `classPartitions()`     | [`class-partition.rq`](queries/class-partition.rq) — Classes with entity counts |
| `countDatatypes()`      | [`datatypes.rq`](queries/datatypes.rq) — Dataset-level datatypes                |
| `countObjectLiterals()` | [`object-literals.rq`](queries/object-literals.rq) — Literal object counts      |
| `countObjectUris()`     | [`object-uris.rq`](queries/object-uris.rq) — URI object counts                  |
| `countProperties()`     | [`properties.rq`](queries/properties.rq) — Distinct properties                  |
| `countSubjects()`       | [`subjects.rq`](queries/subjects.rq) — Distinct subjects                        |
| `countTriples()`        | [`triples.rq`](queries/triples.rq) — Total triple count                         |
| `detectLicenses()`      | [`licenses.rq`](queries/licenses.rq) — License detection                        |
| `subjectUriSpaces()`    | [`subject-uri-space.rq`](queries/subject-uri-space.rq) — Subject URI namespaces |

#### Per-class stages (iterated with a class selector):

| Factory                   | Query                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `classPropertySubjects()` | [`class-properties-subjects.rq`](queries/class-properties-subjects.rq) — Properties per class (subject counts)     |
| `classPropertyObjects()`  | [`class-properties-objects.rq`](queries/class-properties-objects.rq) — Properties per class (object counts)        |
| `perClassDatatypes()`     | [`class-property-datatypes.rq`](queries/class-property-datatypes.rq) — Per-class datatype partitions               |
| `perClassLanguages()`     | [`class-property-languages.rq`](queries/class-property-languages.rq) — Per-class language tags                     |
| `perClassObjectClasses()` | [`class-property-object-classes.rq`](queries/class-property-object-classes.rq) — Per-class object class partitions |

#### Domain-specific stages:

| Factory                  | Description                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detectVocabularies()`   | [`entity-properties.rq`](queries/entity-properties.rq) — Entity properties with automatic `void:vocabulary` detection. Accepts `DetectVocabulariesOptions` with an optional `vocabularies` array to extend the built-in defaults. |
| `uriSpaces(uriSpaceMap)` | [`object-uri-space.rq`](queries/object-uri-space.rq) — Object URI namespace linksets, aggregated against a provided URI space map                                                                                                 |

## Executor decorators

- `VocabularyExecutor` — Wraps an executor; detects known vocabulary namespace prefixes in `void:property` quads and appends `void:vocabulary` triples. The built-in defaults are exported as `defaultVocabularies` (sourced from `@zazuko/prefixes`).
- `UriSpaceExecutor` — Wraps an executor; consumes `void:Linkset` quads, matches each `void:objectsTarget` against configured URI space prefixes using `startsWith`, and aggregates triple counts per matched space. Emits `void:objectsTarget` pointing to the target dataset IRI (taken from the metadata quad subjects), not the raw prefix. Unmatched linksets are discarded.

Both are plain `ExecutorDecorator`s. To attach your own — for example to harvest a stage's output and append extra measurements — pass a decorator via a factory's `decorate` option or the `voidStages()` `decorators` map. The decorator receives the stage's executor as its `inner` and returns a replacement; the stage's `execute()` call gives it the dataset endpoint, so it can fire its own follow-up queries. See [`composeDecorators`](../pipeline) in `@lde/pipeline` for the composition order.
