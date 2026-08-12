import { describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { Dataset, Distribution } from '@lde/dataset';
import {
  ManualDatasetSelection,
  Pipeline,
  type ProvenanceStore,
  type Writer,
} from '@lde/pipeline';
import { searchSchema, type RootType, type SearchDocument } from '@lde/search';
import type { Quad } from '@rdfjs/types';
import { searchIndexerPipeline } from '../src/search-indexer-pipeline.js';

const DATASET = 'https://example.org/Dataset';
const ORGANIZATION = 'https://example.org/Organization';

const schema = searchSchema(
  {
    name: 'Dataset',
    class: DATASET,
    fields: [
      {
        name: 'title',
        kind: 'keyword',
        path: '<https://example.org/title>',
        output: true,
      },
    ],
  },
  {
    name: 'Organization',
    class: ORGANIZATION,
    fields: [
      {
        name: 'name',
        kind: 'keyword',
        path: '<https://example.org/name>',
        output: true,
      },
    ],
  },
);

const engineWriter: Writer<SearchDocument> = {
  openRun: async () => ({
    write: async () => undefined,
    commit: async () => undefined,
    abort: async () => undefined,
  }),
};

describe('searchIndexerPipeline', () => {
  it('wires a Pipeline from a dataset list, one engine writer per root type', () => {
    const writerFor = vi.fn((_searchType: RootType) => engineWriter);
    const pipeline = searchIndexerPipeline({
      schema,
      datasets: [
        new Dataset({
          iri: new URL('http://example.org/dataset/1'),
          distributions: [],
        }),
      ],
      writerFor,
    });

    expect(pipeline).toBeInstanceOf(Pipeline);
    // One engine writer per root type in the schema, built eagerly.
    expect(writerFor).toHaveBeenCalledTimes(2);
    expect(writerFor.mock.calls.map(([type]) => type)).toEqual([
      schema.get(DATASET),
      schema.get(ORGANIZATION),
    ]);
  });

  it('accepts a DatasetSelector for dynamic selection', () => {
    const pipeline = searchIndexerPipeline({
      schema,
      datasets: new ManualDatasetSelection([]),
      writerFor: () => engineWriter,
    });
    expect(pipeline).toBeInstanceOf(Pipeline);
  });

  it('rejects a provenance store without a pipeline version', () => {
    const provenanceStore: ProvenanceStore = {
      get: async () => null,
      set: async () => undefined,
    };
    expect(() =>
      searchIndexerPipeline({
        schema,
        datasets: [],
        writerFor: () => engineWriter,
        provenanceStore,
      }),
    ).toThrow(/pipelineVersion is required/);
  });

  describe('registryTypes', () => {
    const registry = {
      endpoint: new URL('http://registry.example.org/sparql'),
      names: ['Dataset'],
    };

    it('routes only the named types to the registry endpoint', async () => {
      // Observable end to end: the routed type selects and extracts against the
      // registry, scoped to the dataset’s graph, while the unrouted one stays on
      // the dataset’s own distribution.
      const endpoints: string[] = [];
      const queries: string[] = [];
      for (const host of [
        'http://registry.example.org',
        'http://data.example.org',
      ]) {
        nock(host)
          .post('/sparql')
          .times(4)
          .reply(
            200,
            (_uri, body) => {
              endpoints.push(host);
              queries.push(
                decodeURIComponent(String(body).replace(/\+/g, ' ')),
              );
              return { head: { vars: ['root'] }, results: { bindings: [] } };
            },
            { 'Content-Type': 'application/sparql-results+json' },
          );
      }

      const dataset = new Dataset({
        iri: new URL('http://example.org/dataset/1'),
        distributions: [
          Distribution.sparql(new URL('http://data.example.org/sparql')),
        ],
      });
      await searchIndexerPipeline({
        schema,
        datasets: [dataset],
        writerFor: () => engineWriter,
        registryTypes: registry,
      }).run();

      const registryQueries = queries.filter(
        (_query, index) => endpoints[index] === 'http://registry.example.org',
      );
      expect(registryQueries).toHaveLength(1);
      expect(registryQueries[0]).toContain(DATASET);
      // Scoped to the registration’s own graph, so a per-dataset pass never
      // walks the whole register.
      expect(registryQueries[0]).toContain(
        'FROM <http://example.org/dataset/1>',
      );

      const dataQueries = queries.filter(
        (_query, index) => endpoints[index] === 'http://data.example.org',
      );
      expect(dataQueries.some((query) => query.includes(ORGANIZATION))).toBe(
        true,
      );
      // The dataset’s own endpoint is never asked for the registry-sourced
      // type, and nothing sent there is graph-scoped.
      expect(dataQueries.some((query) => query.includes(DATASET))).toBe(false);
      expect(dataQueries.some((query) => query.includes('FROM'))).toBe(false);
    });

    it('leaves every type on the distribution when unset', () => {
      expect(() =>
        searchIndexerPipeline({
          schema,
          datasets: [],
          writerFor: () => engineWriter,
        }),
      ).not.toThrow();
    });

    it('rejects a name the schema does not declare', () => {
      // Otherwise silent: the type would read the dataset’s distribution, find
      // no dataset description there and ship an empty collection.
      expect(() =>
        searchIndexerPipeline({
          schema,
          datasets: [],
          writerFor: () => engineWriter,
          registryTypes: { ...registry, names: ['Datasets'] },
        }),
      ).toThrow(/Unknown registry root type\(s\) “Datasets”/);
    });
  });

  describe('transforms', () => {
    it('attaches a transform to the named type’s reader only', async () => {
      // End to end: the transform sees the type’s extracted quads, and the
      // other type’s stage runs untouched – so a deployment adds behaviour
      // without hand-composing a Pipeline and losing everything else this
      // convenience wires.
      const seen: { stage: string; subjects: string[] }[] = [];
      const transform = async function* (
        quads: AsyncIterable<Quad>,
        context: { stage: string },
      ) {
        const subjects: string[] = [];
        for await (const quad of quads) {
          subjects.push(quad.subject.value);
          yield quad;
        }
        seen.push({ stage: context.stage, subjects });
      };

      nock('http://data.example.org')
        .post('/sparql')
        .times(10)
        .reply((_uri, body) => {
          const query = decodeURIComponent(String(body).replace(/\+/g, ' '));
          if (query.includes('CONSTRUCT')) {
            return [
              200,
              '<http://example.org/org/1> <https://example.org/name> "ACME" .\n',
              { 'Content-Type': 'application/n-triples' },
            ];
          }
          // One root per type, so each stage forms a batch and runs its reader.
          return [
            200,
            {
              head: { vars: ['root'] },
              results: {
                bindings: [
                  { root: { type: 'uri', value: 'http://example.org/org/1' } },
                ],
              },
            },
            { 'Content-Type': 'application/sparql-results+json' },
          ];
        });

      await searchIndexerPipeline({
        schema,
        datasets: [
          new Dataset({
            iri: new URL('http://example.org/dataset/1'),
            distributions: [
              Distribution.sparql(new URL('http://data.example.org/sparql')),
            ],
          }),
        ],
        writerFor: () => engineWriter,
        transforms: { Organization: transform },
      }).run();

      expect(seen.map((each) => each.stage)).toEqual(['Organization']);
      expect(seen[0]?.subjects).toContain('http://example.org/org/1');
    });

    it('rejects a name the schema does not declare', () => {
      // Otherwise silent: the transform would attach to nothing and the
      // collection would ship unenriched.
      expect(() =>
        searchIndexerPipeline({
          schema,
          datasets: [],
          writerFor: () => engineWriter,
          transforms: {
            Organisation: async function* (quads) {
              yield* quads;
            },
          },
        }),
      ).toThrow(/Unknown transform type\(s\) “Organisation”/);
    });
  });
});
