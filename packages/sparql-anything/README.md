# SPARQL Anything

Convert tabular and other non-RDF sources to RDF with the [SPARQL Anything](https://sparql-anything.cc) CLI.

The `SparqlAnythingConverter` runs the SPARQL Anything jar once per job – a query, over an optional chunk – to bound memory use, then concatenates the per-job N-Triples outputs into a single file.

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
  [{ queryFile: 'config/places.rq', chunk: 'data/places_aa.csv' }],
  'output/places.nt',
);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/sparql-anything).
