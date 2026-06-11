# Pipeline VoID

Extensions to [@lde/pipeline](../pipeline) for VoID (Vocabulary of Interlinked Datasets) statistical analysis of RDF datasets.

## Stage factories

### `voidStages(options?)`

Returns all VoID stages in their recommended execution order. The ordering is optimised for cache warming: `classPartitions()` runs before the per-class stages, so the `?s a ?class` pattern is already cached on the SPARQL endpoint when the heavier per-class queries execute — preventing 504 timeouts on cold caches.

Accepts an optional `VoidStagesOptions` object:

| Option             | Default | Description                                                                                                                       |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `batchSize`        | 10      | Maximum class bindings per executor call (per-class stages only)                                                                  |
| `maxConcurrency`   | 10      | Maximum concurrent in-flight executor batches (per-class stages only)                                                             |
| `perClass`         | —       | Override per-class iteration for all five per-class stages                                                                        |
| `uriSpaces`        | —       | When provided, includes the object URI space stage                                                                                |
| `vocabularies`     | —       | Additional vocabulary namespace URIs to detect beyond the built-in defaults                                                       |
| `namespaceAliases` | —       | Namespace pairs whose alias form is treated as canonical when partitioning by class (see [Namespace aliases](#namespace-aliases)) |
| `transforms`       | —       | Transforms to attach to bundled stages, keyed by `VOID_STAGE_NAMES` (see [Stage transforms](#stage-transforms))                   |

Per-request timeouts are configured at the `Pipeline` level via `PipelineOptions.timeout`, not per VoID stage.

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

Global and domain-specific factories accept `VoidStageOptions` (`transform`) and return `Promise<Stage>`. Per-class factories accept `PerClassVoidStageOptions` (`transform`, `batchSize`, `maxConcurrency`, `perClass`) — they default `perClass` to `true`; set it to `false` to run them as monolithic queries instead.

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

## Namespace aliases

Some vocabularies are published under more than one namespace IRI — most commonly schema.org, served under both `http://schema.org/` (historical) and `https://schema.org/` (current). To RDF these are distinct IRIs, so a dataset that mixes the two forms produces a separate `void:classPartition` for each variant of the same class, each counted over a disjoint subset.

Pass `namespaceAliases` to treat an alias namespace as its canonical equivalent. Every class-keyed query then rewrites alias-namespace types to canonical before grouping — and the class selector collapses the variants — so each class appears once, with `void:entities` summed and its property partitions merged. The per-class queries still match resources typed with either variant, so no resource is dropped.

```typescript
const stages = await voidStages({
  namespaceAliases: [
    { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
  ],
});
```

Canonicalisation applies to class IRIs (`void:class`, including object-class partitions), not to predicates. With no aliases configured the queries are unchanged.

## Stage transforms

A VoID stage decorates its executor’s output with a `QuadTransform<ExecutorContext>` attached as data (see [@lde/pipeline](../pipeline)’s extension model and [ADR 2](../../docs/decisions/0002-unify-pipeline-extension-on-quad-transforms.md)). It runs once per executor call and may fire its own SPARQL queries against the `distribution` in scope — so write it to accept being called more than once: a global stage calls it once over the complete output, a per-class stage with batching enabled once per batch (one class at `batchSize: 1`).

Two transform factories are built in:

- `withVocabularies(vocabularies?)` — passes through all quads and appends `void:vocabulary` triples for detected vocabulary namespace prefixes in `void:property` quads. The built-in defaults are exported as `defaultVocabularies` (sourced from `@zazuko/prefixes`); `detectVocabularies()` attaches it to the `entity-properties.rq` stage.
- `withUriSpaces(uriSpaceMap)` — consumes `void:Linkset` quads, matches each `void:objectsTarget` against the configured URI space prefixes using `startsWith`, and aggregates triple counts per matched space. Emits `void:objectsTarget` pointing to the target dataset IRI (taken from the metadata quad subjects), not the raw prefix; unmatched linksets are discarded. `uriSpaces(uriSpaceMap)` attaches it to the `object-uri-space.rq` stage.

### Attaching your own transform

Pass a `transform` to an individual factory, or route transforms through `voidStages` with the `transforms` map keyed by `VOID_STAGE_NAMES` — so you can decorate a stage you never construct. Where a stage already carries a built-in transform, your transform composes after it. An invalid stage name is a compile error.

```typescript
import { voidStages, VOID_STAGE_NAMES } from '@lde/pipeline-void';
import type { ExecutorContext, QuadTransform } from '@lde/pipeline-void';

const sampleSubjects: QuadTransform<ExecutorContext> = async function* (
  quads,
  { dataset, distribution },
) {
  yield* quads; // pass the stage’s subsets through unchanged …
  // … then fire a sample SELECT against `distribution` and append measurements.
};

const stages = await voidStages({
  batchSize: 1,
  transforms: {
    [VOID_STAGE_NAMES.subjectUriSpace]: sampleSubjects,
  },
});
```
