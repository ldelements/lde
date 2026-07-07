import { mergeNamespaceVariants } from '../src/index.js';
import type { NamespaceAlias } from '../src/index.js';
import { Dataset, Distribution } from '@lde/dataset';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { describe, it, expect } from 'vitest';

const { namedNode, literal, quad } = DataFactory;

const schemaOrg: NamespaceAlias[] = [
  { canonical: 'https://schema.org/', alias: 'http://schema.org/' },
];

const DATASET = 'http://example.org/dataset';
const VOID = 'http://rdfs.org/ns/void#';
const VOID_EXT = 'http://ldf.fi/void-ext#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

// MD5s produced by the queries’ SPARQL `MD5(STR(?type))`, verified against the
// live endpoint (issue #334): the two CreativeWork partition hashes.
const HTTP_CW_HASH = '243a6fef650ffe66d349d33dab497039';
const HTTPS_CW_HASH = 'abb86c011bcc584d50e50bf8f079120a';

const cp = (hash: string) => `${DATASET}/.well-known/void#class-${hash}`;

function v(local: string) {
  return namedNode(`${VOID}${local}`);
}
function ve(local: string) {
  return namedNode(`${VOID_EXT}${local}`);
}
function integer(value: number) {
  return literal(String(value), namedNode(`${XSD}integer`));
}

const context = {
  dataset: new Dataset({ iri: new URL(DATASET), distributions: [] }),
  distribution: Distribution.sparql(new URL('http://example.org/sparql')),
  stage: 'test',
};

async function run(
  input: Quad[],
  aliases: NamespaceAlias[] = schemaOrg,
): Promise<Quad[]> {
  const transform = mergeNamespaceVariants(aliases);
  const source = (async function* () {
    yield* input;
  })();
  const out: Quad[] = [];
  for await (const q of transform(source, context)) out.push(q);
  return out;
}

function objectsOf(quads: Quad[], subject: string, predicate: string) {
  return quads
    .filter(
      (q) => q.subject.value === subject && q.predicate.value === predicate,
    )
    .map((q) => q.object.value);
}

