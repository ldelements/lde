# @lde/search-pipeline

Search indexing as an [`@lde/pipeline`](./pipeline) Configurable Pipeline
instance: this package supplies the glue between the pipeline’s quad world
and a search engine’s document world, so indexing reuses the existing spine –
Discovery → Selection → Iteration → change-gate (skip-unchanged) – instead of
rebuilding it per consumer.

The division of labour ([ADR 6](../decisions/0006-make-the-writer-transaction-aware),
[ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)):

- [`@lde/search`](./search) owns the engine-agnostic projection (framed
  document + field model) and stays pipeline-free;
- `@lde/search-<engine>` (e.g. [`@lde/search-typesense`](./search-typesense))
  is the engine adapter: a transactional, **single-collection** `Writer`
  consuming projected documents, owning the run lifecycle (Blue/green alias swap
  or In-place sweeps, cross-pod lock);
- **this package** composes them:
  - `searchStages` builds one projecting `Stage` per root type. Each stage
    selects its own roots, extracts each root’s quads, and projects the
    **root-complete batch** into documents paired with their `SearchType`
    (`TypedSearchDocument`) – so projection happens inside the batch and memory
    is bounded by `batchSize` roots, not the dataset
    ([ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)).
    Extraction is **generated from the schema**: `extractionQuery` mints a
    CONSTRUCT that reads each field’s source `path` (a SPARQL property path) and
    emits it under the field’s IR Alias (`urn:lde:‹Type›/‹field›`) – the same key
    the projection reads back – so the reader and the projection cannot drift. A
    stage without an explicit `readers` defaults to this generated reader;
  - `searchIndexWriter` is the pipeline’s single terminal: an engine-agnostic
    router that dispatches each document to the engine writer for **its**
    type’s collection ([ADR 9](../decisions/0009-route-a-whole-schema-projection-to-per-type-collections)).
    It owns no projection and buffers nothing.

So a search pipeline is **one terminal, N stages**: `new Pipeline<TypedSearchDocument>({ datasetSelector, stages: searchStages(...), writers: searchIndexWriter(...) })`.

## Installation

```sh
npm install @lde/search-pipeline
```

## Quick start: `searchIndexerPipeline`

For the common **object grain** – index every IRI-identified instance of each
root type’s source class – `searchIndexerPipeline` wires that whole composition
and returns the ready-to-run `Pipeline`. It generates one stage per root type
in the schema, each selecting the type’s non-blank roots by class
(`selectByClass`; a blank node has no stable document key, so it can never
become a document), extracting with the schema-generated CONSTRUCT, and routing
every document to the engine writer for its type’s collection. The consumer
supplies only the domain (the schema, which datasets) and the deployment shell
(the engine writer, the SPARQL/import adapter):

```typescript
import { searchIndexerPipeline } from '@lde/search-pipeline';
import {
  FileProvenanceStore,
  ImportResolver,
  SparqlDistributionResolver,
} from '@lde/pipeline';
import { ConsoleReporter } from '@lde/pipeline-console-reporter';
import { createQlever } from '@lde/sparql-qlever';
import { InPlaceRebuild } from '@lde/search-typesense';

const pipeline = searchIndexerPipeline({
  schema,
  datasets,
  // Import each dataset’s data dump into a local QLever and query that.
  distributionResolver: new ImportResolver(new SparqlDistributionResolver(), {
    ...createQlever({ mode: 'docker', image: 'adfreiburg/qlever:latest' }),
    strategy: 'import',
  }),
  writerFor: (searchType, schema) =>
    new InPlaceRebuild(typesenseClient, searchType, { schema }),
  // Optional: skip datasets whose source and pipeline version are unchanged.
  provenanceStore: new FileProvenanceStore({ path: 'data/provenance.json' }),
  pipelineVersion: '1',
  reporter: new ConsoleReporter(),
});
await pipeline.run();
```

Each role in that wiring maps to a package:

