import { loadSchemaModule as loadDeclarations } from '@lde/search/module';
import type { SearchSchema } from '@lde/search';
import type { BuildGraphQLSchemaOptions } from '@lde/search-api-graphql';
import type { TypesenseSearchEngineOptions } from '@lde/search-typesense';

/**
 * What the mounted module declares: the deployment’s whole search
 * declaration, plus the schema- and engine-shaped options that belong next to
 * it. The module is **plain data with optional functions** (`derive`,
 * `transform`) – it cannot `import '@lde/search'` (bare specifiers do not
 * resolve from a mounted file), and does not need to: the declarations are
 * validated here, the way a SHACL generator’s output would be. Once the
 * SHACL + `search:` generator exists
 * ([#495](https://github.com/ldelements/lde/issues/495)), a SHACL mount
 * becomes an additional source for the same result.
 */
export interface SchemaModule {
  /** The validated schema built from the module’s default export. */
  readonly searchSchema: SearchSchema;
  /** The module’s optional `schemaOptions` export, forwarded to
   *  `buildGraphQLSchema` (per-type options, language order, `maxPerPage`). */
  readonly schemaOptions?: BuildGraphQLSchemaOptions;
  /** The module’s optional `engineOptions` export, forwarded to
   *  `createTypesenseSearchEngine` (collection overrides, query knobs). */
  readonly engineOptions?: TypesenseSearchEngineOptions;
}

/**
 * Load and validate a mounted schema-declaration module
 * (`@lde/search/module`’s {@link loadDeclarations | loadSchemaModule} – the
 * loader the indexer image shares, so both sides mount the same file), then
 * validate the read side’s optional exports. Throws with the module path in
 * the message for every failure mode, so a bad mount fails the boot with a
 * diagnosis, never the first query.
 */
export async function loadSchemaModule(
  modulePath: string,
): Promise<SchemaModule> {
  const { schema, moduleExports } = await loadDeclarations(modulePath);
  return {
    searchSchema: schema,
    schemaOptions: optionalObject(moduleExports, 'schemaOptions', modulePath),
    engineOptions: optionalObject(moduleExports, 'engineOptions', modulePath),
  };
}

function optionalObject<Options>(
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
