# @lde/change-detection

Tell whether an RDF document changed since its last write, so a writer can skip the unchanged ones.

A writer that rewrites every document on every run pays for it in its store. On QLever, for instance, each `CLEAR GRAPH` + `INSERT DATA` lands in the update overlay until the next rebuild, whether the document changed or not. This package hashes each document and tells the caller whether to write it.

## Installation

```sh
npm install @lde/change-detection
```

## Usage

Detection is pure: it does no I/O and reads no clock. The caller reads the stored hash, asks for a status, and writes:

```ts
import {
  detectChange,
  SparqlContentHashReader,
  withContentHash,
} from '@lde/change-detection';

const hashes = new SparqlContentHashReader({ endpoint });

const previous = (await hashes.read([iri])).get(iri.value);
const { status, hash } = await detectChange(document, previous, 'conversion-7');

if (status !== 'unchanged') {
  // The document plus two hash triples, in one update.
  await store.write(withContentHash(document, iri, hash));
}
```

Because the status comes before the write, a caller can act on it for other writes too: skip a derived report, set a change date, or emit an LDES member.

### Statuses

| Status        | Meaning                                                                                                          | Write? |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| `created`     | No hash is stored.                                                                                               | yes    |
| `changed`     | The content differs under the same `version`.                                                                    | yes    |
| `reconverted` | The `version` differs, or the stored hash was taken by another hashing method. The source need not have changed. | yes    |
| `unchanged`   | Content, `version` and hashing method all match.                                                                 | no     |

`version` is the caller’s own conversion or pipeline version, an opaque string compared for equality only. Bump it whenever your conversion output changes. Then a deploy that changes the conversion returns `reconverted` rather than `changed`, so a change date or an LDES stream can tell your change from the source’s. A same-hash document with a new `version` is still written, so the stored version catches up.

One blind spot follows: a source change that lands in the same run as a new `version` is reported as `reconverted` too.

### The hash travels with the document

`withContentHash` returns a copy of the document with two triples on `iri`, in the default graph; your store decides which graph they land in:

```turtle
@prefix ch: <https://w3id.org/lde/content-hash#> .

<iri> ch:contentHash "rdfc10-sha256:9f86d0…" ;
      ch:hashVersion "conversion-7" .
```

Write that copy instead of the document. Then hash and data go out in one update and can’t drift: a failed write leaves the old hash, so the document is seen as changed again next time; an emptied or restored store brings back exactly the hashes that match its data; and deleting a document deletes its hash. Keeping hashes in a separate store or graph would break each of these. A document that is deleted while its hash stays, then listed again unchanged, would never be written back.

The hash is taken over [RDFC-1.0](https://www.w3.org/TR/rdf-canon/) canonical N-Quads, so fresh blank node labels on every parse don’t count as a change. The `ch:` triples are left out of the hash, so a document read back from the store hashes the same as before.

### Values that change on every run

Hash a filtered view, and write the full document. For example, to leave probe timestamps out of a health record and still write it at least every 12 hours:

```ts
const volatile = [lastProbedAt, lastSuccessAt, consecutiveFailures];
const hashed = new Store(
  [...record].filter((quad) => !volatile.some((p) => p.equals(quad.predicate))),
);

const { status, hash } = await detectChange(hashed, previous, version);
if (status !== 'unchanged' || olderThan(probedAt, hours(12))) {
  await store.write(withContentHash(record, iri, hash));
}
```

Filter the same way on every run; if you change the filter, bump `version`.

### Reading hashes

`SparqlContentHashReader.read(iris)` reads the stored hashes of a batch of documents in one query, with an optional `fetch` for authentication or a timeout, from the default graph and every named graph. You choose the batch: pass the IRIs of the documents you are about to write, not every IRI in your store, so the query and the returned `Map` stay as small as that batch. That covers both a named graph per document and one shared graph with a subject per document.

An IRI is missing from the returned `Map` when no hash is stored, and also when more than one distinct hash is (a document written into two graphs). Either way you pass `undefined` to `detectChange` and write the document again. Picking one of the two hashes could report `unchanged` while the other copy is stale.

### Documents that can’t be canonicalized

RDFC-1.0 can blow up on documents with many indistinguishable blank nodes. `detectChange` then throws a `CanonicalizationLimitError`, so a hostile or accidental document can’t hang the caller. Write such a document without a hash; it returns `created` on every run. Any other error is passed through unchanged, so catch only this one:

```ts
const detected = await detectChange(document, previous, version).catch(
  (error: unknown) => {
    if (error instanceof CanonicalizationLimitError) return undefined;
    throw error;
  },
);
```
