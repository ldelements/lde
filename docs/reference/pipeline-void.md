# @lde/pipeline-void

Extensions to [@lde/pipeline](./pipeline) for VoID (Vocabulary of Interlinked Datasets) statistical analysis of RDF datasets.

## Installation

```sh
npm install @lde/pipeline-void
```

## Stage factories

### `voidStages(options?)`

Returns all VoID stages in their recommended execution order. The ordering is optimised for cache warming: `classPartitions()` runs before the per-class stages, so the `?s a ?class` pattern is already cached on the SPARQL endpoint when the heavier per-class queries execute – preventing 504 timeouts on cold caches.

Accepts an optional `VoidStagesOptions` object:

| Option           | Default | Description                                                                                                       |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `batchSize`      | 10      | Maximum item bindings per reader call (per-class stages and the per-property vocabularies stage)                  |
| `maxConcurrency` | 10      | Maximum concurrent in-flight reader batches (per-class stages and the per-property vocabularies stage)            |
| `perClass`       | –       | Override per-class iteration for all five per-class stages                                                        |
| `perProperty`    | `true`  | Iterate the vocabularies (property-partition) stage per property, bounding its memory by batch instead of dataset |
| `uriSpaces`      | –       | When provided, includes the object URI space stage                                                                |
| `vocabularies`   | –       | Additional vocabulary namespace URIs to detect beyond the built-in defaults                                       |
| `transforms`     | –       | Transforms to attach to bundled stages, keyed by `VOID_STAGE_NAMES` (see [Stage transforms](#stage-transforms))   |

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

Global and domain-specific factories accept `VoidStageOptions` (`transform`) and return `Promise<Stage>`. Per-class factories accept `PerClassVoidStageOptions` (`transform`, `batchSize`, `maxConcurrency`, `perClass`) – they default `perClass` to `true`; set it to `false` to run them as monolithic queries instead.

#### Global stages (one CONSTRUCT query per dataset):

| Factory                 | Query                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classPartitions()`     | [`class-partition.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/class-partition.rq) – Classes with entity counts |
| `countDatatypes()`      | [`datatypes.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/datatypes.rq) – Dataset-level datatypes                |
| `countObjectLiterals()` | [`object-literals.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/object-literals.rq) – Literal object counts      |
| `countObjectUris()`     | [`object-uris.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/object-uris.rq) – URI object counts                  |
| `countProperties()`     | [`properties.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/properties.rq) – Distinct properties                  |
| `countSubjects()`       | [`subjects.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/subjects.rq) – Distinct subjects                        |
| `countTriples()`        | [`triples.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/triples.rq) – Total triple count                         |
| `detectLicenses()`      | [`licenses.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/licenses.rq) – License detection                        |
| `subjectUriSpaces()`    | [`subject-uri-space.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/subject-uri-space.rq) – Subject URI namespaces |

The scalar count stages (`countSubjects`, `countProperties`, `countObjectLiterals`, `countObjectUris`, `countTriples`) set the stage’s `expectsOutput` flag: each query is a single `COUNT` that always returns exactly one row, so zero output can only mean the endpoint truncated the response. The stage then fails – triggering the pipeline’s reactive dump fallback – instead of silently storing a missing count. `countDatatypes` deliberately does not set the flag: its query joins the count with a `SELECT DISTINCT ?datatype` group, so a dataset with no literals legitimately yields zero rows.

#### Per-class stages (iterated with a class selector):

| Factory                   | Query                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classPropertySubjects()` | [`class-properties-subjects.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/class-properties-subjects.rq) – Properties per class (subject counts)     |
| `classPropertyObjects()`  | [`class-properties-objects.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/class-properties-objects.rq) – Properties per class (object counts)        |
| `perClassDatatypes()`     | [`class-property-datatypes.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/class-property-datatypes.rq) – Per-class datatype partitions               |
| `perClassLanguages()`     | [`class-property-languages.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/class-property-languages.rq) – Per-class language tags                     |
| `perClassObjectClasses()` | [`class-property-object-classes.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/class-property-object-classes.rq) – Per-class object class partitions |

The class selector that drives per-class iteration honours the distribution’s `subjectFilter` and `namedGraph`, excludes blank-node classes at the endpoint (they have no stable identity to iterate by), and caps the class list at `LIMIT 1000` – a dataset with more classes has the excess silently left unanalysed.

#### Domain-specific stages:

