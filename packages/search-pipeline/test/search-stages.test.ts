import { describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { Dataset, Distribution } from '@lde/dataset';
import {
  SparqlItemSelector,
  Stage,
  type DatasetWriter,
  type ItemSelector,
  type Reader,
  type VariableBindings,
} from '@lde/pipeline';
import { projectRoots, searchSchema, type RootType } from '@lde/search';
import { irAlias } from '@lde/search/adapter';
import {
  registrySource,
  searchStages,
  selectByClass,
} from '../src/search-stages.js';
import type { TypedSearchDocument } from '../src/typed-search-document.js';

const { namedNode, literal, quad } = DataFactory;

const PERSON = 'https://example.org/Person';
const NAME = 'https://example.org/name';

const schema = searchSchema({
  name: 'Person',
  class: PERSON,
  fields: [{ name: 'name', kind: 'keyword', path: NAME, output: true }],
});
const person = schema.get(PERSON) as RootType;

// The stub reader stands in for the Extraction CONSTRUCT, so it emits each
// value under the field’s IR Alias – the key the projection reads – not the
// source path.
const NAME_ALIAS = irAlias(person, person.fields[0]);

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset/1'),
  distributions: [],
});
const distribution = new Distribution(new URL('http://example.org/sparql'));

async function* stream<Item>(items: readonly Item[]): AsyncIterable<Item> {
  yield* items;
}

/** A selector that yields one `?root` binding per given IRI. */
function rootsSelector(roots: readonly string[]): ItemSelector {
  return {
    select: async function* (): AsyncIterable<VariableBindings> {
      for (const iri of roots) {
        yield { root: namedNode(iri) };
      }
    },
  };
}

/** A reader that emits one `name` triple per root in the batch’s bindings. */
const nameReader: Reader = {
  read: (_dataset, _distribution, options) => {
    const quads: Quad[] = [];
    for (const binding of options?.bindings ?? []) {
      const root = binding.root.value;
      quads.push(
        quad(namedNode(root), namedNode(NAME_ALIAS), literal(`Name ${root}`)),
      );
    }
    return Promise.resolve(stream(quads));
  },
};

