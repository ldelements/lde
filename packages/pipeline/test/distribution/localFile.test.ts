import { Dataset, Distribution } from '@lde/dataset';
import { ImportSuccessful, type Importer } from '@lde/sparql-importer';
import type { SparqlServer } from '@lde/sparql-server';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ImportResolver,
  NoDistributionAvailable,
  ResolvedDistribution,
  SparqlDistributionResolver,
} from '../../src/distribution/index.js';
import { sourceFingerprint } from '../../src/provenance/sourceFingerprint.js';

const endpoint = new URL('http://localhost:7001/sparql');

function makeResolver(importer: Importer): ImportResolver {
  const server: SparqlServer = {
    queryEndpoint: endpoint,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return new ImportResolver(new SparqlDistributionResolver(), {
    importer,
    server,
  });
}

describe('ImportResolver with a local file', () => {
  let directory: string;
  let path: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'resolve-local-file-'));
    path = join(directory, 'data.ttl');
    await writeFile(path, '<urn:s> <urn:p> <urn:o> .\n');
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('imports the file and resolves to the local endpoint', async () => {
    const dataset = Dataset.localFile(path);
    const importer: Importer = {
      import: vi.fn(
        async ([candidate]: Distribution[]) => new ImportSuccessful(candidate!),
      ),
    };
    const resolver = makeResolver(importer);

    const probed = await resolver.probe(dataset);
    const resolved = await resolver.resolve(probed);

    expect(importer.import).toHaveBeenCalledWith(dataset.distributions);
    expect(resolved).toBeInstanceOf(ResolvedDistribution);
    expect((resolved as ResolvedDistribution).distribution.accessUrl).toEqual(
      endpoint,
    );
  });

  it('fingerprints the file, so an unchanged one can be skipped', async () => {
    const resolver = makeResolver({ import: vi.fn() });

    const { source } = await resolver.probe(Dataset.localFile(path));

    expect(
      sourceFingerprint(source!.distribution, source!.probeResult),
    ).toMatch(/^\d{4}-.*Z\|26$/);
  });

  it('does not import a file: URL a registry described', async () => {
    const importer: Importer = { import: vi.fn() };
    const resolver = makeResolver(importer);
    const dataset = new Dataset({
      iri: new URL('https://example.org/dataset'),
      distributions: [new Distribution(pathToFileURL(path), 'text/turtle')],
    });

    const probed = await resolver.probe(dataset);
    const resolved = await resolver.resolve(probed);

    expect(importer.import).not.toHaveBeenCalled();
    expect(resolved).toBeInstanceOf(NoDistributionAvailable);
  });
});
