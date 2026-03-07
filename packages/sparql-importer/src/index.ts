import { Dataset, Distribution } from '@lde/dataset';

/**
 * An Importer takes a {@link Dataset}, selects a suitable {@link Distribution}
 * and imports it to a SPARQL server.
 *
 * This assumes that all Distributions of the Dataset are roughly equivalent:
 * https://docs.nde.nl/requirements-datasets/#dataset-distributions.
 */
// export interface Importer extends EventEmitter<Events> {
export interface Importer {
  /**
   * Import a {@link Dataset} to a SPARQL server.
   */
  import(
    dataset: Dataset,
  ): Promise<NotSupported | ImportFailed | ImportSuccessful>;
}

// interface Events {
//   imported: [statements: number];
//   end: [statements: number];
// }

export class ImportSuccessful {
  constructor(
    public readonly distribution: Distribution,
    public readonly identifier?: string,
    public readonly tripleCount?: number,
  ) {}
}

export class ImportFailed {
  constructor(
    public readonly distribution: Distribution,
    public readonly error: string,
  ) {}
}

export class NotSupported {
  constructor(public readonly distribution?: Distribution) {}
}
