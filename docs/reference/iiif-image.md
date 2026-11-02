# @lde/iiif-image

Find the image service in a [IIIF Presentation](https://iiif.io/api/presentation/)
manifest, and read that service’s [Image API](https://iiif.io/api/image/)
`info.json` into dimensions, server limits and a ladder of sizes. Works across
Presentation 2 and 3 and Image API 1, 2 and 3, so the consumer does not need to
know which version a publisher speaks.

```ts
import { fetchPublic, readJson } from '@lde/public-fetch';
import { firstImageService, imageUrl, readImageService } from '@lde/iiif-image';

const manifest = await readJson(await fetchPublic(manifestUrl));
const serviceUrl = firstImageService(manifest);
if (serviceUrl !== undefined) {
  const info = await readJson(await fetchPublic(`${serviceUrl}/info.json`));
  const service = readImageService(serviceUrl, info);
  const smallest = service && imageUrl(service, service.sizes[0]);
}
```

## Installation

```sh
npm install @lde/iiif-image
```

## Finding the image service

`firstImageService(manifest)` returns the base URL of the image service of the
manifest’s first painted image that has one. It opens `Choice` and
`SpecificResource` bodies, and normalises a service stated with a trailing slash
or as its `info.json`.

It walks the plain JSON rather than normalising the manifest, so a defect
elsewhere in a manifest does not hide its service: Deventit Atlantis writes
`"annotations": [null]`, which the normalising parsers that viewers use reject.
That makes it deliberately more tolerant than
[@lde/iiif-validator](./iiif-validator), which reports such a manifest as one
that does not load.

`hasCanvases(document)` tells a manifest without an image service apart from a
document that is not a usable manifest at all, such as an error page served as
JSON. A caller that stores results needs that difference: the first is a fact, the
second is a server misbehaving.

## Reading `info.json`

`readImageService(url, info)` returns an `ImageService`, or `undefined` where the
document does not state its dimensions as positive integers.

| Field                              | Meaning                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `url`                              | The service URL you passed, not the document’s own `id`, which a server behind a proxy may report as an internal one |
| `version`                          | `1`, `2` or `3`                                                                                                      |
| `level`                            | Compliance level `0`, `1` or `2`, or `undefined` where the profile states none                                       |
| `width`, `height`                  | The full image                                                                                                       |
| `maxWidth`, `maxHeight`, `maxArea` | The server’s limits, where it declares them                                                                          |
| `sizes`                            | Whole-image sizes worth requesting, smallest first                                                                   |

Each size says where it comes from, because that says how likely the server is to
have it ready:

- `listed` – a size the server names in `sizes`;
- `tiles` – derived from its tile scale factors;
- `halving` – derived by halving the full image, where the server states neither.

Derived sizes are rounded to the nearest pixel, as servers list them, are at least
64 pixels wide, and stay within the declared limits: asking above a limit answers
404 rather than 400. A level-0 server only serves what it lists, so without a list
it gets no sizes.

## Building image URLs

`imageUrl(service, size, format)` returns the URL of a whole-image rendition in
the canonical form of the service’s version – `w,h` in version 3, `w,` before it,
and the `native` quality in version 1 – so that a server which prepared the size
finds it. `format` defaults to `jpg`, the one format every level must support.

## Fetching

This package does no fetching. Use [@lde/public-fetch](./public-fetch) for
manifests and `info.json` documents taken from other people’s data, and
[@lde/resolver](./resolver) to keep what you learn between runs.
