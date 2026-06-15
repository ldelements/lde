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
   * download — {@link mimeType} with the compression suffix derived from
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
