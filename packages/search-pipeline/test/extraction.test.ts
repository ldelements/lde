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
  localLookupTypeOf,
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
      name: 'role',
      kind: 'keyword',
      array: true,
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
      const local = localLookupTypeOf(field, schema);
      if (local !== undefined && !onPath.has(local.name)) {
        for (const alias of projectionReads(local, schema, onPath)) {
          aliases.add(alias);
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
