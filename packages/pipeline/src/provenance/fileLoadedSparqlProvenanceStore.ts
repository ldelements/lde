import { Dataset, assertSafeIri } from '@lde/dataset';
import type { Quad, Term } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint';
import { prov, rdf, xsd } from '@tpluscode/rdf-ns-builders';
import namespace from '@rdfjs/namespace';
import { FileWriter } from '../writer/fileWriter.js';
import type { ProcessingRecord } from './record.js';
import type { ProvenanceStore } from './store.js';

const { namedNode, literal, quad } = DataFactory;

// Custom namespace for this pipeline’s flat PROV-O records; not a standard
// vocabulary, so it has no bundled builder.
const lde = namespace('https://w3id.org/lde/provenance#');

export interface FileLoadedSparqlProvenanceStoreOptions {
  /** Read-only SPARQL endpoint to query for previously-loaded records. */
  queryEndpoint: URL;
  /**
   * The pipeline’s IRI, used as the named graph that scopes this pipeline’s
   * records so multiple pipelines sharing one triplestore do not collide.
   */
  pipelineIri: URL;
  /**
   * Directory the records are written to as files, to be bulk-loaded into the
   * read-only triplestore after the run. Kept separate from the data output
   * directory so filenames (keyed by dataset URI) never collide.
   */
  outputDir: string;
  /**
   * Optional {@link SparqlEndpointFetcher} for the query side, intended for
   * tests. Defaults to a fresh instance.
   */
  fetcher?: SparqlEndpointFetcher;
}

/**
 * A {@link ProvenanceStore} for a triplestore that is served read-only and
 * rebuilt by bulk-loading files (e.g. QLever).
 *
 * Reads through SPARQL queries against the live endpoint (records loaded from
 * a previous run); writes the records as files for the next bulk-load, since
 * the endpoint accepts no SPARQL UPDATE. Records are flat PROV-O keyed by the
 * dataset URI, written into the pipeline-scoped provenance named graph.
 */
export class FileLoadedSparqlProvenanceStore implements ProvenanceStore {
  private readonly queryEndpoint: URL;
  private readonly pipelineIri: URL;
  private readonly writer: FileWriter;
  private readonly fetcher: SparqlEndpointFetcher;

  constructor(options: FileLoadedSparqlProvenanceStoreOptions) {
    this.queryEndpoint = options.queryEndpoint;
    this.pipelineIri = options.pipelineIri;
    this.writer = new FileWriter({
      outputDir: options.outputDir,
      format: 'n-quads',
      graphIri: () => this.pipelineIri,
    });
    this.fetcher = options.fetcher ?? new SparqlEndpointFetcher();
  }

  async get(datasetUri: URL): Promise<ProcessingRecord | null> {
    const stream = (await this.fetcher.fetchBindings(
      this.queryEndpoint.toString(),
      this.selectQuery(datasetUri),
    )) as AsyncIterable<Record<string, Term>>;

    for await (const binding of stream) {
      // A record exists iff the mandatory fields bound; the fingerprint is
      // optional and absent for a run with no establishable signal.
      return {
        sourceFingerprint: binding.fingerprint?.value ?? null,
        pipelineVersion: binding.version.value,
        generatedAt: binding.generatedAt.value,
        status: binding.status.value as ProcessingRecord['status'],
      };
    }

    return null;
  }

  private selectQuery(datasetUri: URL): string {
    // Guard before interpolating into a SPARQL `<…>` reference, mirroring
    // SparqlUpdateWriter. URL normalisation already encodes unsafe characters,
    // so this is defence-in-depth against a non-normalised IRI reaching here.
    const datasetIri = datasetUri.toString();
    const pipelineIri = this.pipelineIri.toString();
    assertSafeIri(datasetIri);
    assertSafeIri(pipelineIri);
    const dataset = `<${datasetIri}>`;
    return `SELECT ?fingerprint ?version ?status ?generatedAt WHERE {
      GRAPH <${pipelineIri}> {
        ${dataset} <${lde.pipelineVersion.value}> ?version ;
                   <${lde.status.value}> ?status ;
                   <${prov.generatedAtTime.value}> ?generatedAt .
        OPTIONAL { ${dataset} <${lde.sourceFingerprint.value}> ?fingerprint }
      }
    } LIMIT 1`;
  }

  async set(datasetUri: URL, record: ProcessingRecord): Promise<void> {
    const dataset = new Dataset({ iri: datasetUri, distributions: [] });
    await this.writer.write(dataset, this.toQuads(datasetUri, record));
    await this.writer.flush(dataset);
  }

  private async *toQuads(
    datasetUri: URL,
    record: ProcessingRecord,
  ): AsyncIterable<Quad> {
    const subject = namedNode(datasetUri.toString());

    yield quad(subject, rdf.type, prov.Entity);
    yield quad(
      subject,
      prov.generatedAtTime,
      literal(record.generatedAt, xsd.dateTime),
    );
    if (record.sourceFingerprint !== null) {
      yield quad(
        subject,
        lde.sourceFingerprint,
        literal(record.sourceFingerprint),
      );
    }
    yield quad(subject, lde.pipelineVersion, literal(record.pipelineVersion));
    yield quad(subject, lde.status, literal(record.status));
  }
}