describe('searchStages', () => {
  it('projects each root type over its selector’s roots, paired with its type', async () => {
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType: person,
          rootVariable: 'root',
          itemSelector: rootsSelector(['https://ex/p/1', 'https://ex/p/2']),
          readers: nameReader,
        },
      ],
    });

    const received: TypedSearchDocument[] = [];
    const writer: DatasetWriter<TypedSearchDocument> = {
      write: async (_dataset, items) => {
        for await (const item of items) {
          received.push(item);
        }
      },
    };

    await stage.run(dataset, distribution, writer);

    expect(received.map((item) => item.searchType)).toEqual([person, person]);
    expect(received.map((item) => item.document)).toEqual([
      { id: 'https://ex/p/1', name: 'Name https://ex/p/1' },
      { id: 'https://ex/p/2', name: 'Name https://ex/p/2' },
    ]);
  });

  it('projects the batch’s dataset, so a declared field and a derive can see it', async () => {
    // The stage is where the dataset is known: the writer sees it only after
    // projection, which is too late for either.
    const withDataset = searchSchema({
      name: 'Person',
      class: PERSON,
      fields: [
        { name: 'name', kind: 'keyword', path: NAME, output: true },
        {
          name: 'dataset',
          kind: 'reference',
          from: 'dataset',
          output: true,
          facetable: true,
          // No label source: the dataset IRI travels as itself.
          ref: { strategy: 'idOnly', typeName: 'Dataset' },
        },
        {
          name: 'fromDataset',
          kind: 'keyword',
          filterable: true,
          derive: (_document, context) =>
            context.dataset === undefined ? undefined : 'yes',
        },
      ],
    });
    const [stage] = searchStages({
      schema: withDataset,
      types: [
        {
          searchType: withDataset.get(PERSON) as RootType,
          rootVariable: 'root',
          itemSelector: rootsSelector(['https://ex/p/1']),
          readers: nameReader,
        },
      ],
    });

    const received: TypedSearchDocument[] = [];
    const writer: DatasetWriter<TypedSearchDocument> = {
      write: async (_dataset, items) => {
        for await (const item of items) {
          received.push(item);
        }
      },
    };

    await stage.run(dataset, distribution, writer);

    expect(received[0].document.dataset).toBe('http://example.org/dataset/1');
    expect(received[0].document.fromDataset).toBe('yes');
  });

  it('passes what a field could not read on to the pipeline, under the type’s name', async () => {
    const withNumber = searchSchema({
      name: 'Person',
      class: PERSON,
      fields: [
        { name: 'name', kind: 'keyword', path: NAME, output: true },
        {
          name: 'age',
          kind: 'integer',
          output: true,
          derive: (document) => Number(document.name),
        },
      ],
    });
    const [stage] = searchStages({
      schema: withNumber,
      types: [
        {
          searchType: withNumber.get(PERSON) as RootType,
          rootVariable: 'root',
          itemSelector: rootsSelector(['https://ex/p/1']),
          readers: nameReader,
        },
      ],
    });
    const valueUnread = vi.fn();

    await stage.run(
      dataset,
      distribution,
      {
        write: async (_dataset, items) => {
          for await (const item of items) {
            void item;
          }
        },
      },
      { valueUnread },
    );

    expect(valueUnread).toHaveBeenCalledWith('Person', 'age', {
      id: 'https://ex/p/1',
      value: 'NaN',
    });
  });

  it('runs the dataset type first and hands its document to every later stage', async () => {
    const DATASET = 'https://example.org/Dataset';
    const WORK = 'https://example.org/Work';
    const PUBLISHER = 'https://example.org/publisher';
    const withDatasetType = searchSchema(
      {
        name: 'Dataset',
        class: DATASET,
        fields: [
          {
            name: 'label',
            kind: 'text',
            locales: ['und'],
            path: NAME,
            output: true,
            searchable: { weight: 1 },
          },
          {
            name: 'publisher',
            kind: 'reference',
            path: PUBLISHER,
            output: true,
            ref: { strategy: 'idOnly', typeName: 'Publisher' },
          },
        ],
      },
      {
        name: 'Work',
        class: WORK,
        fields: [
          { name: 'name', kind: 'keyword', path: NAME, output: true },
          {
            name: 'dataset',
            kind: 'reference',
            from: 'dataset',
            output: true,
            ref: { strategy: 'lookup', target: 'Dataset' },
          },
          {
            name: 'publisher',
            kind: 'reference',
            facetable: true,
            ref: { strategy: 'idOnly', typeName: 'Publisher' },
            derive: (_document, context) => context.datasetDocument?.publisher,
          },
        ],
      },
    );
    const datasetType = withDatasetType.get(DATASET) as RootType;
    const workType = withDatasetType.get(WORK) as RootType;
    const datasetIri = dataset.iri.toString();
    const publisherAlias = irAlias(datasetType, datasetType.fields[1]);
    const datasetReader: Reader = {
      read: () =>
        Promise.resolve(
          stream([
            quad(
              namedNode(datasetIri),
              namedNode(publisherAlias),
              namedNode('https://ex/publisher/1'),
            ),
          ]),
        ),
    };
    const workReader: Reader = {
      read: (_dataset, _distribution, options) =>
        Promise.resolve(
          stream(
            (options?.bindings ?? []).map((binding) =>
              quad(
                namedNode(binding.root.value),
                namedNode(irAlias(workType, workType.fields[0])),
                literal('A work'),
              ),
            ),
          ),
        ),
    };

    // Listed work first: the order the stages run in is not the order given.
    const types = [
      {
        searchType: workType,
        rootVariable: 'root',
        itemSelector: rootsSelector(['https://ex/w/1', 'https://ex/w/2']),
        readers: workReader,
      },
      {
        searchType: datasetType,
        rootVariable: 'root',
        itemSelector: rootsSelector([datasetIri]),
        readers: datasetReader,
      },
    ];
    const received: TypedSearchDocument[] = [];
    const writer: DatasetWriter<TypedSearchDocument> = {
      write: async (_dataset, items) => {
        for await (const item of items) {
          received.push(item);
        }
      },
    };
    const publishersOfWorks = () =>
      received
        .filter((item) => item.searchType === workType)
        .map((item) => item.document.publisher);

    const stages = searchStages({
      schema: withDatasetType,
      types,
      datasetType: 'Dataset',
    });
    expect(stages.map((stage) => stage.name)).toEqual(['Dataset', 'Work']);
    // A dataset’s stages run one after another, as the pipeline runs them.
    for (const stage of stages) {
      await stage.run(dataset, distribution, writer);
    }
    expect(publishersOfWorks()).toEqual([
      'https://ex/publisher/1',
      'https://ex/publisher/1',
    ]);

    // Another dataset’s works see that dataset’s document, not this one’s.
    const other = new Dataset({
      iri: new URL('http://example.org/dataset/2'),
      distributions: [],
    });
    received.length = 0;
    await stages[1].run(other, distribution, writer);
    expect(publishersOfWorks()).toEqual([undefined, undefined]);

    // Without the option, the order given stands and nothing is copied.
    const unordered = searchStages({ schema: withDatasetType, types });
    expect(unordered.map((stage) => stage.name)).toEqual(['Work', 'Dataset']);
    received.length = 0;
    for (const stage of [...unordered].reverse()) {
      await stage.run(dataset, distribution, writer);
    }
    expect(publishersOfWorks()).toEqual([undefined, undefined]);

    expect(() =>
      searchStages({
        schema: withDatasetType,
        types: [types[0]],
        datasetType: 'Dataset',
      }),
    ).toThrow(/Dataset type “Dataset” has no stage/);
  });

  it('names each stage after its type and yields one stage per type', () => {
    const stages = searchStages({
      schema,
      types: [
        {
          searchType: person,
          rootVariable: 'root',
          itemSelector: rootsSelector([]),
          readers: nameReader,
        },
      ],
    });
    expect(stages).toHaveLength(1);
    expect(stages[0].name).toBe('Person');
  });

  it('projects with the schema’s own declaration even when handed a class-equal lookalike', async () => {
    // A reconstructed object with the same class – `assertTypeInSchema` is an
    // identity check, so searchStages must re-resolve to the schema’s own object.
    const lookalike: RootType = {
      name: 'Person',
      class: PERSON,
      fields: [{ name: 'name', kind: 'keyword', path: NAME, output: true }],
    };
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType: lookalike,
          rootVariable: 'root',
          itemSelector: rootsSelector(['https://ex/p/1']),
          readers: nameReader,
        },
      ],
    });

    const received: TypedSearchDocument[] = [];
    await stage.run(dataset, distribution, {
      write: async (_dataset, items) => {
        for await (const item of items) received.push(item);
      },
    });

    expect(received).toHaveLength(1);
    // Paired with the schema’s own object, not the lookalike.
    expect(received[0].searchType).toBe(person);
  });

  it('throws when a type is not in the schema', () => {
    const foreign: RootType = {
      name: 'Ghost',
      class: 'https://example.org/Ghost',
      fields: [],
    };
    expect(() =>
      searchStages({
        schema,
        types: [
          {
            searchType: foreign,
            rootVariable: 'root',
            itemSelector: rootsSelector([]),
            readers: nameReader,
          },
        ],
      }),
    ).toThrow(/not in the schema/);
  });

  it('refuses a transform alongside the caller’s own readers', () => {
    // Which of several readers the transform belongs to is knowable only to the
    // caller, so this is a mistake to name rather than a default to guess.
    expect(() =>
      searchStages({
        schema,
        types: [
          {
            searchType: person,
            rootVariable: 'root',
            itemSelector: rootsSelector([]),
            readers: nameReader,
            transform: async function* (quads) {
              yield* quads;
            },
          },
        ],
      }),
    ).toThrow(/cannot be combined with “readers”/);
  });

  it('fails clearly when the selector does not bind the stage’s rootVariable', async () => {
    // The stage reads ?subject, but `rootsSelector` binds ?root – a config
    // mismatch. The batch deref must throw a named error, not an opaque
    // `Cannot read properties of undefined`.
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType: person,
          rootVariable: 'subject',
          itemSelector: rootsSelector(['https://ex/p/1']),
          readers: nameReader,
        },
      ],
    });

    const writer: DatasetWriter<TypedSearchDocument> = {
      write: async (_dataset, items) => {
        for await (const _item of items) {
          // drain
        }
      },
    };

    await expect(stage.run(dataset, distribution, writer)).rejects.toThrow(
      /did not bind \?subject/,
    );
  });
});

