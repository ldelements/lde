import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineSearchType, searchSchema } from '@lde/search';
import {
  startSparqlEndpoint,
  teardownSparqlEndpoint,
} from '@lde/local-sparql-endpoint';
import { extractionQueryString } from '../src/extraction.js';

const SCHEMA = 'https://schema.org/';

// An endpoint reached through a Role, carrying three INDEPENDENT multi-valued
// properties – which is the case the shape of the nested read has to get right.
const agent = defineSearchType({
  name: 'Agent',
  class: `${SCHEMA}Person`,
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl', 'en', 'und'],
      output: true,
      searchable: { weight: 5 },
    },
    {
      name: 'jobTitle',
      kind: 'keyword',
      array: true,
      path: `<${SCHEMA}jobTitle>`,
      output: true,
    },
    {
      name: 'sameAs',
      kind: 'reference',
      array: true,
      path: `<${SCHEMA}sameAs>`,
      output: true,
      ref: { strategy: 'idOnly' },
    },
  ],
});

const creatorRole = defineSearchType({
  name: 'CreatorRole',
  fields: [
    {
      // Single-valued: a leaf a weld can name states one value per entry, and
      // an edge the graph gave several roles fans out (ADR 26).
      name: 'role',
      kind: 'keyword',
      output: true,
      filterable: true,
      path: `<${SCHEMA}roleName>`,
    },
    {
      name: 'agent',
      kind: 'reference',
      array: true,
      output: true,
      path: `<${SCHEMA}creator>`,
      ref: { strategy: 'lookup', target: 'Agent', local: true },
    },
  ],
});

const work = defineSearchType({
  name: 'VisualArtwork',
  class: `${SCHEMA}VisualArtwork`,
  fields: [
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      output: true,
      facetable: true,
      path: `<${SCHEMA}creator>`,
      ref: { strategy: 'inline', typeName: 'CreatorRole', identity: 'agent' },
    },
  ],
});

const schema = searchSchema(work, agent, creatorRole);

/**
 * The same reading written the way a naive generator writes it: one `OPTIONAL`
 * per property inside one BGP. Hand-written, as the contrast the assertion is
 * against.
 */
const INDEPENDENT_OPTIONALS = `{
  ?root <${SCHEMA}creator> ?r .
  OPTIONAL { ?r <${SCHEMA}roleName> ?role }
  OPTIONAL { ?r <${SCHEMA}creator> ?v .
    OPTIONAL { ?v <${SCHEMA}name> ?name }
    OPTIONAL { ?v <${SCHEMA}jobTitle> ?job }
    OPTIONAL { ?v <${SCHEMA}sameAs> ?same }
  }
}`;

describe('the nested read adds rather than multiplies', () => {
  const port = 3012;

  beforeAll(async () => {
    await startSparqlEndpoint(
      port,
      fileURLToPath(new URL('./fixtures/fanout.ttl', import.meta.url)),
    );
  }, 60_000);

  afterAll(async () => {
    await teardownSparqlEndpoint();
  });

  /**
   * Solution **rows**, not triples. A `CONSTRUCT` result is logically a set,
   * but not every store deduplicates it on the wire – QLever emits one copy of
   * the template per solution row – so rows are what a cross-product costs, and
   * the store used here would hide it by deduplicating.
   */
  async function rows(where: string): Promise<number> {
    const response = await fetch(`http://localhost:${port}/sparql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json',
      },
      body: `SELECT * WHERE ${where}`,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status}: ${body.slice(0, 400)}`);
    }
    return (JSON.parse(body) as { results: { bindings: unknown[] } }).results
      .bindings.length;
  }

  /** The generated query's WHERE, run on its own so the count is of rows the
   *  CONSTRUCT template would be emitted once per. */
  function generatedWhere(): string {
    const query = extractionQueryString(work, schema);
    return query.slice(query.indexOf('WHERE') + 'WHERE'.length);
  }

  it('keeps the endpoint’s own properties additive, not multiplicative', async () => {
    const generated = await rows(generatedWhere());

    // 1 role + 3 names + 2 job titles + 2 sameAs. The union inside the OPTIONAL
    // is what makes it a sum: each branch binds only its own variable, so no
    // two properties meet in one BGP.
    expect(generated).toBe(8);
  });

  it('is what one OPTIONAL per property would have cost', async () => {
    // The shape this exists to avoid: the three properties multiply, and the
    // gap widens with every value a publisher adds.
    expect(await rows(INDEPENDENT_OPTIONALS)).toBeGreaterThan(
      await rows(generatedWhere()),
    );
  });
});
