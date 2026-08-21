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
import {
  fieldNamed,
  irAlias,
  labelSourceNameOf,
  referenceTypeNamed,
  rootTypeNamed,
} from '@lde/search/adapter';
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

      facetable: true,
      output: true,
      ref: { strategy: 'lookup', target: 'Person' },
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

describe('references into a keyed type', () => {
  // A SCHEMA-AP-NDE-shaped place: keyed on its alignment target, so a work
  // referencing it must store that key rather than the publisher’s node IRI.
  const place = defineSearchType({
    name: 'Place',
    class: `${SCHEMA}Place`,
    labelField: 'name',
    key: { field: '_sameAs' },
    fields: [
      {
        name: 'name',
        kind: 'text',
        path: `<${SCHEMA}name>`,
        locales: ['nl', 'und'],
        output: true,
        searchable: { weight: 3 },
      },
      {
        name: '_sameAs',
        kind: 'reference',
        array: true,
        path: `<${SCHEMA}sameAs>`,
      },
    ],
  });
  const work = defineSearchType({
    name: 'CreativeWork',
    class: `${SCHEMA}CreativeWork`,
    fields: [
      {
        name: 'locationCreated',
        kind: 'reference',
        path: `<${SCHEMA}locationCreated>`,
        facetable: true,
        output: true,
        ref: { strategy: 'lookup', target: 'Place' },
      },
    ],
  });
  const keyedSchema = searchSchema(work, place);

  it('extends the reference branch with an OPTIONAL hop under the target’s alias', () => {
    const query = extractionQuery(work, keyedSchema);

    // ?root <…/locationCreated> ?v ; ?v <urn:lde:Place/_sameAs> ?k – the
    // referent’s key is minted against PLACE, the type that declares the field.
    expect(templatePredicates(query)).toEqual([
      irAlias(work, work.fields[0]),
      irAlias(place, place.fields[1]),
    ]);
    const [referenceTriple, keyTriple] = templateTriples(query);
    expect(keyTriple.subject).toEqual(referenceTriple.object);

    // One branch, with the hop OPTIONAL inside it: an unaligned referent keeps
    // its row (and so its own IRI) instead of dropping out of the CONSTRUCT.
    const [group] = unionBranches(query);
    expect(group.patterns).toHaveLength(2);
    expect(group.patterns[0]).toMatchObject({ subType: 'bgp' });
    expect(group.patterns[1]).toMatchObject({ subType: 'optional' });
    expect(extractionQueryString(work, keyedSchema)).toContain('OPTIONAL');
  });

  it('leaves the keyed type’s own extraction unchanged', () => {
    // The key field is an ordinary declared field, so its branch and template
    // triple are already there; keying adds nothing on the root side.
    expect(templatePredicates(extractionQuery(place, keyedSchema))).toEqual([
      irAlias(place, place.fields[0]),
      irAlias(place, place.fields[1]),
    ]);
    expect(unionBranches(extractionQuery(place, keyedSchema))).toHaveLength(2);
  });

  it('adds no hop for a reference that names no target', () => {
    // An idOnly reference with no label source never claimed to hold a
    // collection’s ids, so nothing re-keys it and nothing is extracted for it.
    const unnamed = defineSearchType({
      name: 'Other',
      class: 'urn:x:Other',
      fields: [
        {
          name: 'sameAs',
          kind: 'reference',
          array: true,
          path: `<${SCHEMA}sameAs>`,
          facetable: true,
        },
      ],
    });
    const query = extractionQuery(unnamed, searchSchema(unnamed, place));
    expect(templatePredicates(query)).toEqual([
      irAlias(unnamed, unnamed.fields[0]),
    ]);
    const [group] = unionBranches(query);
    expect(group.patterns).toHaveLength(1);
  });

  it('adds no hop for a target the given schema does not declare', () => {
    // Generated against a foreign schema that omits `Place` – the same graceful
    // degradation an unresolvable inline reference makes.
    const foreignSchema = searchSchema({
      name: 'Other',
      class: 'urn:x:Other',
      fields: [],
    });
    const [group] = unionBranches(extractionQuery(work, foreignSchema));
    expect(group.patterns).toHaveLength(1);
  });

  it('adds no hop for a reference into a target that declares no key', () => {
    const query = extractionQuery(creativeWork, drapoSchema);
    const [, , creatorBranch] = unionBranches(query);
    expect(creatorBranch.patterns).toHaveLength(1);
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
      if (field.kind !== 'reference') {
        continue;
      }
      if (field.ref?.strategy === 'inline') {
        const referenceType = referenceTypeNamed(schema, field.ref.typeName);
        if (referenceType !== undefined) {
          for (const alias of projectionReads(referenceType, schema)) {
            aliases.add(alias);
          }
        }
        continue;
      }
      // A reference into a keyed type: the projection reads the referent’s key
      // candidates off the frame, under the TARGET’s alias for its key field.
      const targetName = labelSourceNameOf(field);
      const target =
        targetName === undefined
          ? undefined
          : rootTypeNamed(schema, targetName);
      const keyField =
        target?.key === undefined
          ? undefined
          : fieldNamed(target, target.key.field);
      if (target !== undefined && keyField !== undefined) {
        aliases.add(irAlias(target, keyField));
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

  it('mints exactly the aliases the projection reads, into a keyed target', () => {
    const place = defineSearchType({
      name: 'Place',
      class: `${SCHEMA}Place`,
      labelField: 'name',
      key: { field: '_sameAs' },
      fields: [
        {
          name: 'name',
          kind: 'text',
          path: `<${SCHEMA}name>`,
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
        },
        {
          name: '_sameAs',
          kind: 'reference',
          array: true,
          path: `<${SCHEMA}sameAs>`,
        },
      ],
    });
    const work = defineSearchType({
      name: 'CreativeWork',
      class: `${SCHEMA}CreativeWork`,
      fields: [
        {
          name: 'locationCreated',
          kind: 'reference',
          path: `<${SCHEMA}locationCreated>`,
          facetable: true,
          ref: { strategy: 'lookup', target: 'Place' },
        },
      ],
    });
    const schema = searchSchema(work, place);
    const minted = new Set(templatePredicates(extractionQuery(work, schema)));
    expect(minted).toEqual(projectionReads(work, schema));
  });
});
