import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { injectValues } from '@lde/pipeline';
import { Parser } from '@traqula/parser-sparql-1-1';
import {
  AstFactory,
  type Path,
  type Pattern,
  type PatternGroup,
  type PatternValues,
  type QueryConstruct,
  type TripleNesting,
} from '@traqula/rules-sparql-1-1';
import { defineSearchType, searchSchema } from '@lde/search';
import {
  fieldNamed,
  irAlias,
  localLookupTargetsOf,
  referencedTargetsOf,
  referenceTypeNamed,
} from '@lde/search/adapter';
import type { SearchSchema, SearchType } from '@lde/search';
import { extractionQuery, extractionQueryString } from '../src/extraction.js';

const SCHEMA = 'https://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
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

// The qualified-relation shape: the work points at a Role, which carries a value
// of its own and resolves an agent the referring document also describes.
const agent = defineSearchType({
  name: 'Agent',
  class: `${SCHEMA}Person`,
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      path: `<${SCHEMA}name>`,
      locales: ['und'],
      output: true,
      searchable: { weight: 5 },
    },
    {
      name: 'birthDate',
      kind: 'date',
      path: `<${SCHEMA}birthDate>`,
      output: true,
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
      output: true,
      filterable: true,
      path: `<${SCHEMA}creator>`,
      ref: { strategy: 'lookup', target: 'Agent', local: true },
    },
  ],
});

