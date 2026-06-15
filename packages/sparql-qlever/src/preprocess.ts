import { Distribution } from '@lde/dataset';
import { rdfParser } from 'rdf-parse';
import { rdfSerializer } from 'rdf-serialize';
import { createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream, WriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import yauzl from 'yauzl';

const JSONLD_MIME = 'application/ld+json';
const RDFXML_MIME = 'application/rdf+xml';
const TRIG_MIME = 'application/trig';
const ZIP_MIME = 'application/zip';
const GZIP_MIME = 'application/gzip';
const GZIP_MIME_LEGACY = 'application/x-gzip';

interface PreprocessFormat {
  /** Human-readable label used in warnings and error messages. */
  label: string;
  /** Filename extensions that identify this format inside a zip container. */
  zipExtensions: string[];
}

/**
 * RDF media types that `qlever-index` cannot read natively, so they are streamed
 * through `rdf-parse` → N-Quads first. The map key is the `rdf-parse`
 * `contentType`; the value carries the metadata needed to handle zip containers.
 */
const preprocessFormats = new Map<string, PreprocessFormat>([
  [JSONLD_MIME, { label: 'JSON-LD', zipExtensions: ['.jsonld', '.json'] }],
  [RDFXML_MIME, { label: 'RDF/XML', zipExtensions: ['.rdf', '.xml', '.owl'] }],
  // QLever ingests N-Quads/N-Triples/Turtle natively, but not TriG: its
  // `<graph> { … }` block syntax is neither N-Quads nor Turtle, so TriG must be
  // converted to N-Quads first, like JSON-LD and RDF/XML.
  [TRIG_MIME, { label: 'TriG', zipExtensions: ['.trig'] }],
]);

export interface PreprocessResult {
  /** Path to the file ready for `qlever-index`. Always N-Quads. */
  path: string;
  format: 'nq';
  warnings: string[];
}

/**
 * Whether a distribution needs Node-side preprocessing before `qlever-index`
 * can read it.
 *
 * JSON-LD, RDF/XML and TriG distributions return `true`: `qlever-index` cannot
 * parse any of them, so we stream them through `rdf-parse` into N-Quads first.
 *
 * Native RDF formats (`nt`, `nq`, `ttl`) — including when wrapped in
 * `application/gzip` or `application/zip` — go straight through the shell
 * pipeline in `index()`, which uses `gunzip -c` or `unzip -p` as appropriate.
 * Standalone `mediaType=application/zip` is rejected upstream: the inner
 * format must be declared.
 */
export function needsPreprocessing(distribution: Distribution): boolean {
  return (
    distribution.mimeType !== undefined &&
    preprocessFormats.has(distribution.mimeType)
  );
}

/**
 * Convert a JSON-LD, RDF/XML or TriG distribution to N-Quads alongside the
 * source file.
 *
 * Streams the source through `rdf-parse` → `rdf-serialize` so memory use
 * stays bounded regardless of input size. Handles gzip transparently
 * (declared `compressFormat` or `.gz` filename) and zip containers (folds
 * each matching entry into the output stream in order).
 *
 * Cached: if the output is newer than the input, it is reused as-is.
 */
export async function preprocess(
  localFile: string,
  distribution: Distribution,
): Promise<PreprocessResult> {
  const contentType = distribution.mimeType;
  const format =
    contentType === undefined ? undefined : preprocessFormats.get(contentType);
  if (contentType === undefined || format === undefined) {
    throw new Error(
      `preprocess called for distribution that does not need preprocessing: mediaType=${distribution.mimeType}`,
    );
  }

  const outputFile = `${localFile}.preprocessed.nq`;
  if (await outputIsUpToDate(localFile, outputFile)) {
    return { path: outputFile, format: 'nq', warnings: [] };
  }

  await rm(outputFile, { force: true });
  const warnings: string[] = [];

  if (distribution.compressMimeType === ZIP_MIME) {
    await streamRdfZip(localFile, outputFile, contentType, format, warnings);
  } else {
    await streamRdfFile(localFile, outputFile, contentType, distribution);
  }

  return { path: outputFile, format: 'nq', warnings };
}

async function outputIsUpToDate(
  inputFile: string,
  outputFile: string,
): Promise<boolean> {
  try {
    const [inputStat, outputStat] = await Promise.all([
      stat(inputFile),
      stat(outputFile),
    ]);
    return outputStat.mtimeMs > inputStat.mtimeMs && outputStat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Pipe one RDF source through parse → N-Quads serialize into an already
 * open writable, without closing it. Back-pressure is handled by Node's
 * built-in `.pipe()`; the caller manages `output`'s lifecycle.
 */
async function pipeRdfToWritable(
  input: Readable,
  output: WriteStream,
  contentType: string,
): Promise<void> {
  const quads = rdfParser.parse(input, { contentType });
  const bytes = rdfSerializer.serialize(quads, {
    contentType: 'application/n-quads',
  }) as unknown as Readable;
  bytes.pipe(output, { end: false });
  await finished(bytes);
}

async function closeWritable(output: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    output.end();
  });
}

async function streamRdfFile(
  localFile: string,
  outputFile: string,
  contentType: string,
  distribution: Distribution,
): Promise<void> {
  const isGzipped =
    distribution.compressMimeType === GZIP_MIME ||
    distribution.compressMimeType === GZIP_MIME_LEGACY ||
    localFile.toLowerCase().endsWith('.gz');
  const source = createReadStream(localFile);
  const input = isGzipped ? source.pipe(createGunzip()) : source;
  const output = createWriteStream(outputFile);
  try {
    await pipeRdfToWritable(input, output, contentType);
  } finally {
    await closeWritable(output);
  }
}

const openZip = promisify(yauzl.open) as (
  path: string,
  options: yauzl.Options,
) => Promise<yauzl.ZipFile>;

async function streamRdfZip(
  zipFile: string,
  outputFile: string,
  contentType: string,
  format: PreprocessFormat,
  warnings: string[],
): Promise<void> {
  const zip = await openZip(zipFile, { lazyEntries: true });
  const output = createWriteStream(outputFile);
  let entriesProcessed = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          try {
            if (entry.fileName.endsWith('/')) {
              zip.readEntry();
              return;
            }
            const extension = extname(entry.fileName).toLowerCase();
            if (!format.zipExtensions.includes(extension)) {
              warnings.push(
                `Skipping zip entry ${entry.fileName}: extension ${extension || '(none)'} is not ${format.label}`,
              );
              zip.readEntry();
              return;
            }
            const stream = await openZipEntry(zip, entry);
            await pipeRdfToWritable(stream, output, contentType);
            entriesProcessed++;
            zip.readEntry();
          } catch (error) {
            reject(error);
          }
        })();
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
    await closeWritable(output);
  }

  if (entriesProcessed === 0) {
    throw new Error(`Zip ${zipFile} contains no ${format.label} entries`);
  }
}

function openZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || stream === undefined) {
        reject(error ?? new Error('Failed to open zip entry'));
        return;
      }
      resolve(stream);
    });
  });
}
