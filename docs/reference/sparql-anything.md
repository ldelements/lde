# @lde/sparql-anything

Convert tabular and other non-RDF sources to RDF with the [SPARQL Anything](https://sparql-anything.cc) CLI.

## Installation

```sh
npm install @lde/sparql-anything
```

## `SparqlAnythingConverter`

The converter runs the SPARQL Anything jar **once per input chunk** to bound memory use, then concatenates the per-chunk N-Triples outputs into a single file. Processes are spawned through a [`@lde/task-runner`](./task-runner), so the same converter works on the host, in Docker, or anywhere else a `TaskRunner` is implemented.

```typescript
import { SparqlAnythingConverter } from '@lde/sparql-anything';
import { NativeTaskRunner } from '@lde/task-runner-native';

const converter = new SparqlAnythingConverter({
  queryFile: 'config/places.rq', // CONSTRUCT query; `{SOURCE}` is replaced per chunk
  jarPath: 'bin/sparql-anything.jar',
  load: 'data/reference.ttl', // optional; loaded into the default graph via --load
  taskRunner: new NativeTaskRunner(),
});

await converter.convert(
  ['data/geonames_aa.csv', 'data/geonames_ab.csv'],
  'output/geonames.nt',
);
```

### Options

| Option       | Type               | Description                                                                         |
| ------------ | ------------------ | ----------------------------------------------------------------------------------- |
| `queryFile`  | `string`           | Path to the SPARQL CONSTRUCT query. The literal `{SOURCE}` is replaced per chunk    |
| `jarPath`    | `string`           | Path to the SPARQL Anything CLI jar                                                 |
| `load`       | `string`           | Optional path passed to `--load`; see [Loading existing RDF](#loading-existing-rdf) |
| `taskRunner` | `TaskRunner<Task>` | Runs the SPARQL Anything process for each chunk                                     |

### Loading existing RDF

`load` is optional. Pass it to combine the converted data with RDF you already have – a lookup table the query joins against, for instance. SPARQL Anything reads a **file** into the default graph, and a **directory** as one named graph per RDF file it holds, so the two are not interchangeable. Leave `load` unset and no `--load` is passed at all.

## How a conversion runs

For each chunk, the converter:

1. Replaces the literal `{SOURCE}` in the query file with the chunk’s path and writes the result to a temporary `.rq` file.
2. Runs `java -jar <jar> -q <query> [--load <load>] --format NT --output <chunk>.nt`.
3. Waits for the process; a non-zero exit **aborts the whole conversion** so a crashed chunk can never be silently dropped from the output.
4. Checks that the chunk’s output is not empty. SPARQL Anything exits successfully when it cannot read or parse an input – it logs the problem and writes nothing – so an empty or missing output **aborts the conversion** too.

Finally, the per-chunk `.nt` files are concatenated, in the order the chunks were given, into the output path. The concatenation streams, so multi-gigabyte outputs do not have to fit in memory. N-Triples has no prefixes or document structure, so concatenating per-chunk files always yields a single valid document.
