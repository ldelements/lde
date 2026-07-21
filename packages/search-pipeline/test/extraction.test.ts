import { describe, expect, it } from 'vitest';
import { Parser } from '@traqula/parser-sparql-1-1';
import {
  AstFactory,
  type Path,
  type PatternGroup,
  type QueryConstruct,
  type TripleNesting,
} from '@traqula/rules-sparql-1-1';
import { defineSearchType, searchSchema } from '@lde/search';
import { irAlias, referenceTypeNamed } from '@lde/search/adapter';
import type { SearchSchema, SearchType } from '@lde/search';
import { extractionQuery, extractionQueryString } from '../src/extraction.js';

const SCHEMA = 'https://schema.org/';
const factory = new AstFactory();

// A Drapo-shaped SCHEMA-AP-NDE schema: CreativeWork (two localized text fields
// and a labelOnly creator reference) resolving Person for its creator labels.
// Every path is a single predicate – the shape the Drapo dump exercises.
const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA}Person`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl', 'und'],
      output: true,
      searchable: { weight: 3 },
    },
  ],
});

const creativeWork = defineSearchType({
  name: 'CreativeWork',
  class: `${SCHEMA}CreativeWork`,
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['nl', 'und'],
      output: true,
      searchable: { weight: 5 },
    },
    {
      name: 'description',
      kind: 'text',
      path: `<${SCHEMA}description>`,
      locales: ['nl', 'und'],
      output: true,
      searchable: { weight: 2 },
    },
    {
      name: 'creator',
      kind: 'reference',
      path: `<${SCHEMA}creator>`,
      labelSource: 'Person',
      facetable: true,
      output: true,
      ref: { typeName: 'Person', strategy: 'labelOnly' },
    },
  ],
});

const drapoSchema = searchSchema(creativeWork, person);

/** The template triples, each narrowed from the broader BGP element type. */
function templateTriples(query: QueryConstruct): TripleNesting[] {
  return query.template.triples.map((triple) => {
    if (!factory.isTriple(triple)) {
      throw new Error('expected a plain triple in the CONSTRUCT template');
    }
    return triple;
  });
}

/** The predicate IRIs (the minted IR Aliases) a CONSTRUCT template emits. */
function templatePredicates(query: QueryConstruct): string[] {
  return templateTriples(query).map((triple) => {
    const predicate = triple.predicate;
    if (!factory.isTermNamed(predicate)) {
      throw new Error('a CONSTRUCT template verb must be a plain IRI');
    }
    return predicate.value;
  });
}

/** The WHERE’s top-level UNION branches (one group per field). */
function unionBranches(query: QueryConstruct): PatternGroup[] {
  const [union] = query.where.patterns;
  if (union === undefined || !factory.isPatternUnion(union)) {
    throw new Error('expected a UNION at the top of the WHERE');
  }
  return union.patterns;
}

describe('extractionQuery', () => {
  it('mints one IR-Alias template triple per path-bearing field, single subject', () => {
    const query = extractionQuery(creativeWork, drapoSchema);

    // Template: IRIs only, one triple per field, all off the same ?root subject.
    expect(templatePredicates(query)).toEqual([
      irAlias(creativeWork, creativeWork.fields[0]),
      irAlias(creativeWork, creativeWork.fields[1]),
      irAlias(creativeWork, creativeWork.fields[2]),
    ]);
    for (const triple of templateTriples(query)) {
      expect(triple.subject).toMatchObject({
        subType: 'variable',
        value: 'root',
      });
    }
  });

  it('reads each field via its source path in a UNION branch, not a conjunction', () => {
    // One branch per field – never one BGP conjoining all paths (that
    // cross-product is what inflates a multi-valued result ~4×).
    expect(
      unionBranches(extractionQuery(creativeWork, drapoSchema)),
    ).toHaveLength(3);
  });

  it('embeds a multi-hop path as a SPARQL property path (sequence)', () => {
    const withPathField = defineSearchType({
      name: 'CreativeWork',
      class: `${SCHEMA}CreativeWork`,
      fields: [
        {
          name: 'publisherName',
          kind: 'text',
          // A qualified two-hop value no single predicate can address.
          path: `<${SCHEMA}publisher>/<${SCHEMA}name>`,
          locales: ['und'],
          output: true,
        },
      ],
    });
    const query = extractionQuery(withPathField, searchSchema(withPathField));

    const [group] = unionBranches(query);
    const [bgp] = group.patterns;
    if (bgp === undefined || !factory.isPatternBgp(bgp)) {
      throw new Error('expected a bgp');
    }
    const triple = bgp.triples[0];
    if (!factory.isTriple(triple)) {
      throw new Error('expected a triple');
    }
    const path = triple.predicate as Path;
    expect(path).toMatchObject({ type: 'path', subType: '/' });
    // …while the template verb stays a plain minted IRI (a path cannot be one).
    expect(templatePredicates(query)).toEqual([
      irAlias(withPathField, withPathField.fields[0]),
    ]);
  });

  it('leaves the root subject free for the pipeline VALUES injection', () => {
    const query = extractionQuery(creativeWork, drapoSchema, {
      subjectVariable: 'item',
    });
    for (const triple of templateTriples(query)) {
      expect(triple.subject).toMatchObject({
        subType: 'variable',
        value: 'item',
      });
    }
    // Defaults to `root`, matching selectByClass’s default binding.
    expect(extractionQueryString(creativeWork, drapoSchema)).toContain('?root');
  });

  it('stringifies to a runnable CONSTRUCT the SPARQL parser round-trips', () => {
    const query = extractionQueryString(creativeWork, drapoSchema);
    expect(query).toContain('CONSTRUCT');
    expect(query).toContain('UNION');
    const reparsed = new Parser().parse(query);
    expect(reparsed).toMatchObject({ type: 'query', subType: 'construct' });
  });

  it('throws for a type with no path-bearing field – nothing to extract', () => {
    const empty: SearchType = {
      name: 'Empty',
      class: 'urn:x:Empty',
      fields: [{ name: 'computed', kind: 'keyword', derive: () => 'x' }],
    };
    expect(() => extractionQuery(empty, searchSchema(empty))).toThrow(
      /no path-bearing field/,
    );
  });
});

describe('inline references (nested template)', () => {
  // Synthetic coverage only: no current consumer (Drapo is labelOnly) exercises
  // an inline reference, so the nested-template shape is pinned here rather than
  // at scale.
  const registration = defineSearchType({
    name: 'Registration',
    fields: [
      { name: 'datePosted', kind: 'date', path: `<${SCHEMA}datePosted>` },
    ],
  });
  const dataset = defineSearchType({
    name: 'Dataset',
    class: `${SCHEMA}Dataset`,
    fields: [
      {
        name: 'registration',
        kind: 'reference',
        array: true,
        path: `<${SCHEMA}subjectOf>`,
        ref: { typeName: 'Registration', strategy: 'inline' },
      },
    ],
  });
  const inlineSchema = searchSchema(dataset, registration);

  it('emits one CONSTRUCT with a nested template linking ?root → ?referent → ?value', () => {
    const query = extractionQuery(dataset, inlineSchema);
    // The reference hop and the referent’s field are both minted, off the two
    // subjects of the nested template.
    expect(templatePredicates(query)).toEqual([
      irAlias(dataset, dataset.fields[0]),
      irAlias(registration, registration.fields[0]),
    ]);
    const [refTriple, valueTriple] = templateTriples(query);
    // ?root <…/registration> ?r ; ?r <…/datePosted> ?v – the link is preserved.
    expect(refTriple.subject).toMatchObject({ value: 'root' });
    expect(valueTriple.subject).toEqual(refTriple.object);
  });

  it('binds the referent even when the reference type has no path-bearing field', () => {
    // A reference type whose only field is derived reaches the graph for nothing
    // of its own, but the reference hop is still emitted so a later derive can
    // read the referent’s @id: the branch binds ?r without a nested union.
    const marker = defineSearchType({
      name: 'Marker',
      fields: [{ name: 'present', kind: 'boolean', derive: () => true }],
    });
    const withMarker = defineSearchType({
      name: 'Dataset',
      class: `${SCHEMA}Dataset`,
      fields: [
        {
          name: 'marker',
          kind: 'reference',
          path: `<${SCHEMA}subjectOf>`,
          ref: { typeName: 'Marker', strategy: 'inline' },
        },
      ],
    });
    const query = extractionQuery(withMarker, searchSchema(withMarker, marker));
    // Only the reference hop is minted (the derived field reads no path).
    expect(templatePredicates(query)).toEqual([
      irAlias(withMarker, withMarker.fields[0]),
    ]);
    // The branch is just `{ ?root <path> ?r }` – one BGP, no nested union.
    const [group] = unionBranches(query);
    expect(group.patterns).toHaveLength(1);
    expect(group.patterns[0]).toMatchObject({ subType: 'bgp' });
  });

  it('silently omits an inline reference the given schema does not declare', () => {
    // Generated against a foreign schema that omits the referent type – the same
    // graceful degradation the projection makes. The resolvable field is still
    // extracted; the unresolvable inline reference contributes nothing.
    const withName = defineSearchType({
      name: 'Dataset',
      class: `${SCHEMA}Dataset`,
      fields: [
        {
          name: 'name',
          kind: 'text',
          path: `<${SCHEMA}name>`,
          locales: ['und'],
        },
        {
          name: 'registration',
          kind: 'reference',
          array: true,
          path: `<${SCHEMA}subjectOf>`,
          ref: { typeName: 'Registration', strategy: 'inline' },
        },
      ],
    });
    const foreignSchema = searchSchema({
      name: 'Other',
      class: 'urn:x:Other',
      fields: [],
    });
    const query = extractionQuery(withName, foreignSchema);
    expect(templatePredicates(query)).toEqual([
      irAlias(withName, withName.fields[0]),
    ]);
  });
});

describe('extraction ⟷ projection contract', () => {
  // The drift guard: every IR Alias the generator mints is one the projection
  // reads, and vice versa. Both derive from the same rule – a path-bearing field,
  // recursing inline referents through their reference type – so a change to
  // either walk that drops or adds a field breaks this test.
  function projectionReads(
    searchType: SearchType,
    schema: SearchSchema,
  ): Set<string> {
    const aliases = new Set<string>();
    for (const field of searchType.fields) {
      if (field.path === undefined) {
        continue;
      }
      aliases.add(irAlias(searchType, field));
      if (field.kind === 'reference' && field.ref?.strategy === 'inline') {
        const referenceType = referenceTypeNamed(schema, field.ref.typeName);
        if (referenceType !== undefined) {
          for (const alias of projectionReads(referenceType, schema)) {
            aliases.add(alias);
          }
        }
      }
    }
    return aliases;
  }

  it('mints exactly the aliases the projection reads, for a labelOnly schema', () => {
    const minted = new Set(
      templatePredicates(extractionQuery(creativeWork, drapoSchema)),
    );
    expect(minted).toEqual(projectionReads(creativeWork, drapoSchema));
  });

  it('mints exactly the aliases the projection reads, through an inline reference', () => {
    const registration = defineSearchType({
      name: 'Registration',
      fields: [
        { name: 'datePosted', kind: 'date', path: `<${SCHEMA}datePosted>` },
      ],
    });
    const dataset = defineSearchType({
      name: 'Dataset',
      class: `${SCHEMA}Dataset`,
      fields: [
        {
          name: 'registration',
          kind: 'reference',
          array: true,
          path: `<${SCHEMA}subjectOf>`,
          ref: { typeName: 'Registration', strategy: 'inline' },
        },
      ],
    });
    const schema = searchSchema(dataset, registration);
    const minted = new Set(
      templatePredicates(extractionQuery(dataset, schema)),
    );
    expect(minted).toEqual(projectionReads(dataset, schema));
  });
});
