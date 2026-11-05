import type { Quad } from '@rdfjs/types';
import type { Dataset } from '@lde/dataset';

/** Validates RDF quads against a set of constraints. */
export interface Validator {
  /** Validate a batch of quads. Accumulates results internally. */
  validate(quads: Quad[], dataset: Dataset): Promise<ValidationResult>;

  /** Return accumulated validation results for a dataset. */
  report(dataset: Dataset): Promise<ValidationReport>;
}

/** Result of validating a single batch. */
export interface ValidationResult {
  violations: number;
  conforms: boolean;
  /** Human-readable detail, e.g. path to the report file. Included in error messages on halt. */
  message?: string;
}

/** Accumulated validation results for a dataset. */
export interface ValidationReport extends ValidationResult {
  quadsValidated: number;
}
