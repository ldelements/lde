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

For each dataset the pipeline probes its distributions, derives a **source-change fingerprint** from metadata the probe already collected (modification date and byte size – no body download), reads the stored record, and skips **before paying the import cost** when both change fields match:

```
skip iff  recorded.sourceFingerprint === current.sourceFingerprint
     AND  recorded.pipelineVersion   === current.pipelineVersion
```

A live SPARQL endpoint yields no fingerprint, so endpoint-backed datasets are always reprocessed. A dataset that **failed** but whose source is unchanged is recorded as `'failed'` and skipped on later runs, so a deterministically failing import is not retried every run.

## Rotate the pipeline version when output changes

`pipelineVersion` is yours and opaque to LDE: rotate it only on releases that change the pipeline’s output. After a rotation, every dataset reprocesses on the next run. The option is required when a `provenanceStore` is configured – a skip-enabled pipeline without a version would silently freeze its output.

## Use a triplestore-backed store

When your pipeline output is bulk-loaded into a read-only triplestore (e.g. [QLever](https://github.com/ad-freiburg/qlever)), use `FileLoadedSparqlProvenanceStore` instead: it reads records through SPARQL queries against the live endpoint and writes them as [PROV-O](https://www.w3.org/TR/prov-o/) N-Quads files to be bulk-loaded together with the next run’s output:

```typescript
import { FileLoadedSparqlProvenanceStore } from '@lde/pipeline';

const store = new FileLoadedSparqlProvenanceStore({
  queryEndpoint: new URL('http://localhost:7001/sparql'),
  pipelineIri: new URL('https://example.org/pipelines/my-pipeline'),
  outputDir: './provenance',
});
```

Records are scoped by `pipelineIri` (used as the named graph), so multiple pipelines can share one triplestore without colliding. Because the endpoint is read-only, a run’s records take effect only after the next bulk-load into the triplestore – until then, the skip decision still reads the previously loaded records. See the [@lde/pipeline README](../reference/pipeline#provenance-store) for the full details.
