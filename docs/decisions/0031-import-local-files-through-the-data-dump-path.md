# 31. Import local files through the data dump path

Date: 2026-10-30

## Status

Proposed

## Context

The search indexer and the other pipelines read a dataset over SPARQL, from its
own endpoint or from a dump imported into QLever. A dataset that exists only as
an RDF file on the machine has no way in: `fetch` rejects a `file:` URL, so both
the probe and the downloader fail on it.

[#12](https://github.com/ldelements/lde/issues/12) left open where such a file
should go: QLever, Oxigraph, or an in-memory store such as rdf-stores.

A dataset’s distributions usually come from a registry, which holds what
third parties submitted. If `file:` URLs simply started working, a registered
distribution pointing at `file:///etc/passwd` would be copied and indexed into a
public search collection.

A registry is also how LDE expects datasets to be selected and described. A local
file must work without a registration, yet must not become a second place to
describe datasets. The motivating case: index five datasets from the register plus
one or two that are not registered yet, all in one search.

## Decision

**Import local files into QLever, through the path data dumps already take.**

- In-memory is ruled out by
  [ADR 12](./0012-bound-memory-by-the-unit-of-work-not-the-input.md): the store
  would hold the whole input.
- Oxigraph would add a second importer and server for the same job. It would give
  us nothing a file needs that QLever lacks, and QLever already runs in both
  indexer deployment modes.

**A distribution reads the filesystem only when it was created with
`Distribution.localFile(path)`.** The factory sets the read-only `localPath`, and
the probe and `LastModifiedDownloader` act on that property, never on the URL
scheme. A registry client only ever calls the constructor, so a registered
`file:` URL fails as it did before.

**A run names local data beside registered datasets, in `DATASETS`.** A `file:`
URL is a dataset’s IRI like any other entry, so a run’s selection stays one list,
and the deletion sweep keeps everything on it. `CombinedSelector` reads the
registry first and then the local entries: `Dataset.localFile(path)` for a file,
`DirectorySelector` for a URL ending in `/`. The registry stays the default, and
local data enters a run only when an operator names it.

**A local dataset has no registration, so it reads its own file.** `registrySource`
returns the own distribution of a dataset whose IRI is a `file:` URL, which means
a type in `REGISTRY_ROOT_TYPES` indexes whatever the file says about itself. The
IRI decides, not where the data comes from: a registered dataset whose dump
happens to be local still reads its description from the register. A dataset that
needs a curated description or a stable identity gets registered.

**The probe answers for a local file in the shape of an HTTP response**, with the
file’s size and modification date. `ImportResolver`, content validation, the
source fingerprint and provenance therefore need no second path.

**The downloader copies the file into its base directory**, because that is the
only directory a containerized QLever has mounted. The copy is named after a hash
of the source path, so two files never share one, and is streamed rather than
copied with the source’s mode, so a read-only or private source still leaves a
copy that can be replaced and read. It keeps a copy with the same size that is at
least as new as the source, which keeps QLever’s index of it valid.

We rejected:

- An opt-in `LocalFileDistributionResolver` paired with a `LocalFileDownloader`.
  It was also fail-closed, but the two work only together, so every caller would
  have to know to wire both. A flag on the probe and on `createQlever` had the
  same problem and would have failed open once set.
- A `DATASET_FILES` variable. It adds a second list beside `DATASETS`, where a
  `file:` URL already fits the first.
- `REGISTRY_ENDPOINT=file:///rdf/`, a directory acting as the registry. It reads
  well, but a run can then use only the directory, so registered and local datasets
  would need separate collections, and a type in the search API reads from one.
- Mapping registered dataset IRIs to files. It keeps every dataset registered, but
  a local file should work without a registration.
- A local JSON-LD catalogue. Nothing on the indexing path reads a dataset’s
  description, so users would write a file that today buys only their own IRIs,
  and descriptions would have two homes.

## Consequences

- A run removes every dataset it did not select, so everything a collection should
  hold must be on one list. A run of local data alone deletes a registry run’s
  documents from the same collections unless it has its own `COLLECTION_PREFIX`.
  This is documented rather than enforced, because a Typesense instance holding
  only local data should work without one.
- `DATASET_CRITERIA` cannot be combined with local data, so “everything matching
  these criteria plus two files” is not expressible.
- A dataset’s IRI follows the file’s path, so moving a file makes it a different
  dataset, and registering it later changes its IRI.
- Each file is stored twice, plus its index. A hard link would avoid that only
  within one filesystem, and a mounted volume usually is not one.
- A change is detected from size and modification time, and the fingerprint has
  one-second precision, as `Last-Modified` does. An edit that keeps the size
  within the same second goes unnoticed.
- A same-size replacement with an older modification time also goes unnoticed by
  the downloader. A replacement with a different size is copied, whatever its
  date.
- A dataset split over several files must be merged or zipped first. Importers
  treat a dataset’s distributions as alternatives, and changing that is a separate
  decision.
- The pipeline’s console report prints `HTTP 200` for a local file, because the
  probe result has the shape of an HTTP response.
- `Distribution.localFile` trusts its caller, so a deployment must not pass it
  paths taken from third parties.
