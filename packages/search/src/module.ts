// The `@lde/search/module` entry point: load a mounted schema-declaration
// module. Node-only (it touches the filesystem), so it lives outside the main
// entry point, which stays runtime-agnostic.
import { pathToFileURL } from 'node:url';
import { searchSchema, type SearchSchema, type SearchType } from './schema.js';

/** What {@link loadSchemaModule} returns: the validated schema plus the raw
 *  module exports, so each consumer validates its own optional exports (the
 *  served API reads `schemaOptions`/`engineOptions`; the indexer reads none). */
export interface LoadedSchemaModule {
  /** The validated schema built from the module’s default export. */
  readonly schema: SearchSchema;
  /** Every export of the module, for consumer-specific optional exports. */
  readonly moduleExports: Record<string, unknown>;
}

/**
 * Load and validate a mounted schema-declaration module: an ES module whose
 * default export is a non-empty array of {@link SearchType} declarations –
 * **plain data with optional functions** (`derive`, `transform`), because a
 * mounted file cannot resolve bare imports like `@lde/search`. The one schema
 * source both the indexer image and the served-API image mount, so the write
 * and the read side cannot disagree about the schema.
 *
 * Throws with the module path in the message for every failure mode – an
 * unreadable file, a wrong export shape, an invalid declaration – so a bad
 * mount fails the boot with a diagnosis, never the first query.
 */
export async function loadSchemaModule(
  modulePath: string,
): Promise<LoadedSchemaModule> {
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = (await import(pathToFileURL(modulePath).href)) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    throw new Error(
      `Cannot load schema module “${modulePath}”: ${messageOf(cause)}`,
      { cause },
    );
  }
  const declarations = moduleExports['default'];
  if (!Array.isArray(declarations) || declarations.length === 0) {
    throw new Error(
      `Schema module “${modulePath}” must default-export a non-empty array of search type declarations.`,
    );
  }
  try {
    return {
      schema: searchSchema(...(declarations as SearchType[])),
      moduleExports,
    };
  } catch (cause) {
    throw new Error(
      `Schema module “${modulePath}” declares an invalid schema: ${messageOf(cause)}`,
      { cause },
    );
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
