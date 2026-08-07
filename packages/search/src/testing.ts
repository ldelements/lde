import { describe, expect, it } from 'vitest';
import type { SearchEngine } from './engine.js';
import {
  filterOperatorFor,
  type Filter,
  type FilterOperator,
  type SearchQuery,
} from './query.js';
import {
  facetableFields,
  filterableFields,
  ID_FIELD,
  nestedReferenceType,
  outputFields,
  type RootType,
  type SearchField,
  type SearchType,
} from './schema.js';

/**
 * The executable {@link SearchEngine} port contract (import from
 * `@lde/search/testing`): a vitest suite every engine adapter runs against a
 * live instance of itself, so the port rules hold by test rather than by
 * prose. Covers schema binding (a type outside the bound schema is rejected),
 * the always-on query validation (a structurally invalid query is rejected
 * before it reaches the engine), the undeclared `id` lookup, and the result
 * shape of a browse query and a `searchFacets` batch – for every type in the
 * schema.
 *
 * ```ts
 * describeSearchEngineContract('TypesenseSearchEngine', () => engine);
 * ```
 *
 * `engine` is a thunk so the instance may be created in a `beforeAll` (e.g.
 * against a testcontainer); it is called inside each test.
 */
export function describeSearchEngineContract(
  name: string,
  engine: () => SearchEngine,
): void {
  describe(`SearchEngine port contract: ${name}`, () => {
    const types = (): readonly RootType[] => [...engine().schema.values()];
    const browse = (searchType: RootType): SearchQuery => ({
      where: [],
      orderBy: [],
      limit: 1,
      offset: 0,
      facets: [],
      locale: firstLocale(searchType),
    });

    it('exposes the schema it is bound to, with at least one type', () => {
      expect(types().length).toBeGreaterThan(0);
      for (const searchType of types()) {
        expect(typeof searchType.name).toBe('string');
        expect(typeof searchType.class).toBe('string');
      }
    });

    it('rejects a search type outside its schema', async () => {
      const foreign: RootType = {
        name: 'NotInSchema',
        class: 'urn:test:not-in-schema',
        fields: [],
      };
      await expect(engine().search(foreign, browse(foreign))).rejects.toThrow(
        /not in this engine/,
      );
    });

    it('rejects a where clause naming an unknown field', async () => {
      for (const searchType of types()) {
        const query: SearchQuery = {
          ...browse(searchType),
          where: [{ field: 'fieldThatDoesNotExist', in: ['x'] }],
        };
        await expect(engine().search(searchType, query)).rejects.toThrow(
          /unknown-field/,
        );
      }
    });

    it('applies an `id` lookup rather than ignoring the clause', async () => {
      // `id` is filterable on every type without being declared by any, so an
      // adapter that resolves `where` fields through its declaration alone
      // takes the unknown-field path and drops the clause – returning EVERY
      // document where the caller asked for one. Pinned here because that
      // failure is silent: no error, just the wrong result set.
      for (const searchType of types()) {
        const query: SearchQuery = {
          ...browse(searchType),
          where: [{ field: ID_FIELD, in: ['urn:test:no-such-document'] }],
        };
        const result = await engine().search(searchType, query);
        expect(result.total).toBe(0);
        expect(result.hits).toEqual([]);
      }
    });

    it('rejects a facet request for an unknown field', async () => {
      for (const searchType of types()) {
        const query: SearchQuery = {
          ...browse(searchType),
          facets: ['fieldThatDoesNotExist'],
        };
        await expect(engine().search(searchType, query)).rejects.toThrow(
          /unknown-field/,
        );
      }
    });

    it('rejects an operator that does not match the field kind', async () => {
      for (const searchType of types()) {
        const [filterable] = filterableFields(searchType);
        if (filterable === undefined) {
          continue; // Nothing filterable to mismatch against.
        }
        const operator = filterOperatorFor(filterable.kind);
        const query: SearchQuery = {
          ...browse(searchType),
          where: [mismatchedFilter(filterable.name, operator)],
        };
        await expect(engine().search(searchType, query)).rejects.toThrow(
          /operator-mismatch/,
        );
      }
    });

    it('rejects a searchFacets batch for a type outside its schema', async () => {
      const foreign: RootType = {
        name: 'NotInSchema',
        class: 'urn:test:not-in-schema',
        fields: [],
      };
      await expect(
        engine().searchFacets(foreign, [browse(foreign)]),
      ).rejects.toThrow(/not in this engine/);
    });

    it('rejects a structurally invalid query anywhere in a searchFacets batch', async () => {
      for (const searchType of types()) {
        const queries: SearchQuery[] = [
          { ...browse(searchType), limit: 0 },
          {
            ...browse(searchType),
            limit: 0,
            facets: ['fieldThatDoesNotExist'],
          },
        ];
        await expect(
          engine().searchFacets(searchType, queries),
        ).rejects.toThrow(/unknown-field/);
      }
    });

    it('answers a searchFacets batch with one facets outcome per query, positionally', async () => {
      for (const searchType of types()) {
        const facets = facetableFields(searchType).map((field) => field.name);
        const queries: SearchQuery[] = [
          { ...browse(searchType), limit: 0, facets },
          // Facet-only regardless of the limit the query carries: this one
          // keeps its non-zero browse limit and must be answered the same.
          { ...browse(searchType), facets: [] },
        ];
        const outcomes = await engine().searchFacets(searchType, queries);
        expect(outcomes).toHaveLength(queries.length);
        for (const outcome of outcomes) {
          // A valid query in a healthy engine yields facets, not an error.
          expect('error' in outcome ? outcome.error : undefined).toBe(
            undefined,
          );
          if ('error' in outcome) {
            continue;
          }
          expect(outcome.facets).toBeTypeOf('object');
          const booleanFacets = new Set(
            facetableFields(searchType)
              .filter((field) => field.kind === 'boolean')
              .map((field) => field.name),
          );
          for (const [name, buckets] of Object.entries(outcome.facets)) {
            for (const bucket of buckets ?? []) {
              expect(typeof bucket.value).toBe('string');
              expect(typeof bucket.count).toBe('number');
              // A boolean facet MUST carry `is`: a surface types it non-null
              // (GraphQL `Boolean!`), so an adapter that omits it nulls the
              // whole response rather than degrading one facet.
              if (booleanFacets.has(name)) {
                expect(typeof bucket.is).toBe('boolean');
              }
            }
          }
        }
      }
    });

    it('resolves an empty searchFacets batch to an empty list', async () => {
      for (const searchType of types()) {
        await expect(engine().searchFacets(searchType, [])).resolves.toEqual(
          [],
        );
      }
    });

    it('serves a surfaced inline reference as nested documents, never a bare IRI', async () => {
      // The API device of an Inline Reference (ADR 11): a reference declared
      // `inline` with `output` reaches the caller as its referent’s own fields,
      // grouped per referent. Every engine owes that shape – reconstruction
      // lives below the surfaces, so a surface never has to rebuild it – and an
      // adapter that stores the reference as an IRI fails here rather than in
      // one deployment’s UI.
      for (const searchType of types()) {
        const nested: { field: SearchField; referenceType: SearchType }[] = [];
        for (const field of searchType.fields) {
          const referenceType = nestedReferenceType(engine().schema, field);
          if (referenceType !== undefined) {
            nested.push({ field, referenceType });
          }
        }
        if (nested.length === 0) {
          continue;
        }
        const result = await engine().search(searchType, {
          ...browse(searchType),
          limit: 20,
        });
        for (const hit of result.hits) {
          for (const { field, referenceType } of nested) {
            const value = hit.document[field.name];
            if (value === undefined) {
              continue; // A referent-less document nests nothing.
            }
            // A multi-valued reference keeps one document per referent, so a
            // consumer never pairs parallel arrays by index.
            expect(Array.isArray(value)).toBe(field.array === true);
            const referents = (
              Array.isArray(value) ? value : [value]
            ) as Record<string, unknown>[];
            const declared = new Set([
              ID_FIELD,
              ...outputFields(referenceType).map(
                (nestedField) => nestedField.name,
              ),
            ]);
            for (const referent of referents) {
              expect(referent).toBeTypeOf('object');
              expect(
                Object.keys(referent).every((key) => declared.has(key)),
              ).toBe(true);
            }
          }
        }
      }
    });

    it('answers a browse query with hits, a total and facets', async () => {
      for (const searchType of types()) {
        const result = await engine().search(searchType, browse(searchType));
        expect(Array.isArray(result.hits)).toBe(true);
        expect(typeof result.total).toBe('number');
        expect(result.facets).toBeTypeOf('object');
        for (const hit of result.hits) {
          expect(typeof hit.id).toBe('string');
          expect(hit.document).toBeTypeOf('object');
        }
      }
    });
  });
}

/** A filter whose operator deliberately mismatches the field’s kind. */
function mismatchedFilter(
  field: string,
  operator: FilterOperator | undefined,
): Filter {
  return operator === 'in'
    ? { field, range: { min: 0 } }
    : { field, in: ['x'] };
}

/** The locale a query against this type may select (any is contract-valid). */
function firstLocale(searchType: RootType): string {
  for (const field of searchType.fields) {
    if (field.kind === 'text' && field.locales.length > 0) {
      return field.locales[0];
    }
  }
  return 'und';
}