| Factory                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `detectVocabularies()`   | [`entity-properties.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/entity-properties.rq) – Entity properties with automatic `void:vocabulary` detection. Accepts `DetectVocabulariesOptions`: an optional `vocabularies` array to extend the built-in defaults, plus `perProperty` (default `true`), `batchSize` and `maxConcurrency`. By default the query iterates per property – the single global `GROUP BY` over every property materializes the dataset’s full scan and exhausts the query-memory budget on large datasets (measured on a 608M-triple dataset); `perProperty: false` restores the single query. |
| `uriSpaces(uriSpaceMap)` | [`object-uri-space.rq`](https://github.com/ldelements/lde/blob/main/packages/pipeline-void/queries/object-uri-space.rq) – Object URI namespace linksets, aggregated against a provided URI space map                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Namespace normalization

Some vocabularies publish under both `http://` and `https://` variants of the same namespace (notably schema.org), and datasets mix them. Without normalization each variant gets its own `void:classPartition`/`void:propertyPartition`, so consumers see two partitions for one class – which crashed the Dataset Register browser (netwerk-digitaal-erfgoed/dataset-knowledge-graph#334).

`schemaOrgPartitionMergePlugin` normalizes `http://schema.org/` to `https://schema.org/` **and** merges the duplicate partition nodes the two variants produced. It is a [`beforeDatasetWrite`](./pipeline) plugin – it runs once over a whole dataset’s output at the pipeline edge, so the analysis queries stay unaware of namespace aliases (see [ADR 7](../decisions/0007-namespace-merge-as-a-dataset-plugin)):

```typescript
import { voidStages, schemaOrgPartitionMergePlugin } from '@lde/pipeline-void';
import { Pipeline, provenancePlugin } from '@lde/pipeline';

await new Pipeline({
  stages: await voidStages(), // plain, no namespace options
  plugins: [schemaOrgPartitionMergePlugin(), provenancePlugin()],
  // …
}).run();
```

Use `namespacePartitionMergePlugin(aliases)` for namespaces other than schema.org. The plugin requires a stage set that includes both `classPartitions` and `classPropertySubjects` (as `voidStages()` does): re-keying a datatype/language/object-class partition walks up its partition chain, reading the `void:class` and `void:property` triples those two stages emit – without them a void-ext partition cannot be re-keyed and its alias variants ship unmerged. The transform streams – it buffers only partition quads (bounded by the summary), passing everything else straight through. Datasets typically use a single schema.org namespace, so within one dataset there is one variant per class and every count stays exact; a dataset that mixes both namespaces on one property has its `void:distinctObjects` summed (an over-count for shared objects) rather than deduped.

> This plugin does more than rename IRIs: rewriting the `void:class` objects alone would still leave two `void:classPartition` nodes for one class. If you only need a blanket namespace rewrite over a dataset’s own quads (not a VoID partition merge) – for example when mapping instance data to an application profile – use the generic [`schemaOrgNormalizationPlugin` / `namespaceNormalizationPlugin`](./pipeline) from `@lde/pipeline` instead.

## Stage transforms

A VoID stage decorates its reader’s output with a `QuadTransform<ReaderContext>` attached as data (see [@lde/pipeline](./pipeline)’s extension model and [ADR 2](../decisions/0002-unify-pipeline-extension-on-quad-transforms)). It runs once per reader call and may fire its own SPARQL queries against the `distribution` in scope – so write it to accept being called more than once: a global stage calls it once over the complete output, an iterating stage once per batch (one class – or, on the vocabularies stage, one property – at `batchSize: 1`).

Two transform factories are built in:

- `withVocabularies(vocabularies?)` – passes through all quads and appends `void:vocabulary` triples for detected vocabulary namespace prefixes in `void:property` quads. The built-in defaults are exported as `defaultVocabularies` (sourced from `@zazuko/prefixes`); `detectVocabularies()` attaches it to the `entity-properties.rq` stage. The transform remembers which vocabularies it already emitted per distribution instance, so per-property batches yield each `void:vocabulary` quad once per stage run – reuse one transform instance within a run, and expect a fresh distribution (e.g. a fallback re-run) to start clean.
- `withUriSpaces(uriSpaceMap)` – consumes `void:Linkset` quads, matches each `void:objectsTarget` against the configured URI space prefixes using `startsWith`, and aggregates triple counts per matched space. Emits `void:objectsTarget` pointing to the target dataset IRI (taken from the metadata quad subjects), not the raw prefix; unmatched linksets are discarded. `uriSpaces(uriSpaceMap)` attaches it to the `object-uri-space.rq` stage.

### Attaching your own transform

Pass a `transform` to an individual factory, or route transforms through `voidStages` with the `transforms` map keyed by `VOID_STAGE_NAMES` – so you can decorate a stage you never construct. Where a stage already carries a built-in transform, your transform composes after it. An invalid stage name is a compile error.

```typescript
import { voidStages, VOID_STAGE_NAMES } from '@lde/pipeline-void';
import type { ReaderContext, QuadTransform } from '@lde/pipeline-void';

const sampleSubjects: QuadTransform<ReaderContext> = async function* (
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
