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
  type SearchType,
} from './schema.js';

/**
 * The executable {@link SearchEngine} port contract (import from
 * `@lde/search/testing`): a vitest suite every engine adapter runs against a
 * live instance of itself, so the port rules hold by test rather than by
 * prose. Covers schema binding (a type outside the bound schema is rejected),
 * the always-on query validation (a structurally invalid query is rejected
 * before it reaches the engine) and the result shape of a browse query and a
 * `searchFacets` batch – for every type in the schema.
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
    const types = (): readonly SearchType[] => [...engine().schema.values()];
    const browse = (searchType: SearchType): SearchQuery => ({
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
      const foreign: SearchType = {
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
      const foreign: SearchType = {
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
          for (const buckets of Object.values(outcome.facets)) {
            for (const bucket of buckets ?? []) {
              expect(typeof bucket.value).toBe('string');
              expect(typeof bucket.count).toBe('number');
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
function firstLocale(searchType: SearchType): string {
  for (const field of searchType.fields) {
    if (field.kind === 'text' && field.locales.length > 0) {
      return field.locales[0];
    }
  }
  return 'und';
}
