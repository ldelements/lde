# @lde/pipeline-shacl-validator

SHACL validation for [`@lde/pipeline`](../pipeline).

Validates RDF quads produced by pipeline stages against [SHACL shapes](https://www.w3.org/TR/shacl/),
streaming the per-dataset SHACL validation report to any number of configured
[`Writer`](../pipeline/src/writer/writer.ts)s. Shapes can be provided in any
RDF serialization (Turtle, JSON-LD, N-Triples etc.).

## Usage

```typescript
import {
  Pipeline,
  Stage,
  SparqlConstructExecutor,
  FileWriter,
  SparqlUpdateWriter,
} from '@lde/pipeline';
import { ShaclValidator } from '@lde/pipeline-shacl-validator';

const validator = new ShaclValidator({
  shapesFile: './shapes.ttl',
  reportWriters: [
    new FileWriter({ outputDir: './validation', format: 'turtle' }),
    new SparqlUpdateWriter({ endpoint: new URL('http://store/update') }),
  ],
});

const pipeline = new Pipeline({
  // ...
  stages: [
    new Stage({
      name: 'transform',
      executors: new SparqlConstructExecutor({ query: '...' }),
      validation: {
        validator,
        onInvalid: 'write', // 'write' | 'skip' | 'halt'
      },
    }),
  ],
});

await pipeline.run();
```

### `onInvalid` options

| Value     | Behaviour                                                        |
| --------- | ---------------------------------------------------------------- |
| `'write'` | Write quads to the output even if validation fails **(default)** |
| `'skip'`  | Discard invalid quads silently                                   |
| `'halt'`  | Throw an error, stopping the pipeline                            |

### Report writers

Each `validate()` call that produces violations fans the SHACL report quads
(`sh:ValidationResult` triples, etc.) out to every configured `reportWriter`
via `Writer.write(dataset, quads)`. Each writer's `Writer.flush(dataset)` is
invoked from `ShaclValidator.report(dataset)` — i.e. once the pipeline
finishes a dataset.

Validators with no `reportWriters` only produce aggregate counts
(`{ conforms, violations, quadsValidated }`); the report quads are discarded.

The bundled `FileWriter` and `SparqlUpdateWriter` already implement the
`Writer` contract; bring your own for custom destinations. Note that writers
receive the original `Dataset`, so a `SparqlUpdateWriter` uses `dataset.iri`
as the named graph by default — wrap or configure your writer if you need
validation results in a separate graph from the dataset itself.
