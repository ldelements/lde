import { Liquid } from 'liquidjs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'path';
import type { ContextDefinition, NodeObject } from 'jsonld';

export async function render(
  shapes: NodeObject,
  templatePath: string,
  partialsPath?: string,
): Promise<string> {
  const templatesDir = dirname(templatePath);
  if (partialsPath !== undefined) {
    await assertDirectory(partialsPath);
  }
  const engine = new Liquid({
    root: templatesDir,
    // The template’s own folder comes first, so it can override a shared partial.
    partials:
      partialsPath === undefined ? templatesDir : [templatesDir, partialsPath],
    extname: '.liquid',
  });

  engine.registerFilter(
    'lang',
    (nodes: any | any[] | undefined, language: string) => {
      if (nodes === undefined) {
        return '';
      }

      const filtered = [nodes]
        .flat()
        .filter((node: any) => node['@language'] === language);
      return filtered[0]?.['@value'] ?? '';
    },
  );

  engine.registerFilter('mergePropertiesByPath', (properties: object[]) => {
    const grouped: Record<string, any[]> = properties.reduce(
      (acc: Record<string, any[]>, propertyShape: any) => {
        const path = propertyShape.path;
        acc[path] ??= [];
        acc[path].push(propertyShape);
        return acc;
      },
      {},
    );

    return Object.entries(grouped).map(([_path, propertyShapes]) => {
      const result: { [key: string]: any } = {};
      for (const propertyShape of propertyShapes) {
        for (const key in propertyShape) {
          if (result[key] === undefined && propertyShape[key] !== undefined) {
            result[key] = propertyShape[key];
          }
        }
      }

      return result;
    });
  });

  const prefixes = prefixesOf(shapes['@context']);
  engine.registerFilter('expandIri', (compactIri: unknown) =>
    expandIri(compactIri, prefixes),
  );

  // The root is the template’s folder, so look the template up by its name there.
  return engine.renderFile(basename(templatePath), {
    nodeShapes: shapes['@graph'],
  });
}

/**
 * Fail early on a partials folder that is missing or empty as a path, rather than
 * on the first partial that cannot be found there.
 */
async function assertDirectory(path: string) {
  const isDirectory =
    path !== '' && (await stat(path).catch(() => undefined))?.isDirectory();
  if (!isDirectory) {
    throw new Error(`Partials folder not found: '${path}'`);
  }
}

/**
 * Expand a compact IRI such as `schema:name` with a prefix from the frame’s
 * `@context`. Anything else, such as an absolute IRI or an unknown prefix, is
 * returned unchanged.
 */
function expandIri(compactIri: unknown, prefixes: Map<string, string>) {
  if (typeof compactIri !== 'string') return compactIri;
  const separator = compactIri.indexOf(':');
  if (separator === -1) return compactIri;
  const suffix = compactIri.slice(separator + 1);
  if (suffix.startsWith('//')) return compactIri;
  const namespace = prefixes.get(compactIri.slice(0, separator));
  return namespace === undefined ? compactIri : namespace + suffix;
}

function prefixesOf(context: NodeObject['@context']): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const definition of [context].flat()) {
    if (definition === null || typeof definition !== 'object') continue;
    for (const [term, value] of Object.entries(
      definition as ContextDefinition,
    )) {
      if (term.startsWith('@') || term.includes(':')) continue;
      const iri =
        typeof value === 'string'
          ? value
          : (value as { '@id'?: unknown } | null)?.['@id'];
      // As in JSON-LD 1.1, only a term whose IRI ends in a delimiter is a prefix.
      if (typeof iri === 'string' && /[/#:]$/.test(iri)) {
        prefixes.set(term, iri);
      }
    }
  }
  return prefixes;
}
