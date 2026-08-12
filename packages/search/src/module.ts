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

/**
 * Read an optional object-shaped export of a loaded schema module, rejecting
 * anything that is not a plain object with the module path and the export name
 * in the message. Which optional exports a module may carry is the consumer’s
 * business – {@link loadSchemaModule} hands back the raw exports for exactly
 * that reason – but every consumer rejects a malformed one the same way.
 */
export function optionalObjectExport<Options>(
  moduleExports: Record<string, unknown>,
  name: string,
  modulePath: string,
): Options | undefined {
  const value = moduleExports[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `Schema module “${modulePath}” export “${name}” must be an object.`,
    );
  }
  return value as Options;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
