import type { QuadTransform } from '../stage.js';
import type { BeforeStageWriteContext, PipelinePlugin } from '../pipeline.js';
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

/**
 * A {@link QuadTransform} that normalizes `http://schema.org/` to
 * `https://schema.org/` in every term position. See
 * {@link namespaceNormalizationTransform}.
 */
export const schemaOrgNormalizationTransform: QuadTransform<BeforeStageWriteContext> =
  namespaceNormalizationTransform({
    from: HTTP_SCHEMA_ORG,
    to: HTTPS_SCHEMA_ORG,
  });

/**
 * A generic {@link PipelinePlugin} that normalizes the Schema.org namespace
 * across a stage's output.
 *
 * By default rewrites `http://schema.org/` to `https://schema.org/`; pass
 * `{ reverse: true }` to normalize the other way. It is a blanket rewrite over
 * every matching IRI and knows nothing about VoID — to merge the VoID partition
 * nodes that mixed `http`/`https` variants produce, use
 * `schemaOrgPartitionMergePlugin` from `@lde/pipeline-void` instead.
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