describe('selectByClass', () => {
  it('builds a SPARQL selector for the type’s source class', () => {
    const selector = selectByClass(person);
    expect(selector).toBeInstanceOf(SparqlItemSelector);
  });

  it('accepts a custom root variable', () => {
    expect(() => selectByClass(person, 'subject')).not.toThrow();
  });

  it('excludes blank-node subjects at the endpoint', async () => {
    // A blank node has no stable document key, so it can never become a search
    // document (framing skips it). Filtering at the endpoint also keeps result
    // pages full, so pagination is not cut short by client-side dropped rows.
    expect(await sentQuery()).toMatch(/isblank\(\?root\)/i);
  });

  it('selects each root once', async () => {
    // A root typed in several named graphs matches once per graph on an engine
    // whose default graph is their union (QLever); without DISTINCT, each copy
    // costs a batch slot and a re-read of the same root.
    expect(await sentQuery()).toMatch(/SELECTDISTINCT\?root/i);
  });

  it('restricts the roots by a graph pattern, keeping blank nodes out', async () => {
    const query = await sentQuery(
      '?root <https://example.org/about> <https://example.org/term/1>',
    );
    expect(query).toContain(
      '?root<https://example.org/about><https://example.org/term/1>',
    );
    expect(query).toMatch(/isblank\(\?root\)/i);
  });

  it('keeps a UNION or a trailing comment inside its own group', async () => {
    const query = await sentQuery(
      '{ ?root <https://example.org/p> <https://example.org/a> } UNION { ?root <https://example.org/p> <https://example.org/b> } # either',
    );
    // Both branches stay under the class constraint and the blank-node filter.
    expect(query).toMatch(
      /<https:\/\/example\.org\/Person>\.\{\{.*\}UNION\{.*\}\}FILTER/,
    );
    expect(query).toMatch(/isblank\(\?root\)/i);
  });

  it('rejects a pattern that does not parse', () => {
    expect(() => selectByClass(person, 'root', '?root <unclosed')).toThrow();
  });

  it('rejects a pattern that does not constrain the root variable', () => {
    // Joined to nothing, it would restrict nothing.
    expect(() =>
      selectByClass(person, 'work', '?root <https://example.org/p> ?o'),
    ).toThrow(/must constrain \?work/);
  });

  async function sentQuery(pattern?: string): Promise<string> {
    let query = '';
    nock('http://example.org')
      .post('/sparql')
      .reply(
        200,
        (_uri, requestBody) => {
          query = decodeURIComponent(String(requestBody).replace(/\+/g, ' '));
          return { head: { vars: ['root'] }, results: { bindings: [] } };
        },
        { 'Content-Type': 'application/sparql-results+json' },
      );

    const selector = selectByClass(person, 'root', pattern);
    for await (const row of selector.select(distribution, 10)) {
      void row;
    }

    return query.replace(/\s+/g, '');
  }
});

