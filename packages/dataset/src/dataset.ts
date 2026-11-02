import { Distribution } from './distribution.js';

export interface Publisher {
  readonly iri: URL;
  readonly name: Record<string, string>;
}

export interface Creator {
  readonly iri: URL;
  readonly name: Record<string, string>;
}

export interface DatasetArguments {
  iri: URL;
  title?: Record<string, string>;
  description?: Record<string, string>;
  language?: string[];
  license?: URL;
  distributions: Distribution[];
  creator?: Creator[];
  publisher?: Publisher;
}

export class Dataset {
  readonly iri: URL;
  readonly title: Record<string, string>;
  readonly description?: Record<string, string>;
  readonly language: string[];
  readonly license?: URL;
  readonly distributions: Distribution[];
  readonly creator: Creator[];
  readonly publisher?: Publisher;

  constructor(options: DatasetArguments) {
    this.iri = options.iri;
    this.title = options.title ?? { '': '' };
    this.description = options.description;
    this.language = options.language ?? [];
    this.license = options.license;
    this.distributions = options.distributions;
    this.creator = options.creator ?? [];
    this.publisher = options.publisher;
  }

  /**
   * A dataset read from one file on this machine, identified by the file’s URL.
   * Moving the file therefore makes it a different dataset; for an identity that
   * survives a move, pass a {@link Distribution.localFile} to the constructor
   * with your own IRI.
   *
   * Only call this for paths you trust: see {@link Distribution.localPath}.
   *
   * @param path Path of the file, relative to the working directory or absolute.
   * @throws When the extension names no RDF format; see
   *   {@link Distribution.localFile}.
   */
  public static localFile(path: string) {
    const distribution = Distribution.localFile(path);

    return new this({
      // A copy, so changing one URL in place never changes the other.
      iri: new URL(distribution.accessUrl),
      distributions: [distribution],
    });
  }

  public getDownloadDistributions(): Distribution[] {
    const downloadable = this.distributions.filter(
      (distribution) => !distribution.isSparql(),
    );

    return [
      // Prefer compressed distributions.
      ...downloadable.filter(
        (distribution) => distribution.compressFormat !== undefined,
      ),
      ...downloadable.filter(
        (distribution) =>
          distribution.compressFormat === undefined &&
          distribution.mimeType !== undefined,
      ),
    ];
  }
}