describe('mergeNamespaceVariants', () => {
  it('mints the canonical class-partition IRI matching the SPARQL MD5', async () => {
    const input = [
      quad(
        namedNode(cp(HTTP_CW_HASH)),
        v('class'),
        namedNode('http://schema.org/CreativeWork'),
      ),
      quad(
        namedNode(DATASET),
        v('classPartition'),
        namedNode(cp(HTTP_CW_HASH)),
      ),
      quad(namedNode(cp(HTTP_CW_HASH)), v('entities'), integer(3278)),
    ];
    const out = await run(input);

    // The http variant is re-keyed onto the canonical https hash.
    const partitions = objectsOf(out, DATASET, `${VOID}classPartition`);
    expect(partitions).toEqual([cp(HTTPS_CW_HASH)]);
  });

  it('merges the two CreativeWork class partitions into one, summing entities', async () => {
    const input = [
      quad(
        namedNode(DATASET),
        namedNode(`${XSD}../1999/02/22-rdf-syntax-ns#type`),
        v('Dataset'),
      ),
      quad(
        namedNode(DATASET),
        v('classPartition'),
        namedNode(cp(HTTP_CW_HASH)),
      ),
      quad(
        namedNode(cp(HTTP_CW_HASH)),
        v('class'),
        namedNode('http://schema.org/CreativeWork'),
      ),
      quad(namedNode(cp(HTTP_CW_HASH)), v('entities'), integer(3278)),
      quad(
        namedNode(DATASET),
        v('classPartition'),
        namedNode(cp(HTTPS_CW_HASH)),
      ),
      quad(
        namedNode(cp(HTTPS_CW_HASH)),
        v('class'),
        namedNode('https://schema.org/CreativeWork'),
      ),
      quad(namedNode(cp(HTTPS_CW_HASH)), v('entities'), integer(511)),
    ];
    const out = await run(input);

    const partitions = objectsOf(out, DATASET, `${VOID}classPartition`);
    expect(partitions).toEqual([cp(HTTPS_CW_HASH)]);
    expect(objectsOf(out, cp(HTTPS_CW_HASH), `${VOID}class`)).toEqual([
      'https://schema.org/CreativeWork',
    ]);
    expect(objectsOf(out, cp(HTTPS_CW_HASH), `${VOID}entities`)).toEqual([
      '3789',
    ]);
  });

  it('merges a datatype-partition subtree via the cp→pp→dp chain', async () => {
    // Two full chains, http and https, over the same canonical class+property+datatype.
    const chain = (classIri: string, propIri: string) => {
      const cpNode = namedNode(`${DATASET}/#cp`); // placeholder IRIs; transform re-keys by components
      const ppNode = namedNode(`${DATASET}/#pp-${classIri}-${propIri}`);
      const dpNode = namedNode(`${DATASET}/#dp-${classIri}-${propIri}`);
      return [
        quad(cpNode, v('class'), namedNode(classIri)),
        quad(cpNode, v('propertyPartition'), ppNode),
        quad(ppNode, v('property'), namedNode(propIri)),
        quad(ppNode, ve('datatypePartition'), dpNode),
        quad(dpNode, ve('datatype'), namedNode(`${XSD}string`)),
        quad(dpNode, v('triples'), integer(3)),
      ];
    };
    const input = [
      ...chain('http://schema.org/CreativeWork', 'http://schema.org/name'),
      ...chain('https://schema.org/CreativeWork', 'https://schema.org/name'),
    ];
    const out = await run(input);

    const datatypePartitions = out.filter(
      (q) => q.predicate.value === `${VOID_EXT}datatype`,
    );
    expect(datatypePartitions).toHaveLength(1);
    const dp = datatypePartitions[0].subject.value;
    expect(objectsOf(out, dp, `${VOID}triples`)).toEqual(['6']);
    // Class and property canonicalized to https.
    const properties = out
      .filter((q) => q.predicate.value === `${VOID}property`)
      .map((q) => q.object.value);
    expect(new Set(properties)).toEqual(new Set(['https://schema.org/name']));
  });

  it('merges object-class partitions, canonicalizing the object class', async () => {
    const chain = (
      classIri: string,
      propIri: string,
      objectClassIri: string,
    ) => {
      const cpNode = namedNode(`${DATASET}/#cp-${classIri}`);
      const ppNode = namedNode(`${DATASET}/#pp-${classIri}-${propIri}`);
      const ocpNode = namedNode(
        `${DATASET}/#ocp-${classIri}-${propIri}-${objectClassIri}`,
      );
      return [
        quad(cpNode, v('class'), namedNode(classIri)),
        quad(cpNode, v('propertyPartition'), ppNode),
        quad(ppNode, v('property'), namedNode(propIri)),
        quad(ppNode, ve('objectClassPartition'), ocpNode),
        quad(ocpNode, v('class'), namedNode(objectClassIri)),
        quad(ocpNode, v('triples'), integer(2)),
      ];
    };
    const input = [
      ...chain(
        'http://schema.org/CreativeWork',
        'http://schema.org/author',
        'http://schema.org/Person',
      ),
      ...chain(
        'https://schema.org/CreativeWork',
        'https://schema.org/author',
        'https://schema.org/Person',
      ),
    ];
    const out = await run(input);

    const objectClassPartitions = out.filter(
      (q) =>
        q.predicate.value === `${VOID}class` &&
        q.object.value.endsWith('/Person'),
    );
    expect(objectClassPartitions).toHaveLength(1);
    expect(objectClassPartitions[0].object.value).toBe(
      'https://schema.org/Person',
    );
    const ocp = objectClassPartitions[0].subject.value;
    expect(objectsOf(out, ocp, `${VOID}triples`)).toEqual(['4']);
  });

  it('merges language partitions by (class, property, lang)', async () => {
    const chain = (classIri: string, propIri: string) => {
      const cpNode = namedNode(`${DATASET}/#cp-${classIri}`);
      const ppNode = namedNode(`${DATASET}/#pp-${classIri}-${propIri}`);
      const lpNode = namedNode(`${DATASET}/#lp-${classIri}-${propIri}`);
      return [
        quad(cpNode, v('class'), namedNode(classIri)),
        quad(cpNode, v('propertyPartition'), ppNode),
        quad(ppNode, v('property'), namedNode(propIri)),
        quad(ppNode, ve('languagePartition'), lpNode),
        quad(lpNode, ve('language'), literal('nl')),
        quad(lpNode, v('triples'), integer(5)),
      ];
    };
    const input = [
      ...chain('http://schema.org/CreativeWork', 'http://schema.org/name'),
      ...chain('https://schema.org/CreativeWork', 'https://schema.org/name'),
    ];
    const out = await run(input);

    const languagePartitions = out.filter(
      (q) => q.predicate.value === `${VOID_EXT}language`,
    );
    expect(languagePartitions).toHaveLength(1);
    const lp = languagePartitions[0].subject.value;
    expect(objectsOf(out, lp, `${VOID}triples`)).toEqual(['10']);
  });

  it('leaves a non-integer measure literal as a zero-summed passthrough', async () => {
    const input = [
      quad(
        namedNode(DATASET),
        v('classPartition'),
        namedNode(cp(HTTP_CW_HASH)),
      ),
      quad(
        namedNode(cp(HTTP_CW_HASH)),
        v('class'),
        namedNode('http://schema.org/CreativeWork'),
      ),
      quad(namedNode(cp(HTTP_CW_HASH)), v('entities'), literal('not-a-number')),
    ];
    const out = await run(input);
    expect(objectsOf(out, cp(HTTPS_CW_HASH), `${VOID}entities`)).toEqual(['0']);
  });

  it('leaves a partition node missing its components unremapped', async () => {
    // A class partition whose node carries no void:class, and a property
    // partition whose parent class is absent: neither can be re-keyed, so both
    // pass through untouched.
    const orphanProperty = namedNode(`${DATASET}/#orphan-pp`);
    const input = [
      quad(
        namedNode(DATASET),
        v('classPartition'),
        namedNode(cp(HTTP_CW_HASH)),
      ),
      // no void:class on the class partition
      quad(namedNode(cp(HTTP_CW_HASH)), v('entities'), integer(3278)),
      // property partition with no reachable parent class
      quad(orphanProperty, v('property'), namedNode('http://schema.org/name')),
      quad(orphanProperty, v('entities'), integer(1)),
    ];
    const out = await run(input);
    // Neither node is re-keyed (both lack the components to mint a canonical
    // IRI), so their subjects are unchanged.
    expect(objectsOf(out, DATASET, `${VOID}classPartition`)).toEqual([
      cp(HTTP_CW_HASH),
    ]);
    expect(objectsOf(out, orphanProperty.value, `${VOID}entities`)).toEqual([
      '1',
    ]);
    // The void:property *object* is still canonicalized (that is unconditional).
    expect(objectsOf(out, orphanProperty.value, `${VOID}property`)).toEqual([
      'https://schema.org/name',
    ]);
  });

  it('is a no-op with no aliases configured', async () => {
    const input = [
      quad(
        namedNode(DATASET),
        v('classPartition'),
        namedNode(cp(HTTP_CW_HASH)),
      ),
      quad(
        namedNode(cp(HTTP_CW_HASH)),
        v('class'),
        namedNode('http://schema.org/CreativeWork'),
      ),
      quad(namedNode(cp(HTTP_CW_HASH)), v('entities'), integer(3278)),
    ];
    const out = await run(input, []);
    expect(out).toEqual(input);
  });

  it('passes non-partition quads through unchanged', async () => {
    const unrelated = quad(
      namedNode('http://example.org/thing'),
      namedNode('http://purl.org/dc/terms/title'),
      literal('Untitled'),
    );
    const out = await run([unrelated]);
    expect(out).toEqual([unrelated]);
  });
});
