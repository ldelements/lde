import type { QuadTransform } from '../stage.js';
import type { PipelinePlugin } from '../pipeline.js';
import type { Dataset } from '@lde/dataset';
import {
  namespaceNormalizationPlugin,
  namespaceNormalizationTransform,
} from './namespaceNormalization.js';

const HTTP_SCHEMA_ORG = 'http://schema.org/';
const HTTPS_SCHEMA_ORG = 'https://schema.org/';

export interface SchemaOrgNormalizationOptions {
  /** When true, normalizes `https://schema.org/` to `http://schema.org/` instead. */
  reverse?: boolean;
}

/** QuadTransform that normalizes `http://schema.org/` to `https://schema.org/` in `void:class` and `void:property` objects. */
export const schemaOrgNormalizationTransform: QuadTransform<{
  dataset: Dataset;
}> = namespaceNormalizationTransform({
  from: HTTP_SCHEMA_ORG,
  to: HTTPS_SCHEMA_ORG,
});

/**
 * Pipeline plugin that normalizes Schema.org namespace prefixes in `void:class`
 * and `void:property` quad objects.
 *
 * By default, rewrites `http://schema.org/` to `https://schema.org/`. Pass
 * `{ reverse: true }` to normalize in the opposite direction.
 *
 * `void:vocabulary` quads are left unchanged so consumers can see which
 * namespace the source dataset actually uses.
 */
export function schemaOrgNormalizationPlugin(
  options?: SchemaOrgNormalizationOptions,
): PipelinePlugin {
  const from = options?.reverse ? HTTPS_SCHEMA_ORG : HTTP_SCHEMA_ORG;
  const to = options?.reverse ? HTTP_SCHEMA_ORG : HTTPS_SCHEMA_ORG;
  return {
    ...namespaceNormalizationPlugin({ from, to }),
    name: 'schema-org-normalization',
  };
}
