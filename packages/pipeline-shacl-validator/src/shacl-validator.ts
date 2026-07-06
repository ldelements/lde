import { randomUUID } from 'node:crypto';
import type { Quad } from '@rdfjs/types';
import type { Dataset } from '@lde/dataset';

import type {
  Validator,
  ValidationResult,
  ValidationReport,
  RunWriter,
  Writer,
} from '@lde/pipeline';
// @ts-expect-error -- shacl-engine has no type declarations.
import ShaclEngine from 'shacl-engine/Validator.js';
// @ts-expect-error -- rdf-ext has no type declarations.
import rdf from 'rdf-ext';
import { rdfDereferencer } from 'rdf-dereference';
import { skolemizeReport } from './skolemize-report.js';

/** Options for {@link ShaclValidator}. */
export interface ShaclValidatorOptions {
  /** Path to an RDF file containing SHACL shapes (any format supported by rdf-dereference). */
  shapesFile: string;
  /**
   * Writers that receive the per-dataset SHACL validation report quads. The
   * validator opens one run per writer (lazily, on the first violation) and
   * streams each batch with violations to it; each run is flushed per dataset
   * from {@link ShaclValidator.report}.
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
  private reportRuns: RunWriter[] | undefined;
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
      // Skolemise the report's blank nodes to dataset-scoped IRIs before writing.
      // shacl-engine emits the report and every result as blank nodes, whose
      // labels are not unique across the per-dataset n-quads files a file-based
      // store cats into one index — fusing one dataset's violations into
      // another's (see ldelements/lde#478).
      const reportQuads = skolemizeReport(
        report.dataset,
        dataset.iri.toString(),
      );
      for (const run of await this.runs()) {
        await run.write(dataset, asyncIterableOf(reportQuads));
      }
    }

    // Surface where to look for the report in halt-mode error messages
    // (read by @lde/pipeline's Stage.validateBuffer when onInvalid:'halt').
    const message =
      violations > 0 && this.reportWriters.length > 0
        ? `Report sent to ${this.reportWriters.length} writer(s)`
        : undefined;

    return { conforms, violations, ...(message !== undefined && { message }) };
  }

  async report(dataset: Dataset): Promise<ValidationReport> {
    // Flush is the per-dataset completion hook regardless of whether the
    // dataset produced violations, so open the runs here if no write did.
    // The report stream itself completed, whatever the dataset's own data
    // looked like – hence 'success'.
    for (const run of await this.runs()) {
      await run.flush?.(dataset, 'success');
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

  /**
   * The report writers' runs, opened lazily on first use. The report stream is
   * the validator's own long-lived run: each dataset's report is finalized by
   * the per-dataset flush in {@link report}, so the run needs no commit, and
   * the fabricated context's selection stays empty (report writers do not
   * sweep by membership).
   */
  private async runs(): Promise<RunWriter[]> {
    this.reportRuns ??= await Promise.all(
      this.reportWriters.map((writer) =>
        writer.openRun({
          runId: randomUUID(),
          startedAt: new Date().toISOString(),
          selectedSources: () => [],
        }),
      ),
    );
    return this.reportRuns;
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