| Role                                   | Package                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dataset selection                      | [`@lde/pipeline`](./pipeline) – `Dataset[]` directly, or a `DatasetSelector` such as `RegistrySelector`                                                                                                            |
| Distribution resolution and import     | [`@lde/pipeline`](./pipeline) `ImportResolver` + [`@lde/sparql-qlever`](./sparql-qlever) `createQlever` (the concrete [`@lde/sparql-server`](./sparql-server)/[`@lde/sparql-importer`](./sparql-importer) adapter) |
| Root selection, extraction, projection | this package (`searchStages` over [`@lde/search`](./search))                                                                                                                                                       |
| Engine writer, one collection per type | [`@lde/search-typesense`](./search-typesense) – `InPlaceRebuild` or `BlueGreenRebuild`                                                                                                                             |
| Provenance (skip-unchanged)            | [`@lde/pipeline`](./pipeline) – `FileProvenanceStore`, or a triplestore-backed store                                                                                                                               |
| Reporting                              | [`@lde/pipeline-console-reporter`](./pipeline-console-reporter) `ConsoleReporter`                                                                                                                                  |

Domain behaviour on top of that wiring – correcting the data, minting a quad the
source does not ship, dropping one it should not – is the `transforms` option,
one or more `QuadTransform`s per root type keyed by the type’s `name`:

```ts
searchIndexerPipeline({
  schema,
  datasets,
  writerFor,
  transforms: { Object: [dropSelfReferences] },
});
```

The transform is attached to the type’s generated reader, so the reader’s
subject variable and the stage’s root variable stay in step; a key the schema
does not declare throws at wiring time. Note that a field a transform fills must
still declare a `path` – projection skips a field with neither a `path` nor a
`derive`.

A deployment that needs more – a bespoke root selector (where the entry point
is a domain fact, not a class), per-stage tuning, non-SPARQL readers, or
quad-level plugins – composes the parts directly, as below, restating the
registry sourcing, provenance and reporting this convenience wires; beyond
those it owns no capability of its own.

## Usage

```typescript
import { Pipeline } from '@lde/pipeline';
import { searchSchema } from '@lde/search';
import { BlueGreenRebuild } from '@lde/search-typesense';
import {
  searchStages,
  selectByClass,
  searchIndexWriter,
  type TypedSearchDocument,
} from '@lde/search-pipeline';

// One schema, several root types: the `datasets` catalog plus the Organization
// label collection its references resolve against.
const schema = searchSchema(
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      {
        name: 'title',
        kind: 'text',
        path: 'http://purl.org/dc/terms/title',
        locales: ['und'],
        output: true,
        searchable: { weight: 5 },
      },
    ],
  },
  {
    name: 'Organization',
    class: 'http://xmlns.com/foaf/0.1/Organization',
    fields: [
      {
        name: 'label',
        kind: 'text',
        path: 'http://xmlns.com/foaf/0.1/name',
        locales: ['und'],
        output: true,
        searchable: { weight: 1 },
      },
    ],
  },
);

const dataset = schema.get('http://www.w3.org/ns/dcat#Dataset')!;
const organization = schema.get('http://xmlns.com/foaf/0.1/Organization')!;

const pipeline = new Pipeline<TypedSearchDocument>({
  datasetSelector,
  // One stage per root type: each selects its own roots (here by class –
  // `selectByClass` is a convenience for the object grain; a deployment writes
  // its own selector where the entry point is a domain fact) and extracts each
  // root’s quads. Omitting `readers` defaults each stage to the Extraction
  // CONSTRUCT generated from the schema (pass one only for a non-SPARQL source or
  // to merge readers). `rootVariable` couples the selector’s projected variable
  // to the CONSTRUCT’s free subject; it must not be `dataset` (reserved by the
  // reader).
  stages: searchStages({
    schema,
    types: [
      {
        searchType: dataset,
        rootVariable: 'root',
        itemSelector: selectByClass(dataset),
      },
      {
        searchType: organization,
        rootVariable: 'root',
        itemSelector: selectByClass(organization),
      },
    ],
  }),
  // A stage reads the dataset’s own distribution unless `sourceFor` says
  // otherwise – see “Registry-sourced root types” below.
  // Each type gets its own collection – an independent blue/green rebuild –
  // named by the adapter from the type itself (`Dataset` → `datasets`,
  // `Organization` → `organizations`), so no naming map is passed here and the
  // engine reading these collections cannot disagree about where they are.
  writers: searchIndexWriter({
    schema,
    writerFor: (searchType, schema) =>
      new BlueGreenRebuild(typesenseClient, searchType, { schema }),
  }),
});

await pipeline.run();
```

