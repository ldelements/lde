import type { ImportFailed } from '@lde/sparql-importer';
import { hashSuffix, skolemIri } from '@lde/dataset';
import { DataFactory, type Quad } from 'n3';
import {
  NetworkError,
  SparqlProbeResult,
  DataDumpProbeResult,
  type ProbeResultType,
} from '@lde/distribution-probe';
import { rdf, _void, xsd } from '@tpluscode/rdf-ns-builders';
import namespace from '@rdfjs/namespace';

const { quad, namedNode, literal } = DataFactory;

// Custom namespaces not covered by the bundled builders: the bundled `schema`
// builder is `http://schema.org/`, but this output normalises to the `https://`
// scheme, and the HTTP status-codes vocabulary is not bundled at all.
const schema = namespace('https://schema.org/');
const httpStatus = namespace('https://www.w3.org/2011/http-statusCodes#');

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

    yield quad(action, rdf.type, schema.Action);
    yield quad(action, schema.target, namedNode(result.url));

    if (result instanceof NetworkError) {
      yield quad(action, schema.error, literal(result.message));
    } else if (result.isSuccess()) {
      yield* successQuads(action, result, datasetIri);
      for (const warning of result.warnings) {
        yield quad(action, schema.error, literal(warning));
      }
    } else if (result.failureReason) {
      yield quad(action, schema.error, literal(result.failureReason));
    } else {
      // HTTP error
      yield quad(
        action,
        schema.error,
        httpStatus[result.statusText.replace(/ /g, '')],
      );
    }
  }

  if (importResult) {
    const action = actionsByUrl.get(
      importResult.distribution.accessUrl.toString(),
    );
    if (action) {
      yield quad(action, schema.error, literal(importResult.error));
    }
  }
}

function* successQuads(
  action: ReturnType<typeof namedNode>,
  result: SparqlProbeResult | DataDumpProbeResult,
  datasetIri: string,
): Iterable<Quad> {
  const distributionUrl = namedNode(result.url);

  yield quad(action, schema.result, distributionUrl);

  if (result.lastModified) {
    yield quad(
      distributionUrl,
      schema.dateModified,
      literal(result.lastModified.toISOString(), xsd.dateTime),
    );
  }

  if (result instanceof SparqlProbeResult) {
    yield quad(namedNode(datasetIri), _void.sparqlEndpoint, distributionUrl);
  } else {
    yield quad(namedNode(datasetIri), _void.dataDump, distributionUrl);

    if (result.contentSize) {
      yield quad(
        distributionUrl,
        schema.contentSize,
        literal(result.contentSize.toString()),
      );
    }

    if (result.contentType) {
      yield quad(
        distributionUrl,
        schema.encodingFormat,
        literal(result.contentType),
      );
    }
  }
}
