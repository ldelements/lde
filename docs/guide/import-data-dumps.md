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