const roleWork = defineSearchType({
  name: 'CreativeWork',
  class: `${SCHEMA}CreativeWork`,
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

const roleSchema = searchSchema(roleWork, agent, creatorRole);

/**
 * The template triples, each narrowed from the broader BGP element type. A
 * merged plain read’s `?s ?alias ?o` is expanded into one triple per alias its
 * `VALUES` table emits, in table order – the triples the query actually mints.
 */
function templateTriples(query: QueryConstruct): TripleNesting[] {
  return query.template.triples.flatMap((triple) => {
    if (!factory.isTriple(triple)) {
      throw new Error('expected a plain triple in the CONSTRUCT template');
    }
    const predicate = triple.predicate;
    if (!factory.isTermVariable(predicate)) {
      return [triple];
    }
    const table = valuesBinding(query.where, predicate.value);
    if (table === undefined) {
      throw new Error(`no VALUES table binds ?${predicate.value}`);
    }
    return table.values.map((row) => ({
      ...triple,
      predicate: row[predicate.value] as TripleNesting['predicate'],
    }));
  });
}

/** The `VALUES` table anywhere in a WHERE that binds the given variable. */
function valuesBinding(
  pattern: Pattern,
  variable: string,
): PatternValues | undefined {
  return valuesTables(pattern).find((table) =>
    table.variables.some((candidate) => candidate.value === variable),
  );
}

/** The first `VALUES` table in a pattern, depth first. */
function firstValues(pattern: Pattern): PatternValues | undefined {
  return valuesTables(pattern)[0];
}

/** Every `VALUES` table in a pattern, depth first. */
function valuesTables(pattern: Pattern): PatternValues[] {
  if (factory.isPatternValues(pattern)) {
    return [pattern as PatternValues];
  }
  const children = (pattern as { patterns?: Pattern[] }).patterns ?? [];
  return children.flatMap(valuesTables);
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

/** The one template triple minted under an alias – the link a nested walk
 *  follows from a reference to the values read off its referent. */
function tripleUnder(query: QueryConstruct, alias: string): TripleNesting {
  const [triple] = templateTriples(query).filter((candidate) => {
    const predicate = candidate.predicate;
    return factory.isTermNamed(predicate) && predicate.value === alias;
  });
  if (triple === undefined) {
    throw new Error(`no template triple under ${alias}`);
  }
  return triple;
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

  it('reads the plain fields in one branch through a VALUES table, not a conjunction', () => {
    // One triple pattern, `?root ?p ?o`, joined with a table of the fields’
    // predicates – never one BGP conjoining all paths (that cross-product is
    // what inflates a multi-valued result ~4×). Each row binds one field.
    const [branch, ...others] = unionBranches(
      extractionQuery(creativeWork, drapoSchema),
    );
    expect(others).toHaveLength(0);
    const [bgp, table] = branch.patterns;
    expect(bgp).toMatchObject({ subType: 'bgp', triples: [{}] });
    expect(table).toMatchObject({ subType: 'values' });
    expect(
      (table as PatternValues).values.map((row) =>
        Object.values(row).map((term) => term?.value),
      ),
    ).toEqual(
      creativeWork.fields.map((field) => [
        field.path?.slice(1, -1),
        irAlias(creativeWork, field),
      ]),
    );
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
    expect(query).toContain('VALUES');
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

  it('keeps a literal stated in place of the node through an empty branch', () => {
    // A literal has no values of its own, so without a branch of its own it
    // would drop out of the nested union and never reach the projection.
    const propertyValue = defineSearchType({
      name: 'PropertyValue',
      literalField: 'value',
      fields: [{ name: 'value', kind: 'keyword', path: `<${SCHEMA}value>` }],
    });
    const work = defineSearchType({
      name: 'Work',
      class: `${SCHEMA}CreativeWork`,
      fields: [
        {
          name: 'identifier',
          kind: 'reference',
          array: true,
          path: `<${SCHEMA}identifier>`,
          ref: { typeName: 'PropertyValue', strategy: 'inline' },
        },
      ],
    });
    const plain = defineSearchType({
      name: 'PropertyValue',
      fields: propertyValue.fields,
    });

    /** Whether the reference’s nested union has a branch reading nothing. */
    const hasEmptyBranch = (forSchema: SearchSchema): boolean => {
      const [group] = unionBranches(extractionQuery(work, forSchema));
      const nested = group.patterns.find((pattern) =>
        factory.isPatternUnion(pattern),
      );
      return (
        nested !== undefined &&
        factory.isPatternUnion(nested) &&
        nested.patterns.some((branch) => branch.patterns.length === 0)
      );
    };

    expect(hasEmptyBranch(searchSchema(work, propertyValue))).toBe(true);
    expect(hasEmptyBranch(searchSchema(work, plain))).toBe(false);
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
    // The key field is an ordinary declared field, so its read and template
    // triple are already there; keying adds nothing on the root side. Both are
    // plain reads, so they share one branch.
    expect(templatePredicates(extractionQuery(place, keyedSchema))).toEqual([
      irAlias(place, place.fields[0]),
      irAlias(place, place.fields[1]),
    ]);
    expect(unionBranches(extractionQuery(place, keyedSchema))).toHaveLength(1);
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
    // The creator is then a plain read, merged with the other fields: a row of
    // their table, with no hop, so nothing optional and no triple read off the
    // referent.
    const query = extractionQuery(creativeWork, drapoSchema);
    const [branch] = unionBranches(query);
    const table = firstValues(branch);
    expect(
      table?.values.map((row) => Object.values(row).map((term) => term?.value)),
    ).toContainEqual([
      `${SCHEMA}creator`,
      irAlias(creativeWork, creativeWork.fields[2]),
    ]);
    expect(extractionQueryString(creativeWork, drapoSchema)).not.toContain(
      'OPTIONAL',
    );
    expect(
      templateTriples(query).every(
        (triple) =>
          factory.isTermVariable(triple.subject) &&
          triple.subject.value === 'root',
      ),
    ).toBe(true);
  });
});

describe('local lookups (the referent’s own fields)', () => {
  it('mints the target’s own fields under the TARGET’s aliases', () => {
    // Without these the referent is stored by id alone, and a referent the
    // graph named inline – which has no id – comes back empty.
    expect(templatePredicates(extractionQuery(roleWork, roleSchema))).toEqual(
      expect.arrayContaining([
        irAlias(agent, agent.fields[0]),
        irAlias(agent, agent.fields[1]),
      ]),
    );
  });

  it('reads them off the referent, not off the root', () => {
    const query = extractionQuery(roleWork, roleSchema);
    const nameTriple = tripleUnder(query, irAlias(agent, agent.fields[0]));
    const agentTriple = tripleUnder(
      query,
      irAlias(creatorRole, creatorRole.fields[1]),
    );

    // The same variable the reference’s own template triple binds – the
    // subject → referent → value link the projection walks back down.
    expect(nameTriple.subject).toEqual(agentTriple.object);
    expect(nameTriple.subject).toMatchObject({ subType: 'variable' });
  });

  it('reads them in an OPTIONAL, so a referent stated by id alone keeps its row', () => {
    // A `local` lookup stores its referent whether or not the referring
    // document says anything about it; conjoining the two would drop the id
    // along with the absent name. Asserted on the branch rather than on the
    // query text, so it stays about *this* nesting rather than about any
    // OPTIONAL anywhere – a keyed target brings one of its own.
    // The inline reference's branch nests a union of the edge type's own
    // fields; the local expansion sits inside the endpoint field's group.
    const [creatorBranch] = unionBranches(
      extractionQuery(roleWork, roleSchema),
    );
    const edgeFields = creatorBranch.patterns[1];
    if (edgeFields === undefined || !factory.isPatternUnion(edgeFields)) {
      throw new Error('expected the edge type’s fields in a nested union');
    }
    const [, agentBranch] = edgeFields.patterns;
    const [referentHop, nested] = agentBranch?.patterns ?? [];

    // The hop that binds the referent is conjoined: the entry itself is not
    // optional, only what this document says about its endpoint.
    expect(referentHop !== undefined && factory.isPatternBgp(referentHop)).toBe(
      true,
    );
    expect(nested).toMatchObject({ type: 'pattern', subType: 'optional' });
  });

  it('states a keyed target’s key field once, not twice', () => {
    // The key hop and the local expansion both reach it; only one may emit it.
    const keyedAgent = defineSearchType({
      name: 'Agent',
      class: `${SCHEMA}Person`,
      labelField: 'name',
      key: { field: '_sameAs' },
      fields: [
        {
          name: 'name',
          kind: 'text',
          path: `<${SCHEMA}name>`,
          locales: ['und'],
          output: true,
          searchable: { weight: 5 },
        },
        {
          name: '_sameAs',
          kind: 'reference',
          array: true,
          path: `<${SCHEMA}sameAs>`,
        },
      ],
    });
    const keyed = searchSchema(roleWork, keyedAgent, creatorRole);
    const keyAlias = irAlias(keyedAgent, keyedAgent.fields[1]);

    const minted = templatePredicates(extractionQuery(roleWork, keyed));

    expect(minted.filter((predicate) => predicate === keyAlias)).toHaveLength(
      1,
    );
  });

  it('leaves the reference standing where the target states nothing to read', () => {
    // A target whose every field is computed: legal, and it contributes no
    // branch – so there must be no empty OPTIONAL wrapped around nothing.
    const computed = defineSearchType({
      name: 'Agent',
      class: `${SCHEMA}Person`,
      labelField: 'name',
      fields: [
        {
          name: 'name',
          kind: 'text',
          locales: ['und'],
          output: true,
          searchable: { weight: 1 },
          derive: () => 'anonymous',
        },
      ],
    });
    const bare = searchSchema(roleWork, computed, creatorRole);

    const query = extractionQueryString(roleWork, bare);

    expect(query).not.toContain('OPTIONAL');
    // The referent is still stored by id, which is a plain lookup’s whole job.
    expect(templatePredicates(extractionQuery(roleWork, bare))).toContain(
      irAlias(creatorRole, creatorRole.fields[1]),
    );
  });

  it('stops at a type already on the path, so two mutually local types terminate', () => {
    // `searchSchema` rejects inline reference cycles; nothing forbids this one.
    const left = defineSearchType({
      name: 'Left',
      class: `${SCHEMA}Left`,
      labelField: 'name',
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
          name: 'other',
          kind: 'reference',
          array: true,
          output: true,
          path: `<${SCHEMA}knows>`,
          ref: { strategy: 'lookup', target: 'Right', local: true },
        },
      ],
    });
    const right = defineSearchType({
      name: 'Right',
      class: `${SCHEMA}Right`,
      labelField: 'name',
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
          name: 'other',
          kind: 'reference',
          array: true,
          output: true,
          path: `<${SCHEMA}knows>`,
          ref: { strategy: 'lookup', target: 'Left', local: true },
        },
      ],
    });
    const cyclic = searchSchema(left, right);

    // One hop out and back to the boundary, never further: `Left`’s own fields,
    // `Right`’s read off the referent, and `Right`’s own `other` by id alone.
    // Asserted as a list rather than a set – both types declare the same field
    // names, so a second lap would re-emit aliases a set has already absorbed
    // and the cut could slip a level without the assertion noticing.
    expect(templatePredicates(extractionQuery(left, cyclic))).toEqual([
      irAlias(left, left.fields[0]),
      irAlias(left, left.fields[1]),
      irAlias(right, right.fields[0]),
      irAlias(right, right.fields[1]),
    ]);
    // …and the last of them is read off the referent the one before it bound,
    // which is what makes “one lap” a statement about depth.
    const query = extractionQuery(left, cyclic);
    expect(tripleUnder(query, irAlias(right, right.fields[1])).subject).toEqual(
      tripleUnder(query, irAlias(left, left.fields[1])).object,
    );
  });
});

