import { describe, expect, it, vi } from 'vitest';
import { Dataset } from '@lde/dataset';
import {
  ManualDatasetSelection,
  Pipeline,
  type ProvenanceStore,
  type Writer,
} from '@lde/pipeline';
import { searchSchema, type RootType, type SearchDocument } from '@lde/search';
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
});
