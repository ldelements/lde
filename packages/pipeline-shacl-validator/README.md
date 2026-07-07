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
  SparqlConstructReader,
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
      readers: new SparqlConstructReader({ query: '...' }),
      validation: {
        validator,
        onInvalid: 'write', // 'write' | 'skip' | 'halt'
      },
    }),
  ],
});

await pipeline.run();
```

### Severity and conformance (`conformanceDisallows`)

By default, a result of _any_ severity (`sh:Violation`, `sh:Warning` or
`sh:Info`) makes validation fail. This matches the
[SHACL 1.2 default conformance-disallow set](https://www.w3.org/TR/shacl12-core/#conformanceDisallows).

To fail on selected severities only (e.g. treat warnings and info as advisory,
as SHOULD-level findings usually are) pass the set of severity IRIs that
disallow conformance:

```typescript
import { ShaclValidator, severity } from '@lde/pipeline-shacl-validator';

const validator = new ShaclValidator({
  shapesFile: './shapes.ttl',
  conformanceDisallows: [severity.violation],
});
```

Results outside the set are still reported; they just no longer flip `conforms`
to `false` or count towards `violations`. Custom severity IRIs (allowed by SHACL
1.2) work too.

When the option is set, the written report stays self-describing per SHACL 1.2:
its `sh:conforms` reflects the configured set, and the set itself is declared on
the report via `sh:conformanceDisallows`.

### `onInvalid` options

| Value     | Behaviour                                                        |
| --------- | ---------------------------------------------------------------- |
| `'write'` | Write quads to the output even if validation fails **(default)** |
| `'skip'`  | Discard invalid quads silently                                   |
| `'halt'`  | Throw an error, stopping the pipeline                            |

### Report writers

Each `validate()` call that produces validation results (of any severity,
whether or not they fail conformance) fans the SHACL report quads
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

##### Blank-node-free reports

shacl-engine emits the `sh:ValidationReport`, every `sh:ValidationResult` and
any anonymous `sh:sourceShape` as blank nodes. Before writing, `ShaclValidator`
rewrites each one to a dataset-scoped IRI of the form
`<dataset>/.well-known/shacl#<batch>-<label>`. This keeps a file-based served
store (e.g. the Dataset Knowledge Graph) from fusing one dataset's results into
another's when it `cat`s every per-dataset n-quads file into a single index –
blank-node labels are only document-scoped and recur across files (see
[ldelements/lde#478](https://github.com/ldelements/lde/issues/478)). The
dataset IRI rules out fusion across datasets; `<batch>`, a hash of the report's
quads, rules out fusion across the separate `validate()` batches that land in
one dataset's validation graph.

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

`SparqlUpdateWriter` defaults to `dataset.iri.toString()` as the named graph
URI. A report writer that shares the endpoint with the pipeline's main
writer would otherwise land the SHACL report in the same graph as the
dataset's data — and `CLEAR GRAPH` on first write per dataset would erase
it. To keep validation results in a separate graph, pass `graphIri` to
derive the target graph from the dataset:

```ts
new SparqlUpdateWriter({
  endpoint,
  auth,
  graphIri: (dataset) =>
    new URL(
      `https://example.org/shacl-validation/${encodeURIComponent(dataset.iri.toString())}`,
    ),
});
```
