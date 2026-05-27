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
(`{ conforms, violations, quadsValidated }`); the report quads themselves are
discarded. This is deliberate — callers who only need pass/fail metrics
don't have to wire up a sink — but it does mean misconfiguring (passing
`reportWriters: []` while expecting persistence) silently loses violation
detail. Configure at least one writer in production pipelines.

The bundled `FileWriter` and `SparqlUpdateWriter` already implement the
`Writer` contract; bring your own for custom destinations.

#### Filesystem collisions with `FileWriter`

`FileWriter` derives its filename from `dataset.iri` only. If the pipeline's
main writer and a report writer both target the same `outputDir` with the
same format, they will collide on the same path and the second open will
truncate the first. Use a separate `outputDir` for validation reports:

```ts
new ShaclValidator({
  shapesFile,
  reportWriters: [new FileWriter({ outputDir: './output/validation' })],
});
```

#### Named graphs with `SparqlUpdateWriter`

`SparqlUpdateWriter` uses `dataset.iri.toString()` as the named graph URI on
every write, with no per-call override. A report writer that shares the
endpoint with the pipeline's main writer would land the SHACL report in the
same graph as the dataset's data — and `CLEAR GRAPH` on first write per
dataset would erase it. To keep validation results in a separate graph,
either point the report writer at a different repository/endpoint, or
implement a small wrapper `Writer` that swaps `dataset.iri` for a derived
report-graph IRI before delegating.
