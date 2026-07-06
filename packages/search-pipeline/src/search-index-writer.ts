import type { Quad } from '@rdfjs/types';
import type { Dataset } from '@lde/dataset';
import type {
  DatasetOutcome,
  RunContext,
  RunWriter,
  Writer,
} from '@lde/pipeline';
import {
  projectGraph,
  type SearchDocument,
  type SearchSchema,
} from '@lde/search';

/** Options for {@link searchIndexWriter}. */
export interface SearchIndexWriterOptions {
  /**
   * The declarative schema driving the projection: one {@link SearchType} per
   * root type, each mapping framed RDF to flat search-document fields.
   */
  schema: SearchSchema;
  /**
   * The engine adapter the projected documents are written to – e.g.
   * `@lde/search-typesense`’s `BlueGreenRebuild` or `InPlaceRebuild`. The
   * run lifecycle (context, per-dataset flush outcome, commit/abort) is
   * forwarded unchanged, so the engine writer’s update mode governs.
   */
  writer: Writer<SearchDocument>;
}

/**
 * The projection step of a search-indexing pipeline, as a quad `Writer`: it
 * turns each dataset’s extracted CONSTRUCT quads into engine-agnostic search
 * documents ({@link projectGraph}: frame by root type, then project each node
 * with its type’s declaration) and feeds them to the engine writer. This is
 * the one type-changing step (quad → document), shared across engines –
 * which is why it lives here and not inside an engine adapter.
 *
 * A dataset’s quads are buffered until its flush and projected then, so the
 * documents land before the engine acts on the dataset’s completion (e.g. an
 * In-place stale sweep). Memory is bounded by one dataset’s extraction, and
 * released at each flush – nothing accumulates across datasets. Streaming
 * bounded entity batches *within* one huge dataset needs the two-level
 * iteration (dataset → entity-URI batches) and is not implemented yet.
 */
export function searchIndexWriter(
  options: SearchIndexWriterOptions,
): Writer<Quad> {
  const { schema, writer } = options;
  return {
    async openRun(context: RunContext): Promise<RunWriter<Quad>> {
      const run = await writer.openRun(context);
      // One buffered pass per dataset, keyed by IRI. The pipeline processes
      // datasets sequentially, but keeping the key explicit makes a write
      // after another dataset's flush safe too.
      const passes = new Map<string, { dataset: Dataset; quads: Quad[] }>();

      const project = async (pass: {
        dataset: Dataset;
        quads: Quad[];
      }): Promise<void> => {
        passes.delete(pass.dataset.iri.toString());
        if (pass.quads.length === 0) {
          return;
        }
        await run.write(pass.dataset, projectGraph(pass.quads, schema));
      };

      return {
        write: async (dataset: Dataset, quads: AsyncIterable<Quad>) => {
          const key = dataset.iri.toString();
          let pass = passes.get(key);
          if (pass === undefined) {
            pass = { dataset, quads: [] };
            passes.set(key, pass);
          }
          for await (const quad of quads) {
            pass.quads.push(quad);
          }
        },

        flush: async (dataset: Dataset, outcome: DatasetOutcome) => {
          const pass = passes.get(dataset.iri.toString());
          if (pass !== undefined) {
            await project(pass);
          }
          await run.flush?.(dataset, outcome);
        },

        reset: async (dataset: Dataset) => {
          // Discard the buffered pass so the re-run replaces it, and let the
          // engine writer discard whatever it already holds for the dataset.
          passes.delete(dataset.iri.toString());
          await run.reset?.(dataset);
        },

        commit: async () => {
          // Safety net: project passes that were never flushed, so a
          // committed run never silently drops written quads.
          for (const pass of [...passes.values()]) {
            await project(pass);
          }
          await run.commit();
        },

        abort: (error: unknown) => run.abort(error),
      };
    },
  };
}
