import type { Quad } from '@rdfjs/types';
import type { Dataset } from '@lde/dataset';

import type {
  Validator,
  ValidationResult,
  ValidationReport,
  Writer,
} from '@lde/pipeline';
// @ts-expect-error -- shacl-engine has no type declarations.
import ShaclEngine from 'shacl-engine/Validator.js';
// @ts-expect-error -- rdf-ext has no type declarations.
import rdf from 'rdf-ext';
import { rdfDereferencer } from 'rdf-dereference';

/** Options for {@link ShaclValidator}. */
export interface ShaclValidatorOptions {
  /** Path to an RDF file containing SHACL shapes (any format supported by rdf-dereference). */
  shapesFile: string;
  /**
   * Writers that receive the per-dataset SHACL validation report quads. Each
   * batch with violations is streamed to every writer via {@link Writer.write};
   * each writer's {@link Writer.flush} is called from {@link ShaclValidator.report}.
   *
   * Pass a {@link FileWriter} to mirror the previous on-disk behaviour, a
   * {@link SparqlUpdateWriter} to land reports in a named graph, or any custom
   * writer. Validators with no `reportWriters` only produce aggregate counts.
   */
  reportWriters?: Writer[];
}

interface DatasetAccumulator {
  quadsValidated: number;
  violations: number;
  conforms: boolean;
}

/**
 * SHACL-based {@link Validator} for `@lde/pipeline`.
 *
 * Validates quads against shapes loaded from an RDF file (any format
 * supported by rdf-dereference) and streams the per-dataset SHACL validation
 * report to any number of configured {@link Writer}s.
 */
export class ShaclValidator implements Validator {
  private readonly shapesFile: string;
  private readonly reportWriters: Writer[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private shapesDataset: any | undefined;
  private readonly accumulators = new Map<string, DatasetAccumulator>();

  constructor(options: ShaclValidatorOptions) {
    this.shapesFile = options.shapesFile;
    this.reportWriters = options.reportWriters ?? [];
  }

  async validate(quads: Quad[], dataset: Dataset): Promise<ValidationResult> {
    if (quads.length === 0) {
      return { conforms: true, violations: 0 };
    }

    const shapes = await this.getShapes();
    const dataDataset = rdf.dataset(quads);

    const validator = new ShaclEngine(shapes, { factory: rdf });
    const report = await validator.validate({ dataset: dataDataset });

    const violations = report.results.length as number;
    const conforms = report.conforms as boolean;

    // Accumulate per dataset.
    const key = dataset.iri.toString();
    const acc = this.accumulators.get(key) ?? {
      quadsValidated: 0,
      violations: 0,
      conforms: true,
    };
    acc.quadsValidated += quads.length;
    acc.violations += violations;
    if (!conforms) acc.conforms = false;
    this.accumulators.set(key, acc);

    if (violations > 0 && this.reportWriters.length > 0) {
      const reportQuads: Quad[] = [...report.dataset];
      for (const writer of this.reportWriters) {
        await writer.write(dataset, asyncIterableOf(reportQuads));
      }
    }

    return { conforms, violations };
  }

  async report(dataset: Dataset): Promise<ValidationReport> {
    for (const writer of this.reportWriters) {
      await writer.flush?.(dataset);
    }

    const key = dataset.iri.toString();
    const acc = this.accumulators.get(key);
    if (!acc) {
      return { conforms: true, violations: 0, quadsValidated: 0 };
    }
    return {
      conforms: acc.conforms,
      violations: acc.violations,
      quadsValidated: acc.quadsValidated,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getShapes(): Promise<any> {
    if (!this.shapesDataset) {
      const { data } = await rdfDereferencer.dereference(this.shapesFile, {
        localFiles: true,
      });
      this.shapesDataset = await rdf.dataset().import(data);
    }
    return this.shapesDataset;
  }
}

async function* asyncIterableOf<T>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) yield item;
}