Collection names are the engine adapter’s to decide, not this package’s – see
[Collection naming](./search-typesense#collection-naming). A deployment that
needs other names passes one per type, and environment prefixing **composes
with** the convention rather than replacing it, since the adapter exports the
derivation:

```ts
import { BlueGreenRebuild, deriveCollectionName } from '@lde/search-typesense';

writerFor: (searchType, schema) =>
  new BlueGreenRebuild(typesenseClient, searchType, {
    schema,
    // A function of the type, not a bare name: a writer names its own
    // collection AND the peers its joins reference, so the prefix has to apply
    // to both.
    collectionNameFor: (type) =>
      `${process.env.INDEX_PREFIX}_${deriveCollectionName(type)}`,
  });
```

Whatever the writers are named, the engine reading these collections must be
given the same names (`collections`), or it reads the derived ones and finds an
empty index.

Each stage projects its own root-complete batches (`@lde/search`’s
`projectRoots`) into documents paired with its `SearchType`, and the terminal
dispatches each to the engine run for its type’s collection as it arrives –
before the engine acts on the dataset’s completion, so an In-place stale sweep
never races its own documents. The run lifecycle (run context, per-dataset flush
outcome, commit/abort) passes through unchanged: the engine writer’s update mode
governs, and the pipeline never branches on it, nor on how many collections
there are.

**Root selection is the deployment’s contract.** A selector that does not bind
the CONSTRUCT’s subject yields a batch that is not root-complete, and projection
will then silently emit partial documents – a promise `@lde/pipeline` cannot
check ([ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)).
`selectByClass(searchType)` is a convenience for the object grain (where the
type’s `class` really is the source class), **not** a default. It excludes
blank-node subjects (`FILTER(!isBlank(?root))`): a blank node has no stable
document key, so it can never become a search document – a custom selector
should exclude them too.

## Registry-sourced root types

A stage reads the dataset’s own distribution. That holds while a root type is
described by the data the dataset publishes, and it breaks for the dataset
itself: a dataset’s description is governed by a different application profile
from the objects it contains, and it lives in the **dataset registry**.
Registering a dataset is submitting a description, so the register covers every
dataset a pipeline can select – while nothing obliges a publisher to describe
its own dataset inside its dump.

`registrySource` points a stage at the register instead, scoped to the graph the
dataset in hand names:

```typescript
import {
  registrySource,
  searchStages,
  selectByClass,
} from '@lde/search-pipeline';

searchStages({
  schema,
  types: [
    {
      searchType: dataset,
      rootVariable: 'root',
      itemSelector: selectByClass(dataset),
      sourceFor: registrySource(new URL('https://registry.example.org/sparql')),
    },
    // …the object-grain types keep reading the dataset’s distribution.
  ],
});
```

`searchIndexerPipeline` exposes the same routing as `registryTypes`, by type
name:

```typescript
searchIndexerPipeline({
  schema,
  datasets,
  writerFor,
  registryTypes: {
    endpoint: new URL('https://registry.example.org/sparql'),
    names: ['Dataset', 'Publisher'],
  },
});
```

Same CONSTRUCT generator, same framing, same projection, same writers – only
the source differs. Two properties make it work:

- **The scoping is what keeps the stage per-dataset.** A register holds every
  registration, so an unscoped stage would index the whole catalogue once per
  dataset processed. `registrySource` scopes selection _and_ extraction to the
  dataset’s graph, so one pass sees exactly one registration. It presumes the
  register names each registration’s graph after the dataset IRI, which is how
  a DCAT register that crawls per registration stores it.
- **The hops come from the declared paths.** No CBD rule and no hardcoded
  predicate list: a `Publisher` root type with `label` at
  `<http://xmlns.com/foaf/0.1/name>` resolves through the same mechanism as any
  other type, because a registration describes its publisher inside its own
  graph.

Routing is deployment topology, deliberately kept out of the `SearchType`: a
type is defined by its `class`, not by where its triples come from, so the same
declaration serves a deployment that sources it differently.

## Per-stage tuning

Each `SearchStageType` entry carries three knobs beyond its selector and
readers:

- **`batchSize`** (default 10) – roots (and so documents) per batch: **the
  memory bound**. Under a root-bound selector it moves memory and request
  count, never output.
- **`maxConcurrency`** (default 10) – maximum concurrent in-flight SPARQL
  queries for the stage.
- **`queueCapacity`** (default 128) – capacity of the bounded queue funnelling
  the stage’s projected documents into the write. A projected document is far
  heavier than a quad, so lower it where documents are large.

## Per-component isolation

Each root type is an independent engine run – its own collection, alias and
cross-pod lock – and the unit those runs are isolated **by** is the
[join component](./search#filtering-across-collections): the group of types that
reference one another through a `joinable` reference, and therefore cannot go
live apart. A type declaring none is a singleton component, so a schema without
joins behaves exactly as before, and the collections commit, sweep and fail in
isolation:

- a type whose projection is empty this run affects only its own collection,
  never another’s – in particular the `datasets` index still goes live;
- `flush` and `reset` fan out to **every** collection independently too (a
  collection an earlier dataset held documents for still needs its sweep or
  discard), with failures aggregated after all have been attempted – one
  collection’s failure never skips another’s;
- runs are **opened** in join order, referenced first: an engine cannot create a
  collection whose reference names one that does not exist yet. It is still the
  single deterministic pass that takes every lock in a fixed order, so
  lock-ordering deadlock stays impossible;
- `commit` finalizes every **component** independently and, if any fails, throws
  an `AggregateError` _after_ attempting them all, so a non-critical
  label-collection failure never blocks the components that did commit, while
  the failure is still surfaced (the run is marked failed). Within a component
  the commits are sequential and referrers first – a blue/green commit drops the
  collection it supersedes, so committing the referent first would delete one
  the still-live referrer points at – and stop at the first failure, so a
  component ships whole or not at all;
- because the pipeline aborts a run whose `commit` throws, `abort` has three
  outcomes rather than two. A collection that went live is left alone (aborting
  a committed blue/green rebuild would drop it); a collection in a component
  that went _partly_ live is **abandoned** – finalized without dropping what it
  built, since that is exactly what the live member references by name, while
  still releasing its cross-pod lock; everything else is aborted as before,
  dropping the half-built collection and releasing its lock.

See [ADR 9](../decisions/0009-route-a-whole-schema-projection-to-per-type-collections)
and [ADR 19](../decisions/0019-filter-across-collections-through-declared-joins).

## Memory

Memory is bounded by **`batchSize` roots**, not by the input
([ADR 12](../decisions/0012-bound-memory-by-the-unit-of-work-not-the-input),
[ADR 13](../decisions/0013-project-inside-the-batch-per-root-type)).
Projection runs inside each root-complete batch and streams straight through the
terminal to the engine run, which holds only its own batch – nothing accumulates
across a dataset or across datasets, so the same pipeline indexes a 15-quad
catalog entry and a dataset of millions of objects. The one irreducible atom is a
single root’s quads: unbounded for a pathological root, and nothing here changes
that.

## Extraction queries and non-deduplicating engines

`extractionQuery(searchType, schema, options?)` generates the CONSTRUCT as an
AST; `extractionQueryString` serialises it to the SPARQL string a reader runs –
exported so a deployment can inspect, log or wrap the generated query. The one
option, `ExtractionOptions.subjectVariable` (default `'root'`), names the free
subject variable the pipeline’s `VALUES` injection binds the batch’s roots to;
it must match the stage’s `rootVariable` and must not be `dataset` (reserved by
the SPARQL reader).

The generated extraction CONSTRUCTs are deliberately shaped to be well-formed for
**non-deduplicating** SPARQL engines such as
[QLever](https://github.com/ad-freiburg/qlever), which emit one copy of the
CONSTRUCT template per solution row rather than a deduplicated set. The generator
guarantees one output triple per genuine value:

- **UNION per field, never conjunction.** Each field is its own `UNION` branch
  (`?root <path> ?value`), so two independent multi-valued fields never form a
  cross-product – the failure mode that inflates a non-deduplicating engine’s
  output by the product of their cardinalities (roughly 18-fold on a measured
  QLever workload).
- **No projected-away template triple.** Every template triple binds its own
  variables (`?root <alias> ?value`); there is no constant triple (e.g.
  `?root a <Type>`) to be re-emitted once per solution.
- **Given roots.** Roots arrive as a `VALUES` set, not a pattern that fans out.
- **Inline references keep the discipline recursively:** a reference type’s
  fields are UNION’d off the referent variable, so even a multi-hop nested
  template never conjoins independent multi-valued fields – only the intermediate
  link triple repeats, and only linearly.
- **A `local` lookup nests like an inline reference, in an `OPTIONAL`.** A
  reference that also stores what this document says about its endpoint
  ([`local`](./search#data-on-the-edge)) gets its branch extended with the target
  Root Type's own fields, UNION'd off the referent and emitted under that type's
  aliases. The union is what keeps the endpoint's independent multi-valued
  properties additive rather than multiplicative: measured on an agent with 3
  names, 2 job titles and 2 `sameAs`, the generated shape yields 8 solution rows
  where one `OPTIONAL` per property yields 13, and the gap widens with every
  value. `OPTIONAL` rather than conjoined, unlike an inline reference's nesting,
  because a `local` lookup stores its endpoint by id whether or not the document
  says anything about it – conjoining would drop the id along with the absent
  fields. It subsumes the key hop below, the key field being one of the target's
  own.
- **A key hop stays inside its branch.** A reference naming a target that
  declares a [document key](./search#document-key) gets its branch extended with
  an `OPTIONAL` hop reading the referent’s key field, emitted under the target’s
  own alias – so the projection can store the referent’s key rather than its node
  IRI. It sits inside that reference’s UNION branch, so it never cross-multiplies
  against another field; like an inline reference’s link triple, the reference’s
  own template triple then repeats once per key candidate – linearly, and only
  for a referent that carries several. `OPTIONAL`, so a referent with no key
  candidate keeps its row. The root side is unchanged: a key field is a declared field, so its own
  branch and template triple are already there.

Because the queries are duplicate-free by construction, correctness and bounded
output volume do **not** depend on a client-side **post-processing deduplication
step** – buffering a whole result to deduplicate it would defeat the
batch-bounded streaming memory model above. The only residual duplication is
linear and comes from duplicate _input_ – a non-`DISTINCT` selector feeding a
multi-typed root more than once – which the projection’s streaming per-quad
subject index collapses as a cheap backstop, not as a compensator for
query-shape inflation. Validated on a real QLever index over the full source
dump: raw CONSTRUCT output equalled the distinct set for a type with distinct
roots, and the projected documents were byte-identical to those from a
deduplicating engine.
