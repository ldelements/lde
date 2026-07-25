# What is LDE?

LDE (Linked Data Elements) is an open-source toolkit of composable building blocks for working with Linked Data in Node.js. It covers the full Linked Data lifecycle – from discovery and ingestion through transformation to publication.

Every organization working with Linked Data ends up building the same infrastructure from scratch: endpoint management, data import, transformation pipelines, dataset discovery. LDE provides those pieces as small packages that you compose into your own applications and pipelines.

Ready to try it? Head to [Build a pipeline](./build-a-pipeline).

## Design principles

**SPARQL-native.** Data transformations are expressed as plain SPARQL queries: portable, transparent, testable, version-controlled and free of vendor lock-in. TypeScript handles only the parts that are hard to express in SPARQL alone.

**Composable.** Each package does one thing; the interfaces between them (selectors, resolvers, readers, writers, validators, reporters) are small and pluggable, so you can swap any part for your own implementation.

**Bounded memory.** LDE processes data it cannot hold. Memory is always bounded by a configured unit of work (`batchSize`, `capacity`, …), never by the size of the input – see [ADR 12](../decisions/0012-bound-memory-by-the-unit-of-work-not-the-input).

**Standards-based.** DCAT-AP 3.0 for discovery, SPARQL 1.1 for transformation, SHACL for validation, VoID for statistics, RDF/JS as the internal data model – see the [standards reference](../reference/#standards).

## How the documentation is organized

- The **Guide** opens with introduction pages like this one, [core concepts](./core-concepts) and the [architecture](./architecture); then come two hands-on tutorials – [build a pipeline](./build-a-pipeline) and [build a search API](./build-a-search-api) – and goal-oriented how-to recipes for specific tasks.
- The **Reference** describes the [packages](../reference/packages), the standards they implement, and the architecture decision records documenting each significant design choice and its rationale.