describe('extraction ⟷ projection contract', () => {
  // The drift guard: every IR Alias the generator mints is one the projection
  // reads, and vice versa. Both derive from the same rule – a path-bearing field,
  // recursing inline referents through their reference type – so a change to
  // either walk that drops or adds a field breaks this test.
  //
  // `visiting` is a bound this model has and the projection does NOT: the real
  // projection (`projectDocument`) walks whatever the frame handed it and is
  // bounded by the frame alone. It is here only so a cyclic schema terminates,
  // and it means this guard cannot answer *where* the two should stop – only
  // that they agree on the aliases in an acyclic one, which is every schema it
  // is called with. The depths themselves are pinned by `inlineFramingDepth`'s
  // own tests and by the cut test above.
  function projectionReads(
    searchType: SearchType,
    schema: SearchSchema,
    visiting: ReadonlySet<string> = new Set(),
  ): Set<string> {
    const aliases = new Set<string>();
    const onPath = new Set(visiting).add(searchType.name);
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
          for (const alias of projectionReads(referenceType, schema, onPath)) {
            aliases.add(alias);
          }
        }
        continue;
      }
      // A `local` lookup: the projection shapes the referent through the
      // TARGET’s own declaration, so it reads that type’s aliases off it.
      const local = localLookupTargetsOf(field, schema).filter(
        (target) => !onPath.has(target.name),
      );
      for (const target of local) {
        for (const alias of projectionReads(target, schema, onPath)) {
          aliases.add(alias);
        }
      }
      // A reference into a keyed type: the projection reads the referent’s key
      // candidates off the frame, under the TARGET’s alias for its key field.
      for (const target of referencedTargetsOf(field, schema)) {
        if (local.includes(target)) {
          continue;
        }
        const keyField =
          target.key === undefined
            ? undefined
            : fieldNamed(target, target.key.field);
        if (keyField !== undefined) {
          aliases.add(irAlias(target, keyField));
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

  it('mints exactly the aliases the projection reads, through a local lookup', () => {
    const minted = new Set(
      templatePredicates(extractionQuery(roleWork, roleSchema)),
    );
    expect(minted).toEqual(projectionReads(roleWork, roleSchema));
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

describe('plain reads', () => {
  const organization = defineSearchType({
    name: 'Organization',
    class: `${SCHEMA}Organization`,
    labelField: 'name',
    fields: [
      {
        name: 'name',
        kind: 'text',
        path: `<${SCHEMA}name>`,
        locales: ['und'],
        output: true,
        searchable: { weight: 5 },
      },
    ],
  });
  const work = defineSearchType({
    name: 'Work',
    class: `${SCHEMA}CreativeWork`,
    fields: [
      {
        name: 'creator',
        kind: 'reference',
        array: true,
        output: true,
        path: `<${SCHEMA}creator>`,
        ref: {
          strategy: 'lookup',
          target: ['Agent', 'Organization'],
          local: true,
        },
      },
    ],
  });
  const schema = searchSchema(work, agent, organization);

  /** The rows of the VALUES table under a reference’s OPTIONAL. */
  function referentReads(query: QueryConstruct): string[][] {
    const [branch] = unionBranches(query);
    const optional = branch.patterns[1];
    if (optional === undefined || !factory.isPatternOptional(optional)) {
      throw new Error('expected the referent’s reads in an OPTIONAL');
    }
    const table = firstValues(optional);
    if (table === undefined) {
      throw new Error('expected the referent’s plain reads in a VALUES table');
    }
    return table.values.map((row) =>
      Object.values(row).map((term) => term?.value ?? ''),
    );
  }

  it('reads a predicate several targets share once, emitting it for each', () => {
    // `name` is Agent’s and Organization’s: one row each, off the one scan.
    expect(referentReads(extractionQuery(work, schema))).toEqual([
      [RDF_TYPE, RDF_TYPE],
      [`${SCHEMA}name`, irAlias(agent, agent.fields[0])],
      [`${SCHEMA}birthDate`, irAlias(agent, agent.fields[1])],
      [`${SCHEMA}name`, irAlias(organization, organization.fields[0])],
    ]);
  });

  it('leaves a subject’s only plain read a branch of its own', () => {
    const single = defineSearchType({
      name: 'Single',
      class: `${SCHEMA}CreativeWork`,
      fields: [
        {
          name: 'name',
          kind: 'text',
          path: `<${SCHEMA}name>`,
          locales: ['und'],
          output: true,
        },
      ],
    });
    const query = extractionQueryString(single, searchSchema(single));
    expect(query).not.toContain('VALUES');
    expect(query).toContain(`?root <${SCHEMA}name>`);
  });

  it('keeps the roots injectable into every branch, the merged one included', () => {
    // `injectValues` puts the roots into each top-level branch only if every
    // branch binds ?root in a leading triple pattern.
    const injected = injectValues(extractionQuery(creativeWork, drapoSchema), [
      { root: DataFactory.namedNode('https://example.org/work') },
    ]);
    for (const branch of unionBranches(injected)) {
      expect(
        branch.patterns.some(
          (pattern) =>
            factory.isPatternValues(pattern) &&
            pattern.variables.some((variable) => variable.value === 'root'),
        ),
      ).toBe(true);
    }
  });
});
