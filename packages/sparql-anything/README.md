# SPARQL Anything

Convert tabular and other non-RDF sources to RDF with the [SPARQL Anything](https://sparql-anything.cc) CLI.

The `SparqlAnythingConverter` runs the SPARQL Anything jar **once per input chunk** to bound memory use, then concatenates the per-chunk N-Triples outputs into a single file. Processes are spawned through an [`@lde/task-runner`](../task-runner), so the same converter works on the host, in Docker, or anywhere else a `TaskRunner` is implemented.

## Usage

```typescript
import { SparqlAnythingConverter } from '@lde/sparql-anything';
import { NativeTaskRunner } from '@lde/task-runner-native';

const converter = new SparqlAnythingConverter({
  queryFile: 'config/places.rq', // CONSTRUCT query; `{SOURCE}` is replaced per chunk
  jarPath: 'bin/sparql-anything.jar',
  adminCodesFile: 'data/admin-codes.ttl', // loaded into the default graph via --load
  taskRunner: new NativeTaskRunner(),
});

await converter.convert(
  ['data/geonames_aa.csv', 'data/geonames_ab.csv'],
  'output/geonames.nt',
);
```

For each chunk, the converter:

1. Replaces the literal `{SOURCE}` in the query file with the chunk's path and writes the result to a temporary `.rq` file.
2. Runs `java -jar <jar> -q <query> --load <adminCodesFile> --format NT --output <chunk>.nt`.
3. Waits for the process; a non-zero exit **aborts the whole conversion** so a crashed chunk can never be silently dropped from the output.

Finally, the per-chunk `.nt` files are concatenated, in the order the chunks were given, into the output path. The concatenation streams, so multi-gigabyte outputs do not have to fit in memory. N-Triples has no prefixes or document structure, so concatenating per-chunk files always yields a single valid document.

## Options

| Option           | Type               | Description                                                                      |
| ---------------- | ------------------ | -------------------------------------------------------------------------------- |
| `queryFile`      | `string`           | Path to the SPARQL CONSTRUCT query. The literal `{SOURCE}` is replaced per chunk |
| `jarPath`        | `string`           | Path to the SPARQL Anything CLI jar                                              |
| `adminCodesFile` | `string`           | Path to the Turtle file loaded into the default graph (`--load`)                 |
| `taskRunner`     | `TaskRunner<Task>` | Runs the SPARQL Anything process for each chunk                                  |

## Chunking

The converter consumes pre-split chunk files; it does not split sources itself. Producing the chunks (and the `adminCodesFile`) is the caller's responsibility.
