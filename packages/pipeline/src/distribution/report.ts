import type { ImportFailed } from '@lde/sparql-importer';
import { hashSuffix, skolemIri } from '@lde/dataset';
import { DataFactory, type Quad } from 'n3';
import {
  NetworkError,
  SparqlProbeResult,
  DataDumpProbeResult,
  type ProbeResultType,
} from '@lde/distribution-probe';

const { quad, namedNode, literal } = DataFactory;

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'https://schema.org/';
const VOID = 'http://rdfs.org/ns/void#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const HTTP_STATUS = 'https://www.w3.org/2011/http-statusCodes#';

/**
 * Convert probe results into RDF quads describing each probe as a `schema:Action`.
 *
 * Successful SPARQL probes emit `void:sparqlEndpoint`;
 * successful data-dump probes emit `void:dataDump` with optional metadata.
 * Failed probes emit `schema:error`.
 *
 * When an {@link ImportFailed} is provided its error is attached to the action
 * whose `schema:target` matches the failed distribution's access URL.
 */
export async function* probeResultsToQuads(
  probeResults: ProbeResultType[],
  datasetIri: string,
  importResult?: ImportFailed,
): AsyncIterable<Quad> {
  // Track each action node per URL so import errors can reference the right
  // action. Each action is a deterministic IRI keyed on (dataset, URL), not a
  // blank node: this output is merged with other datasets' into one cat-built
  // graph where blank-node labels are not unique across documents and would
  // fuse unrelated actions into one node (see issue #474). The
  // `.well-known/schema#action-<hash>` shape mirrors the linkset skolem.
  const actionBase = `${datasetIri}/.well-known/schema#action`;
  const actionsByUrl = new Map<string, ReturnType<typeof namedNode>>();

  for (const result of probeResults) {
    const action = namedNode(skolemIri(actionBase, hashSuffix(result.url)));
    actionsByUrl.set(result.url, action);

    yield quad(action, namedNode(`${RDF}type`), namedNode(`${SCHEMA}Action`));
    yield quad(action, namedNode(`${SCHEMA}target`), namedNode(result.url));

    if (result instanceof NetworkError) {
      yield quad(action, namedNode(`${SCHEMA}error`), literal(result.message));
    } else if (result.isSuccess()) {
      yield* successQuads(action, result, datasetIri);
      for (const warning of result.warnings) {
        yield quad(action, namedNode(`${SCHEMA}error`), literal(warning));
      }
    } else if (result.failureReason) {
      yield quad(
        action,
        namedNode(`${SCHEMA}error`),
        literal(result.failureReason),
      );
    } else {
      // HTTP error
      const statusUri = `${HTTP_STATUS}${result.statusText.replace(/ /g, '')}`;
      yield quad(action, namedNode(`${SCHEMA}error`), namedNode(statusUri));
    }
  }

  if (importResult) {
    const action = actionsByUrl.get(
      importResult.distribution.accessUrl.toString(),
    );
    if (action) {
      yield quad(
        action,
        namedNode(`${SCHEMA}error`),
        literal(importResult.error),
      );
    }
  }
}

function* successQuads(
  action: ReturnType<typeof namedNode>,
  result: SparqlProbeResult | DataDumpProbeResult,
  datasetIri: string,
): Iterable<Quad> {
  const distributionUrl = namedNode(result.url);

  yield quad(action, namedNode(`${SCHEMA}result`), distributionUrl);

  if (result.lastModified) {
    yield quad(
      distributionUrl,
      namedNode(`${SCHEMA}dateModified`),
      literal(result.lastModified.toISOString(), namedNode(`${XSD}dateTime`)),
    );
  }

  if (result instanceof SparqlProbeResult) {
    yield quad(
      namedNode(datasetIri),
      namedNode(`${VOID}sparqlEndpoint`),
      distributionUrl,
    );
  } else {
    yield quad(
      namedNode(datasetIri),
      namedNode(`${VOID}dataDump`),
      distributionUrl,
    );

    if (result.contentSize) {
      yield quad(
        distributionUrl,
        namedNode(`${SCHEMA}contentSize`),
        literal(result.contentSize.toString()),
      );
    }

    if (result.contentType) {
      yield quad(
        distributionUrl,
        namedNode(`${SCHEMA}encodingFormat`),
        literal(result.contentType),
      );
    }
  }
}
