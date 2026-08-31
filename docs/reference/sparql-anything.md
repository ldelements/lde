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
  workDir: 'data', // the task runner's working directory
  load: 'data/reference.ttl', // optional; loaded into the default graph via --load
  taskRunner: new NativeTaskRunner({ cwd: 'data' }),
});

await converter.convert(
  ['data/geonames_aa.csv', 'data/geonames_ab.csv'],
  'output/geonames.nt',
);
```

### Options

| Option       | Type               | Description                                                                                    |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------- |
| `queryFile`  | `string`           | Path to the SPARQL CONSTRUCT query. The literal `{SOURCE}` is replaced per chunk               |
| `jarPath`    | `string`           | Path to the SPARQL Anything CLI jar, as the task runner sees it                                |
| `workDir`    | `string`           | The task runner's working directory; see [Where files are written](#where-files-are-written)   |
| `load`       | `string`           | Optional path passed to `--load`; see [Loading existing RDF](#loading-existing-rdf)            |
| `heap`       | `string`           | Maximum JVM heap per chunk process, as `-Xmx` takes it (default `'2g'`); see [Memory](#memory) |
| `cliArgs`    | `string[]`         | Further arguments for the SPARQL Anything CLI; see [Memory](#memory)                           |
| `taskRunner` | `TaskRunner<Task>` | Runs the SPARQL Anything process for each chunk                                                |

### Where files are written

`workDir` is the task runner's working directory – `cwd` for a `NativeTaskRunner`, `mountDir` for a `DockerTaskRunner`. The converter writes its generated query files and per-chunk outputs into a fresh subdirectory there and removes it when the conversion ends, then refers to them by a path relative to `workDir`, so the identical command works on the host and inside a container.

Per-run directories matter for more than tidiness: a chunk output left over from an earlier run would satisfy the non-empty check below with stale triples.

`jarPath`, `load` and the chunk paths are passed through as given, because only the caller knows how the runner sees them – in a container the jar usually lives in the image, while the chunks have to be under the mount.

### Loading existing RDF

`load` is optional. Pass it to combine the converted data with RDF you already have – a lookup table the query joins against, for instance. SPARQL Anything reads a **file** into the default graph, and a **directory** as one named graph per RDF file it holds, so the two are not interchangeable. Leave `load` unset and no `--load` is passed at all.

### Memory

One process per chunk bounds how much has to be held at once, but only together with a heap cap: SPARQL Anything materialises a chunk's whole result graph before writing it, and a JVM with no `-Xmx` helps itself to a quarter of host memory. There is therefore always a cap, `2g` unless you raise it:

```typescript
heap: '4g', // -Xmx4g
```

Size it with the chunk size. A chunk that outgrows the heap fails loudly – the JVM's `OutOfMemoryError` arrives in the output of a non-zero exit, which aborts the conversion – where an uncapped JVM instead grows until the OOM killer takes the whole container.

`cliArgs` is the escape hatch for CLI flags the converter does not model itself, appended to the arguments it sets. It cannot repeat those: `-q`, `-f`, `-o` and `-l` are rejected, because the converter reads back the `--output` it named, in the `--format` it asked for – overriding either leaves it reporting an empty conversion, or concatenating fragments that are not N-Triples. SPARQL Anything documents repetition only for `-v` and `-c`, so a repeated flag has no defined winner to rely on.

## How a conversion runs

For each chunk, the converter:

1. Replaces the literal `{SOURCE}` in the query file with the chunk’s path and writes the result to a temporary `.rq` file.
2. Runs `java -Xmx<heap> -jar <jar> -q <query> [--load <load>] --format NT --output <chunk>.nt [cliArgs]`, with every path quoted, so a space or a shell metacharacter in a filename can neither break the command nor inject into it.
3. Waits for the process; a non-zero exit **aborts the whole conversion** so a crashed chunk can never be silently dropped from the output.
4. Checks that the chunk’s output is not empty. SPARQL Anything exits successfully when it cannot read or parse an input – it logs the problem and writes nothing – so an empty or missing output **aborts the conversion** too.

Converting an empty list of chunks is an error rather than an empty output: a chunking step that produced nothing has already failed.

Finally, the per-chunk `.nt` files are concatenated, in the order the chunks were given, into the output path. The concatenation streams, so multi-gigabyte outputs do not have to fit in memory. N-Triples has no prefixes or document structure, so concatenating per-chunk files always yields a single valid document.