describe('registrySource', () => {
  const REGISTRY = new URL('http://registry.example.org/sparql');

  it('reads the registry endpoint, scoped to the dataset’s own graph', () => {
    const source = registrySource(REGISTRY)(dataset, distribution);

    expect(source.accessUrl.toString()).toBe(REGISTRY.toString());
    // The register names each registration’s graph after the dataset IRI, so
    // scoping to it is what keeps a per-dataset pass from indexing the whole
    // catalogue.
    expect(source.namedGraph).toBe('http://example.org/dataset/1');
    expect(source.isSparql()).toBe(true);
  });

  it('leaves a local file reading its own data, having no registration', () => {
    const local = Dataset.localFile('/rdf/extra.ttl');

    expect(registrySource(REGISTRY)(local, distribution)).toBe(distribution);
  });

  it('reads the register for a registered dataset whose data is a local file', () => {
    const registered = new Dataset({
      iri: new URL('http://example.org/dataset/1'),
      distributions: [Distribution.localFile('/rdf/extra.ttl')],
    });

    expect(registrySource(REGISTRY)(registered, distribution).namedGraph).toBe(
      'http://example.org/dataset/1',
    );
  });

  it('scopes per dataset, not per pipeline', () => {
    const sourceFor = registrySource(REGISTRY);
    const other = new Dataset({
      iri: new URL('http://example.org/dataset/2'),
      distributions: [],
    });

    expect(sourceFor(dataset, distribution).namedGraph).toBe(
      'http://example.org/dataset/1',
    );
    expect(sourceFor(other, distribution).namedGraph).toBe(
      'http://example.org/dataset/2',
    );
  });

  it('routes a type’s selector and readers alike', async () => {
    // Selection and extraction must meet the same source: roots selected from
    // the registry and quads read from the dataset’s distribution would join on
    // nothing.
    const seen: Distribution[] = [];
    const selector: ItemSelector = {
      select: async function* (
        source: Distribution,
      ): AsyncIterable<VariableBindings> {
        seen.push(source);
        yield { root: namedNode('https://ex/p/1') };
      },
    };
    const reader: Reader = {
      read: (_dataset, source, options) => {
        seen.push(source);
        const quads = (options?.bindings ?? []).map((binding) =>
          quad(
            namedNode(binding.root.value),
            namedNode(NAME_ALIAS),
            literal('Name'),
          ),
        );
        return Promise.resolve(stream(quads));
      },
    };
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType: person,
          rootVariable: 'root',
          itemSelector: selector,
          readers: reader,
          sourceFor: registrySource(REGISTRY),
        },
      ],
    });

    const received: TypedSearchDocument[] = [];
    await stage.run(dataset, distribution, {
      write: async (_dataset, items) => {
        for await (const item of items) {
          received.push(item);
        }
      },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0].accessUrl.toString()).toBe(REGISTRY.toString());
    expect(received.map((item) => item.document)).toEqual([
      { id: 'https://ex/p/1', name: 'Name' },
    ]);
  });

  it('leaves an unrouted type on the dataset’s own distribution', async () => {
    const seen: Distribution[] = [];
    const reader: Reader = {
      read: (_dataset, source) => {
        seen.push(source);
        return Promise.resolve(stream<Quad>([]));
      },
    };
    const [stage] = searchStages({
      schema,
      types: [
        {
          searchType: person,
          rootVariable: 'root',
          itemSelector: rootsSelector(['https://ex/p/1']),
          readers: reader,
        },
      ],
    });

    await stage.run(dataset, distribution, {
      write: async (_dataset, items) => {
        for await (const item of items) {
          void item;
        }
      },
    });

    expect(seen[0]).toBe(distribution);
  });
});

