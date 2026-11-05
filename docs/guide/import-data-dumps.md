# Import data dumps for missing or unreliable endpoints

Many registered datasets publish no SPARQL endpoint, or one that fails under heavy aggregate queries. This guide shows how to wrap the pipeline’s [distribution resolver](../reference/pipeline#distribution-resolver) in an `ImportResolver`, so such datasets are imported from their data dumps into a local [QLever](https://github.com/ad-freiburg/qlever) server and processed there.

## Create the QLever importer and server

`createQlever()` returns a paired importer and server that share one task runner, so the server serves the index the importer built:

```typescript
import { createQlever } from '@lde/sparql-qlever';

const { importer, server } = createQlever({
  mode: 'docker',
  image: 'adfreiburg/qlever:latest',
  dataDir: './data',
});
```

`dataDir` stores downloaded dumps and the index; the server listens on port 7001 by default. Downloads and index builds are cached, so an unchanged dump is not re-imported on the next run. Use `indexOptions` and `serverOptions` to tune memory and timeouts – see the [@lde/sparql-qlever reference](../reference/sparql-qlever#configuration).

## Wrap the resolver

Wrap `SparqlDistributionResolver` – which probes a dataset’s own endpoint but never imports – in an `ImportResolver` carrying the importer and server:

```typescript
import {
  ImportResolver,
  Pipeline,
  SparqlDistributionResolver,
} from '@lde/pipeline';

const pipeline = new Pipeline({
  // …
  distributionResolver: new ImportResolver(new SparqlDistributionResolver(), {
    importer,
    server,
    strategy: 'sparqlWithImportFallback',
  }),
});
```

The pipeline calls the resolver’s `cleanup()` after each dataset – not once at the end of the run – so the local server is stopped per dataset and restarted when a later dataset needs an import.

## Choose a strategy

`strategy` controls how eagerly a dump is imported:

- `'sparql'` (default) – use the dataset’s own endpoint when one responds; import a dump only when none does.
- `'sparqlWithImportFallback'` – like `'sparql'`, but when a probed endpoint later fails a stage at runtime, discard the partial output and re-run all stages against the imported dump.
- `'import'` – always import the dump, even when a working endpoint is advertised.

Pick `'sparqlWithImportFallback'` when endpoints exist but are unreliable for heavy queries, and `'import'` when you trust dumps more than endpoints outright. See the [distribution resolver reference](../reference/pipeline#distribution-resolver) for the full semantics.

## Import a local file

A dump can also come from a file on this machine, with no registration. `DirectorySelector` selects one dataset per RDF file in a directory, and `Dataset.localFile()` creates one for a single file. Both derive the format from the extension and use the file’s URL as the dataset’s IRI; the rest of the setup above stays the same:

```typescript
import { Dataset } from '@lde/dataset';
import { DirectorySelector } from '@lde/pipeline';

const selector = new DirectorySelector('./rdf');
const dataset = Dataset.localFile('./rdf/catalog.ttl');
```

Moving the file makes it a different dataset. For an IRI that survives a move, pass your own:

```typescript
import { Dataset, Distribution } from '@lde/dataset';

const dataset = new Dataset({
  iri: new URL('https://example.org/dataset/catalog'),
  distributions: [Distribution.localFile('./rdf/catalog.ttl')],
});
```

An IRI other than a `file:` URL counts as registered: a stage sourced with `registrySource` reads that dataset’s description from the register, not from the file. Only use your own IRI with registry-sourced types when the register has the dataset.

The importer copies the file into `dataDir` and keeps that copy while the file is unchanged. Only `Distribution.localFile()`, which `Dataset.localFile()` calls, grants access to the filesystem: a `file:` URL from a registry stays unreachable, as [ADR 31](../decisions/0031-import-local-files-through-the-data-dump-path) explains.
