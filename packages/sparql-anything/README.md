# SPARQL Anything

Convert tabular and other non-RDF sources to RDF with the [SPARQL Anything](https://sparql-anything.cc) CLI.

The `SparqlAnythingConverter` runs the SPARQL Anything jar once per input chunk to bound memory use, then concatenates the resulting N-Triples into a single file. A job is a query and the chunks to run it over.

## Installation

```sh
npm install @lde/sparql-anything
```

```typescript
import { SparqlAnythingConverter } from '@lde/sparql-anything';
import { NativeTaskRunner } from '@lde/task-runner-native';

const converter = new SparqlAnythingConverter({
  jarPath: 'bin/sparql-anything.jar',
  workDir: 'data',
  taskRunner: new NativeTaskRunner({ cwd: 'data' }),
});

await converter.convert(
  [{ queryFile: 'config/places.rq', chunks: ['data/places_aa.csv'] }],
  'output/places.nt',
);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/sparql-anything).
