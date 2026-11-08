# @lde/change-detection

Tell whether an RDF document changed since its last write, so a writer can skip the unchanged ones. The hash is stored with the document, as two triples on its IRI, in the same update.

## Installation

```sh
npm install @lde/change-detection
```

```ts
import {
  detectChange,
  SparqlContentHashReader,
  withContentHash,
} from '@lde/change-detection';

const hashes = new SparqlContentHashReader({ endpoint });
const previous = (await hashes.read([iri])).get(iri.value);
const { status, hash } = await detectChange(document, previous, 'conversion-1');
if (status !== 'unchanged') {
  await store.write(withContentHash(document, iri, hash));
}
```

## Documentation

See the [full documentation](https://ldelements.org/reference/change-detection).
