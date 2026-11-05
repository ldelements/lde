# Build a pipeline

In this tutorial you will build and run your first Linked Data pipeline. The pipeline connects to a SPARQL endpoint, discovers the classes used in the dataset, extracts all class assertions, and writes them to local Turtle files.

You will learn the core LDE concepts along the way: **datasets** and **distributions**, **stages**, **item selectors**, **readers** and **writers**.

## Prerequisites

- [Node.js](https://nodejs.org) (LTS) and npm.
- A SPARQL endpoint you can query. Any SPARQL 1.1 endpoint works; the examples below use `https://example.org/sparql` as a placeholder – replace it with your own endpoint.

## Step 1: Set up a project

Create a new project and install the two packages you need:

```sh
mkdir my-first-pipeline
cd my-first-pipeline
npm init -y
npm install @lde/pipeline @lde/dataset
npm install --save-dev tsx typescript
```

LDE packages are ESM-only, so tell Node.js to treat the project as ESM:

```sh
npm pkg set type=module
```

## Step 2: Describe your dataset

LDE pipelines process **datasets**. A dataset is described by its IRI and one or more **distributions** – the concrete ways to get at the data, such as a SPARQL endpoint or a downloadable data dump.

Create `pipeline.ts` and describe a dataset with a SPARQL endpoint distribution:

```typescript
import { Dataset, Distribution } from '@lde/dataset';

const dataset = new Dataset({
  iri: new URL('https://example.org/datasets/my-dataset'),
  distributions: [Distribution.sparql(new URL('https://example.org/sparql'))],
});
```

In a real application you would typically discover datasets from a DCAT-AP 3.0 registry with [@lde/dataset-registry-client](../reference/dataset-registry-client) instead of describing them by hand – but for a first pipeline, manual is fine.

## Step 3: Define a stage

A pipeline consists of one or more **stages**. Each stage has:

- an optional **item selector** that selects resources to fan out over, and
- one or more **readers** that generate triples.

Add a stage that first selects all classes in the dataset, then extracts the class assertions for each of them:

```typescript
import {
  SparqlConstructReader,
  SparqlItemSelector,
  Stage,
} from '@lde/pipeline';

const stage = new Stage({
  name: 'classes',
  itemSelector: new SparqlItemSelector({
    query: 'SELECT DISTINCT ?class WHERE { ?s a ?class }',
    maxResults: 100,
  }),
  readers: new SparqlConstructReader({
    query: 'CONSTRUCT { ?s a ?class } WHERE { ?s a ?class }',
  }),
});
```

Two things are happening here:

1. The **item selector** runs its SELECT query against the endpoint and yields the resulting bindings in batches. `maxResults: 100` caps the total number of classes, which keeps this first run fast even against a large dataset. Note that the selector yields only rows where every projected variable binds an IRI – rows with literal or blank-node values are dropped silently.
2. For each batch of classes, the **reader** runs its CONSTRUCT query with the batch injected as a `VALUES ?class { … }` clause – so each reader call only extracts assertions for its own batch of classes. This fan-out is what lets LDE process datasets that are far too large to query in one go.

## Step 4: Assemble and run the pipeline

Now wire the dataset and the stage into a **pipeline**, with a **writer** that streams the generated triples to local files:

```typescript
import { FileWriter, ManualDatasetSelection, Pipeline } from '@lde/pipeline';

const pipeline = new Pipeline({
  datasetSelector: new ManualDatasetSelection([dataset]),
  stages: [stage],
  writers: new FileWriter({ outputDir: './output', format: 'turtle' }),
});

await pipeline.run();
```

Run it:

```sh
npx tsx pipeline.ts
```

## Step 5: Inspect the output

The `FileWriter` wrote the stage’s output to the `./output` directory as Turtle. Open the file and you’ll see the class assertions the pipeline extracted:

```turtle
<https://example.org/people/alice> a <https://schema.org/Person>.
<https://example.org/books/moby-dick> a <https://schema.org/Book>.
```

That’s it – you have built a pipeline that discovers what a dataset contains and extracts a slice of it, without ever holding the whole dataset in memory.

## Watching progress

For longer runs it helps to see what the pipeline is doing. Install [@lde/pipeline-console-reporter](../reference/pipeline-console-reporter) and pass a reporter:

```sh
npm install @lde/pipeline-console-reporter
```

```typescript
import { ConsoleReporter } from '@lde/pipeline-console-reporter';

const pipeline = new Pipeline({
  // …
  reporter: new ConsoleReporter(),
});
```

## Where next

- Replace the extraction queries with your own SPARQL CONSTRUCT transformations – that’s the heart of LDE: transformations are plain, portable SPARQL files.
- [Select datasets from a registry](./select-datasets-from-a-registry) instead of listing them by hand.
- [Validate pipeline output with SHACL](./validate-pipeline-output) before writing it.
- [Skip unchanged datasets](./skip-unchanged-datasets) so repeated runs only process what changed.
- [Build a search API](./build-a-search-api) on top of your datasets.
- Read the [core concepts](./core-concepts) and [architecture](./architecture) to see how it all fits together.
