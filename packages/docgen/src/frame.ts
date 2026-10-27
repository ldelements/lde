import type { Frame, JsonLdArray } from 'jsonld/jsonld-spec.js';
import type { NodeObject } from 'jsonld';
import jsonld from 'jsonld';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const defaultFramePath = join(__dirname, '../frames/shacl.frame.jsonld');

// jsonld.frame relabels blank nodes and sorts them by label as a string, so its
// output does not keep the order of its input. Each node carries its position
// through framing under this key, which is removed afterwards.
const positionKey = 'urn:lde:docgen:position';

/**
 * Frames the shapes, keeping the order of `document` in the `@graph`.
 */
export async function frame(
  document: JsonLdArray,
  userFramePath?: string,
): Promise<NodeObject> {
  const defaultFrame = await readFrame(defaultFramePath);
  const mergedFrame = userFramePath
    ? deepMerge(defaultFrame, await readFrame(userFramePath))
    : defaultFrame;

  const positioned = document.map((node, position) => ({
    ...node,
    [positionKey]: [{ '@value': position }],
  })) as JsonLdArray;

  const framed = await jsonld.frame(positioned, mergedFrame, {
    omitGraph: false,
    embed: '@always',
  });

  return listOrAlternatives(inInputOrder(framed));
}

async function readFrame(path: string): Promise<Frame> {
  return JSON.parse(await readFile(path, 'utf8')) as Frame;
}

/**
 * Sorts the framed `@graph` by each node’s position in the input, then drops
 * the position from every node, including the copies embedded in other nodes.
 */
function inInputOrder(framed: NodeObject): NodeObject {
  const graph = [...(framed['@graph'] as NodeObject[])].sort(
    (first, second) =>
      (first[positionKey] as number) - (second[positionKey] as number),
  );
  return withoutPosition({ ...framed, '@graph': graph });
}

function withoutPosition<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(withoutPosition) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== positionKey) {
      result[key] = withoutPosition(child);
    }
  }
  return result as T;
}

/**
 * Recursively merges `source` into `target`, returning a new object. Plain
 * objects are merged key-by-key; arrays and primitives in `source` replace
 * those in `target`. Used to compose a user-supplied JSON-LD frame on top of
 * docgen’s built-in default so consumers only need to specify their additions.
 */
function deepMerge(target: Frame, source: Frame): Frame {
  const result = { ...(target as Record<string, unknown>) };
  for (const [key, sourceValue] of Object.entries(
    source as Record<string, unknown>,
  )) {
    const targetValue = result[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      result[key] = deepMerge(targetValue as Frame, sourceValue as Frame);
    } else {
      result[key] = sourceValue;
    }
  }
  return result as Frame;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns every `or` value into an array of `sh:or` lists, each list an array of
 * alternatives. A shape may carry several `sh:or` lists, which a JSON-LD
 * `@list` container cannot hold – it keeps one and drops the rest – so the
 * frame leaves `or` without a container and the `{ "@list": […] }` objects it
 * yields are unwrapped here.
 */
function listOrAlternatives<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(listOrAlternatives) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] =
      key === 'or'
        ? [child]
            .flat()
            .map((list) =>
              listOrAlternatives((list as { '@list': unknown })['@list']),
            )
        : listOrAlternatives(child);
  }
  return result as T;
}
