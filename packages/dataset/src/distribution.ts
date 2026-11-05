import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SPARQL_URI = 'https://www.w3.org/TR/sparql11-protocol/';

export const IANA_MEDIA_TYPE_PREFIX =
  'https://www.iana.org/assignments/media-types/';

// Maps a compression content type to the structured-syntax suffix a server
// appends to the RDF media type, e.g. `application/gzip` yields the `gzip` in
// `application/n-quads+gzip`. The inverse of how a registry strips that suffix
// into a separate compress format on ingest.
const compressionSuffixesByMimeType: Record<string, string> = {
  'application/gzip': 'gzip',
  'application/x-gzip': 'gzip',
  'application/zip': 'zip',
};

export class Distribution {
  public byteSize?: number;
  public compressFormat?: string;
  public lastModified?: Date;
  public namedGraph?: string;
  public subjectFilter?: string;

  #localPath?: string;

  /**
   * Absolute path of the file this distribution reads, set only by
   * {@link Distribution.localFile}. A `file:` {@link accessUrl} alone never
   * grants filesystem access, so a distribution described by a registry cannot
   * make the process read its own files.
   */
  public get localPath(): string | undefined {
    return this.#localPath;
  }

  /**
   * Plain content type derived from {@link mediaType}, e.g. `application/n-triples`.
   * Use this for HTTP headers, format matching, etc.
   */
  public readonly mimeType?: string;

  /**
   * Plain content type derived from {@link compressFormat}, e.g. `application/gzip`.
   * Returns `undefined` when no compression format is declared.
   */
  public get compressMimeType(): string | undefined {
    if (this.compressFormat === undefined) return undefined;
    return this.compressFormat.startsWith(IANA_MEDIA_TYPE_PREFIX)
      ? this.compressFormat.slice(IANA_MEDIA_TYPE_PREFIX.length)
      : this.compressFormat;
  }

  /**
   * The full content type a server is expected to send for the compressed
   * download – {@link mimeType} with the compression suffix derived from
   * {@link compressFormat} appended, e.g. `application/n-quads+gzip`. Returns
   * `undefined` when no media type or no recognised compression format is
   * declared. Lets a format check accept either the bare media type (the server
   * decompressed the body) or the declared compressed form.
   */
  public get compressedMimeType(): string | undefined {
    if (this.mimeType === undefined) return undefined;
    const suffix = compressionSuffixesByMimeType[this.compressMimeType ?? ''];
    return suffix === undefined ? undefined : `${this.mimeType}+${suffix}`;
  }

  /**
   * @param accessUrl  Distribution access URL.
   * @param mediaType  IANA media type URI per DCAT-AP 3.0
   *   (e.g. `https://www.iana.org/assignments/media-types/application/n-triples`),
   *   or a plain content type for convenience.
   * @param conformsTo Specification the distribution conforms to.
   */
  constructor(
    public readonly accessUrl: URL,
    public readonly mediaType?: string,
    public readonly conformsTo?: URL,
  ) {
    this.mimeType = mediaType?.startsWith(IANA_MEDIA_TYPE_PREFIX)
      ? mediaType.slice(IANA_MEDIA_TYPE_PREFIX.length)
      : mediaType;
  }

  public isSparql() {
    return (
      (this.conformsTo?.toString() == SPARQL_URI ||
        this.mimeType === 'application/sparql-query' ||
        this.mimeType === 'application/sparql-results+json') &&
      this.accessUrl !== null
    );
  }

  public static sparql(endpoint: URL, namedGraph?: string) {
    const distribution = new this(
      endpoint,
      IANA_MEDIA_TYPE_PREFIX + 'application/sparql-query',
      new URL(SPARQL_URI),
    );
    distribution.namedGraph = namedGraph;

    return distribution;
  }

  /**
   * A distribution read from a file on this machine, which the probe and the
   * downloader treat as a data dump. Its format follows from the extension:
   * `.nt`, `.nq`, `.ttl`, `.trig`, `.jsonld` or `.rdf`, optionally followed by
   * `.gz` or `.zip`.
   *
   * Only call this for paths you trust: see {@link localPath}.
   *
   * @param path Path of the file, relative to the working directory or absolute.
   * @throws When the extension names no RDF format.
   */
  public static localFile(path: string) {
    const name = basename(path).toLowerCase();
    const compression = compressionMimeTypesByExtension[extname(name)];
    const format = extname(
      compression === undefined ? name : name.slice(0, -extname(name).length),
    );
    const mimeType = rdfMimeTypesByExtension[format];
    if (mimeType === undefined) {
      throw new Error(`Cannot tell the RDF format of “${path}”`);
    }

    const absolutePath = resolve(path);
    const distribution = new this(pathToFileURL(absolutePath), mimeType);
    distribution.compressFormat = compression;
    distribution.#localPath = absolutePath;

    return distribution;
  }
}

export enum RdfFormat {
  'N-Triples' = 'application/n-triples',
  'N-Quads' = 'application/n-quads',
  Turtle = 'text/turtle',
}

export function rdfFormatToFileExtension(rdfFormat: RdfFormat): string {
  switch (rdfFormat) {
    case RdfFormat['N-Triples']:
      return 'nt';
    case RdfFormat['N-Quads']:
      return 'nq';
    case RdfFormat.Turtle:
      return 'ttl';
    default:
      throw new Error(`Unknown mime type: ${rdfFormat}`);
  }
}

const rdfMimeTypesByExtension: Record<string, string | undefined> = {
  '.nt': 'application/n-triples',
  '.nq': 'application/n-quads',
  '.ttl': 'text/turtle',
  '.trig': 'application/trig',
  '.jsonld': 'application/ld+json',
  '.rdf': 'application/rdf+xml',
};

const compressionMimeTypesByExtension: Record<string, string | undefined> = {
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
};
