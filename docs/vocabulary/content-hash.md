# Content hash vocabulary

Namespace: `https://w3id.org/lde/content-hash#` · [Turtle](https://ldelements.org/vocabulary/content-hash.ttl)

Bookkeeping that [@lde/change-detection](/reference/change-detection) stores with a written RDF document, so a writer can tell whether the document changed since its last write. You may find these triples in published data, next to the document they describe. They mean nothing about the document’s subject itself.

## contentHash {#contentHash}

`https://w3id.org/lde/content-hash#contentHash`

A fingerprint of this document as it was written: the hashing method, a colon, and the digest, for example `rdfc10-sha256:9f86d0…`. The digest is taken over the document’s [RDFC-1.0](https://www.w3.org/TR/rdf-canon/) canonical N-Quads, without the content hash triples themselves.

It is not a checksum of any source the document was converted from, nor of a distribution’s file bytes (for that, DCAT uses `spdx:checksum`).

## hashVersion {#hashVersion}

`https://w3id.org/lde/content-hash#hashVersion`

The writer’s own conversion or pipeline version at the time the content hash was taken. Writers compare it for equality only: a different version means the writer’s conversion changed, so the written content may differ although its source didn’t.
