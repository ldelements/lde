# @lde/sparql-anything

Convert tabular and other non-RDF sources to RDF with the [SPARQL Anything](https://sparql-anything.cc) CLI.

## Installation

```sh
npm install @lde/sparql-anything
```

## `SparqlAnythingConverter`

The converter runs the SPARQL Anything jar **once per chunk** to bound memory use, then concatenates the resulting N-Triples into a single file. A **job** is a query and the chunks to run it over, so what those processes share is stated once. Processes are spawned through a [`@lde/task-runner`](./task-runner), so the same converter works on the host, in Docker, or anywhere else a `TaskRunner` is implemented.

```typescript
import { SparqlAnythingConverter } from '@lde/sparql-anything';
import { NativeTaskRunner } from '@lde/task-runner-native';

const converter = new SparqlAnythingConverter({
  jarPath: 'bin/sparql-anything.jar',
  workDir: 'data', // the task runner's working directory
  taskRunner: new NativeTaskRunner({ cwd: 'data' }),
});

await converter.convert(
  [
    // One query over many chunks, with reference data loaded alongside it.
    {
      queryFile: 'config/places.rq',
      chunks: ['data/places_aa.csv', 'data/places_ab.csv'],
      load: 'data/reference.ttl',
    },
    // A shorter job of a different shape, in the same call.
    { queryFile: 'config/names.rq', chunks: ['data/names_aa.csv'] },
    // A query that names its own input, so it takes no chunks.
    { queryFile: 'config/ontology.rq', load: 'data/ontology.rdf' },
  ],
  'output/places.nt',
);
```

### Options

| Option        | Type               | Description                                                                                                                   |
| ------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `jarPath`     | `string`           | Path to the SPARQL Anything CLI jar, as the task runner sees it                                                               |
| `workDir`     | `string`           | The task runner's working directory; see [Where files are written](#where-files-are-written)                                  |
| `heap`        | `string`           | Maximum JVM heap per chunk process, as `-Xmx` takes it (default `'2g'`); see [Memory](#memory)                                |
| `cliArgs`     | `string[]`         | Further arguments for the SPARQL Anything CLI; see [Memory](#memory)                                                          |
| `concurrency` | `number`           | How many chunks to convert at once (default `1`); see [Converting several chunks at once](#converting-several-chunks-at-once) |
| `taskRunner`  | `TaskRunner<Task>` | Runs the SPARQL Anything process for each chunk                                                                               |

### Jobs

Each entry passed to `convert()` is one query and the chunks to run it over – one process per chunk, so what those processes share is stated once.

| Field       | Type       | Description                                                                                                          |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `queryFile` | `string`   | Path to the SPARQL CONSTRUCT query to run                                                                            |
| `chunks`    | `string[]` | Paths substituted for the literal `{SOURCE}` in the query, one process each; omit when the query names its own input |
| `load`      | `string`   | Optional path passed to `--load`; see [Loading existing RDF](#loading-existing-rdf)                                  |

A query and its chunks have to agree: a query naming `{SOURCE}` without chunks, or chunks whose query never names `{SOURCE}`, is rejected rather than run – SPARQL Anything would report the first as a parse error and the second not at all. An empty `chunks` array is rejected too: a step that produced none has already failed.

**Jobs of different shapes belong in one call.** They are run by one converter, so a long job's chunks and a short one's pack together instead of draining in phases – and their outputs land in one file, in the order given, without the caller stitching anything together afterwards.

### Where files are written

`workDir` is the task runner's working directory – `cwd` for a `NativeTaskRunner`, `mountDir` for a `DockerTaskRunner`. The converter writes its generated query files and per-process outputs into a fresh subdirectory there and removes it when the conversion ends, then refers to them by a path relative to `workDir`, so the identical command works on the host and inside a container.

Per-run directories matter for more than tidiness: an output left over from an earlier run would satisfy the non-empty check below with stale triples.

`jarPath`, and each job's `load` and `chunks` paths, are passed through as given, because only the caller knows how the runner sees them – in a container the jar usually lives in the image, while the chunks have to be under the mount.

### Loading existing RDF

`load` is optional. Pass it to combine the converted data with RDF you already have – a lookup table the query joins against, for instance. SPARQL Anything reads a **file** into the default graph, and a **directory** as one named graph per RDF file it holds, so the two are not interchangeable. Leave `load` unset and no `--load` is passed at all.

### Memory

One process per chunk bounds how much has to be held at once, but only together with a heap cap: SPARQL Anything materialises a chunk's whole result graph before writing it, and a JVM with no `-Xmx` helps itself to a quarter of host memory. There is therefore always a cap, `2g` unless you raise it:

```typescript
heap: '4g', // -Xmx4g
```

Size it with the chunk size. A chunk that outgrows the heap fails loudly – the JVM's `OutOfMemoryError` arrives in the output of a non-zero exit, which aborts the conversion – where an uncapped JVM instead grows until the OOM killer takes the whole container.

### Converting several chunks at once

`concurrency` is how many chunks are converted at the same time. Each one is a JVM of its own, so it multiplies against `heap`: a run needs `concurrency × heap`, on the machine the **task runner** uses – which is not this process's machine when the runner is Docker or remote.

That is why the default is `1` rather than something derived from the CPU count or a memory limit: the converter cannot see the machine its processes run on, so the number is the caller's to choose. `map.sh` sizes its pool from `nproc` capped by the cgroup limit, budgeting ~3 GB a worker; a caller who knows their deployment can do the same arithmetic and pass the result.

Chunks of every job are converted through one pool, in the order the jobs and their chunks were given – a long job and a short one pack together rather than draining in phases. The output is concatenated in that same order, however the processes happened to finish.

The first failure aborts the run: no further chunk is started, and the processes still going are stopped rather than left writing into a directory the converter is about to delete. A process that cannot be stopped – one that has just exited, say – does not change what is reported: the conversion failure is the one worth reading.

> [!WARNING]
> A `DockerTaskRunner` configured with a `containerName` cannot be used with `concurrency` above one. It force-removes any container of that name before starting a task, so each chunk would destroy the container of the chunk before it. Leave `containerName` unset for a converter that runs chunks in parallel.

`cliArgs` is the escape hatch for CLI flags the converter does not model itself, appended to the arguments it sets. It cannot repeat those: `-q`, `-f`, `-o` and `-l` are rejected, in their long and `--flag=value` forms too, because the converter reads back the `--output` it named, in the `--format` it asked for – overriding either leaves it reporting an empty conversion, or concatenating fragments that are not N-Triples. SPARQL Anything documents repetition only for `-v` and `-c`, so a repeated flag has no defined winner to rely on.

## How a conversion runs

For each chunk – or once, for a job that has none – the converter:

1. Replaces the literal `{SOURCE}` in the job’s query with the chunk’s path and writes the result to a temporary `.rq` file. The query is read once per job, and interpolated per chunk.
2. Runs `java -Xmx<heap> -jar <jar> -q <query> [--load <load>] --format NT --output <chunk>.nt [cliArgs]`, with every path quoted, so a space or a shell metacharacter in a filename can neither break the command nor inject into it.
3. Waits for the process; a non-zero exit **aborts the whole conversion** so a crashed chunk can never be silently dropped from the output.
4. Checks that the output is not empty. SPARQL Anything exits successfully when it cannot read or parse an input – it logs the problem and writes nothing – so an empty or missing output **aborts the conversion** too.

Converting an empty list of jobs is an error rather than an empty output: a step that produced none has already failed.

Finally, the `.nt` files are concatenated, in the order the jobs and their chunks were given, into the output path. The concatenation streams, so multi-gigabyte outputs do not have to fit in memory. N-Triples has no prefixes or document structure, so concatenating per-chunk files always yields a single valid document.
