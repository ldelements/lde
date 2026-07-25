# @lde/pipeline

A framework for transforming large RDF datasets, primarily using [SPARQL](https://www.w3.org/TR/sparql11-query/) queries with TypeScript for the parts that are hard to express in SPARQL alone. Transformations are plain SPARQL query files – portable, transparent, testable and version-controlled – and memory stays bounded no matter how large the dataset.

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

## Documentation

See the [full documentation](https://ldelements.org/reference/pipeline).
