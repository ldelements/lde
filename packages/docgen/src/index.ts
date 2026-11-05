import { parseRdfToJsonLd } from './parse.js';
import { frame } from './frame.js';
import { render, type DocumentationOptions } from './render.js';

export type { DocumentationOptions } from './render.js';

/**
 * Generate documentation from a SHACL shapes file using a Liquid template.
 *
 * @param rdfPath Path to a SHACL shapes file in any RDF serialization.
 * @param templatePath Path to a Liquid template.
 * @param framePath Optional path to a JSON-LD frame. When provided, it is
 *   deep-merged on top of docgen’s built-in default frame, so consumers only
 *   need to specify their additions (e.g. extra `@context` entries).
 * @param options.contexts Local files to read JSON-LD contexts from instead of
 *   the web, keyed by the context URL, for the `jsonLdToTurtle` filter.
 */
export async function generateDocumentation(
  rdfPath: string,
  templatePath: string,
  framePath?: string,
  options: DocumentationOptions = {},
): Promise<string> {
  const jsonld = await parseRdfToJsonLd(rdfPath);
  const framed = await frame(jsonld, framePath);

  return render(framed, templatePath, options);
}