describe('memory is bounded by batchSize, not the input (counting, not measuring)', () => {
  const BATCH_SIZE = 10;

  /**
   * Run one projecting stage over `rootCount` synthetic roots and record what
   * the batch structures actually held. The `project` closure mirrors what
   * {@link searchStages} builds, wrapped to count invocations and gauge live
   * documents; `maxConcurrency` and `queueCapacity` are pinned to 1 so the
   * per-batch peak is deterministic and independent of the batch count.
   */
  async function runOver(rootCount: number) {
    const roots = Array.from(
      { length: rootCount },
      (_, index) => `https://ex/p/${index}`,
    );

    const quadsPerProject: number[] = [];
    let liveDocuments = 0;
    let peakLiveDocuments = 0;

    const stage = new Stage<TypedSearchDocument>({
      name: 'Person',
      readers: nameReader,
      itemSelector: rootsSelector(roots),
      batchSize: BATCH_SIZE,
      maxConcurrency: 1,
      queueCapacity: 1,
      project: async function* (quads, context) {
        quadsPerProject.push(quads.length);
        const batchRoots = context.bindings.map(
          (binding) => binding.root.value,
        );
        for await (const document of projectRoots(
          quads,
          batchRoots,
          schema,
          person,
        )) {
          liveDocuments += 1;
          peakLiveDocuments = Math.max(peakLiveDocuments, liveDocuments);
          yield { searchType: person, document };
        }
      },
    });

    const writer: DatasetWriter<TypedSearchDocument> = {
      write: async (_dataset, items) => {
        for await (const _item of items) {
          // A document reaches the terminal and is released: no longer live.
          liveDocuments -= 1;
        }
      },
    };

    await stage.run(dataset, distribution, writer);

    return {
      projectInvocations: quadsPerProject.length,
      maxQuadsPerProject: Math.max(...quadsPerProject),
      peakLiveDocuments,
    };
  }

  it('projects once per batch and never grows a structure with the input', async () => {
    const small = await runOver(10);
    const large = await runOver(10_000);

    // (a) project is invoked exactly ceil(roots / batchSize) times.
    expect(small.projectInvocations).toBe(1);
    expect(large.projectInvocations).toBe(1000);

    // (b) the largest batch handed to project is one batchSize either way – one
    // name quad per root, so batchSize quads – never the whole input.
    expect(small.maxQuadsPerProject).toBe(BATCH_SIZE);
    expect(large.maxQuadsPerProject).toBe(BATCH_SIZE);

    // (c) the peak number of documents alive between projection and the writer
    // is identical at both input sizes – the whole point of #606. A buffering
    // writer’s peak would be every document (10 vs 10 000), so this equality
    // fails against it and holds here.
    expect(large.peakLiveDocuments).toBe(small.peakLiveDocuments);
    // …and it is a small constant, nowhere near the 10 000 roots.
    expect(large.peakLiveDocuments).toBeLessThanOrEqual(BATCH_SIZE);
    // 10 000 roots take about 2 s locally, and past the 5 s default on a busy
    // CI runner.
  }, 30_000);
});
