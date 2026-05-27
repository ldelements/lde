# @lde/pipeline-shacl-sampler

Per-class sampling stages for [`@lde/pipeline`](../pipeline),
derived from SHACL shapes.

Given a SHACL shapes file, this package builds one
[`Stage`](../pipeline/src/stage.ts) per `sh:targetClass`. Each stage
pairs an [`ItemSelector`](../pipeline/src/sparql/selector.ts) that picks
N instances of the target class from the distribution’s SPARQL endpoint
with a CONSTRUCT executor that, for every path chain the SHACL declares
(walked recursively through `sh:node`, `sh:class`,
`sh:qualifiedValueShape`, and `sh:or` branches, stopping at leaf
constraints or shape cycles), pulls in the triples reachable along that
chain’s terminal node. The resulting quads are a sample subgraph rich
enough for
[`@lde/pipeline-shacl-validator`](../pipeline-shacl-validator) to
validate without false-positive ‘missing nested node’ violations.

## Usage

```typescript
import { Pipeline, FileWriter } from '@lde/pipeline';
import { shaclSampleStages } from '@lde/pipeline-shacl-sampler';
import { ShaclValidator } from '@lde/pipeline-shacl-validator';

const shapesFile = 'https://docs.nde.nl/schema-profile/shacl.ttl';
const validator = new ShaclValidator({
  shapesFile,
  reportWriters: [new FileWriter({ outputDir: './validation', format: 'turtle' })],
});

const stages = await shaclSampleStages({
  shapesFile,
  samplesPerClass: 50,
  validator,
});

await new Pipeline({ /* … */, stages }).run();
```

## Options

| Option             | Default           | Description                                                                                                                                            |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shapesFile`       | —                 | URL or local path to the SHACL shapes file. Any format `rdf-dereference` accepts.                                                                      |
| `samplesPerClass`  | `50`              | Number of top-level resources to sample per `sh:targetClass`.                                                                                          |
| `timeout`          | `60000`           | SPARQL query timeout in milliseconds.                                                                                                                  |
| `batchSize`        | `samplesPerClass` | Maximum sampled subjects per executor call. Lower values spread work across multiple parallel queries.                                                 |
| `maxConcurrency`   | `10`              | Maximum concurrent in-flight executor batches per stage.                                                                                               |
| `validator`        | —                 | Optional [`Validator`](../pipeline/src/validator.ts) attached to every generated stage (typically a `ShaclValidator`).                                 |
| `onInvalid`        | `'write'`         | Behaviour when a sampled batch fails validation: `'write'` \| `'skip'` \| `'halt'`. Only used when `validator` is set.                                 |
| `namespaceAliases` | `[]`              | Namespaces to treat as equivalent when matching `sh:targetClass` and when handing quads to the validator. See [Namespace aliases](#namespace-aliases). |

## Namespace aliases

Some vocabularies publish the same terms under multiple namespaces — most
notably schema.org, which is reachable at both `http://schema.org/` and
`https://schema.org/`. SHACL shapes can only declare one of those as the
`sh:targetClass` namespace, so without help the sampler would silently
skip resources typed under the other form, and the validator would
report vacuously-conformant runs against datasets that mix the two.

`namespaceAliases` closes the gap. For every declared pair the sampler:

- broadens its subject-selection SELECT to `?s a ?type . FILTER(?type IN
(<canonical/X>, <alias/X>))`, so instances typed under either
  namespace are picked up;
- decorates the configured `validator` so any alias-namespace IRI in
  the sampled quads is rewritten to the canonical form before the SHACL
  engine sees it, allowing the canonical-namespace
  `sh:targetClass` / `sh:path` patterns to match.

Defaults to no aliases. To cover schema.org datasets that publish under
both HTTP and HTTPS:

```ts
const stages = await shaclSampleStages({
  shapesFile,
  validator,
  namespaceAliases: [
    { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
  ],
});
```

## Limitations

- Only plain-IRI `sh:path` values are supported. Sequence, alternative
  and inverse paths throw at extraction time.
- `sh:targetClass` is the only target form recognised; `sh:targetNode`,
  `sh:targetSubjectsOf`, `sh:targetObjectsOf` and `sh:sparqlTarget` are
  not yet supported.

## Related work

### `extract-cbd-shape`

The TREEcg / W3C TREE-incubation
[`extract-cbd-shape`](https://github.com/TREEcg/extract-cbd-shape)
library implements a per-entity walk over an in-memory `RdfStore`,
falling back to an HTTP dereference of the focus node whenever a
required path is missing from the local store. It is the right tool
for streaming hypermedia consumers (e.g. LDES clients) that already
hold a current context and can fetch more of it over HTTP.

It is the wrong tool for this package’s setting. We assemble sample
subgraphs against a remote SPARQL endpoint with millions of triples;
the per-entity round-trip pattern would issue _N samples × M target
classes_ dereferences per dataset and assumes content-negotiable
entity IRIs that resolve to RDF — rarely true for the cultural
heritage datasets this package was built for.

### SHACL2SPARQL

The Corman, Reutter & Savković 2019
[translation](https://link.springer.com/chapter/10.1007/978-3-030-30796-7_27)
of SHACL constraints to SPARQL targets validation, not sample
subgraph extraction. No production JavaScript implementation exists.

### Why batch CONSTRUCT per `sh:targetClass`

For each top-level shape, this package emits one `Stage` whose
CONSTRUCT executor receives a batch of sampled subjects and walks
every path chain the SHACL declares server-side. A capable SPARQL
endpoint (e.g. QLever) evaluates the property-path UNIONs in a
single round-trip per batch, regardless of chain count. The
alternative — extracting per entity in the client — would multiply
round-trips by the sample size.
