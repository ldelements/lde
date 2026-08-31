# SPARQL Anything

Convert tabular and other non-RDF sources to RDF with the [SPARQL Anything](https://sparql-anything.cc) CLI.

The `SparqlAnythingConverter` runs the SPARQL Anything jar once per input chunk to bound memory use, then concatenates the per-chunk N-Triples outputs into a single file.

## Installation

```sh
npm install @lde/sparql-anything
```

```typescript
import { SparqlAnythingConverter } from '@lde/sparql-anything';
import { NativeTaskRunner } from '@lde/task-runner-native';

const converter = new SparqlAnythingConverter({
  queryFile: 'config/places.rq',
  jarPath: 'bin/sparql-anything.jar',
  workDir: 'data',
  load: 'data/reference.ttl',
  taskRunner: new NativeTaskRunner({ cwd: 'data' }),
});

await converter.convert(['data/places_aa.csv'], 'output/places.nt');
```

## Documentation

See the [full documentation](https://ldelements.org/reference/sparql-anything).
