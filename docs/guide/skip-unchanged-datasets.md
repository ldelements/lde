# Skip unchanged datasets

A pipeline that runs on a schedule wastes most of its time reprocessing datasets that haven’t changed. This guide shows how to give the pipeline a per-dataset memory – a **provenance store** – so a run skips datasets whose source and pipeline are both unchanged.

## Configure a provenance store

Skipping is opt-in: pass a `provenanceStore` and a `pipelineVersion` to the `Pipeline`. For pipelines that run without a triplestore, `FileProvenanceStore` persists records to a single JSON file:

```typescript
import { FileProvenanceStore, Pipeline } from '@lde/pipeline';

const pipeline = new Pipeline({
  // …
  provenanceStore: new FileProvenanceStore({
    path: './state/provenance.json',
  }),
  pipelineVersion: 'v3',
});
```

The file must sit on a durable volume so it survives across runs, and is safe for a single writer only – concurrent pipeline processes writing the same file lose each other’s updates. Its directory must be writable by the user the pipeline runs as: the pipeline probes this with a real write at the start of the run, so a read-only or root-owned mount fails loudly instead of silently disabling skipping.

## How the skip decision works

For each dataset the pipeline probes its distributions, derives a **source-change fingerprint** – no body download – reads the stored record, and skips **before paying the import cost** when both change fields match:

```
skip iff  recorded.sourceFingerprint === current.sourceFingerprint
     AND  recorded.pipelineVersion   === current.pipelineVersion
```

The fingerprint combines two signals:

- **Modification date**: the most recent of the dataset description’s declared `dct:modified` and the artifact’s HTTP `Last-Modified` collected by the probe. Taking the maximum keeps a stale declared date from masking a newer upload – publishers routinely leave `dct:modified` behind – erring toward reprocessing rather than serving stale output.
- **Byte size**: the probe’s `Content-Length`, falling back to the declared `dcat:byteSize`.

A live SPARQL endpoint exposes neither signal, so endpoint-backed datasets are always reprocessed; the same goes for a data dump whose probe yields no usable date or size. Malformed metadata – an unparseable date, a non-numeric length – is treated as absent rather than corrupting the fingerprint.

The downloader reuses the same modification date as its change signal: a cached dump file at least as new as that date is not downloaded again. The skip layer and the download layer agree by construction, so there is no separate cache state to store or invalidate.

A dataset that **failed** but whose source is unchanged is recorded as `'failed'` and skipped on later runs, so a deterministically failing import is not retried every run.

## Rotate the pipeline version when output changes

`pipelineVersion` is yours and opaque to LDE: rotate it only on releases that change the pipeline’s output. After a rotation, every dataset reprocesses on the next run. The option is required when a `provenanceStore` is configured – a skip-enabled pipeline without a version would silently freeze its output.

## Use a triplestore-backed store

When your pipeline output is bulk-loaded into a read-only triplestore (e.g. [QLever](https://github.com/ad-freiburg/qlever)), use `FileLoadedSparqlProvenanceStore` instead – a _SPARQL_ store whose contents are _file-loaded_: it reads records through SPARQL queries against the live endpoint and writes them as [PROV-O](https://www.w3.org/TR/prov-o/) N-Quads files to be bulk-loaded together with the next run’s output:

```typescript
import { FileLoadedSparqlProvenanceStore } from '@lde/pipeline';

const store = new FileLoadedSparqlProvenanceStore({
  queryEndpoint: new URL('http://localhost:7001/sparql'),
  pipelineIri: new URL('https://example.org/pipelines/my-pipeline'),
  outputDir: './provenance',
});
```

Records are scoped by `pipelineIri` (used as the named graph), so multiple pipelines can share one triplestore without colliding. Because the endpoint is read-only, a run’s records take effect only after the next bulk-load into the triplestore – until then, the skip decision still reads the previously loaded records. See the [@lde/pipeline README](../reference/pipeline#provenance-store) for the full details.
