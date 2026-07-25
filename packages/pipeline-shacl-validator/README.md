# @lde/pipeline-shacl-validator

SHACL validation for [`@lde/pipeline`](../pipeline).

Validates RDF quads produced by pipeline stages against [SHACL shapes](https://www.w3.org/TR/shacl/),
streaming the per-dataset SHACL validation report to any number of configured
[`Writer`](../pipeline/src/writer/writer.ts)s. Shapes can be provided in any
RDF serialization (Turtle, JSON-LD, N-Triples etc.).

## Installation

```sh
npm install @lde/pipeline-shacl-validator
```

## Documentation

See the [full documentation](https://ldelements.org/reference/pipeline-shacl-validator).
