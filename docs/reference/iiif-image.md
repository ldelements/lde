# @lde/iiif-image

Find the image service in a [IIIF Presentation](https://iiif.io/api/presentation/)
manifest, and read that service’s [Image API](https://iiif.io/api/image/)
`info.json` into dimensions and a ladder of sizes. Works across
Presentation 2 and 3 and Image API 1, 2 and 3, so the consumer does not need to
know which version a publisher speaks.

```ts
import { fetchPublic } from '@lde/public-fetch';
import { imageServices, readImageService } from '@lde/iiif-image';

const manifest = await (await fetchPublic(manifestUrl)).json();
const [serviceUrl] = imageServices(manifest);
if (serviceUrl !== undefined) {
  const info = await (await fetchPublic(`${serviceUrl}/info.json`)).json();
  const thumbnail = readImageService(serviceUrl, info)?.sizes[0]?.url;
}
```

## Installation

```sh
npm install @lde/iiif-image
```

## Finding the image service

`imageServices(manifest)` yields the base URL of the image service of each
painted image, in the order the manifest paints them; destructure the first for a
cover image, and the canvases after it are not walked. A Presentation 2 manifest
is upgraded whole first, so there it costs the same either way. It opens `Choice`
and `SpecificResource` bodies, and normalises a service stated with a trailing
slash or as its `info.json`. Like any iterator, its result can be read once.

It walks the plain JSON rather than normalising the manifest, so a defect
elsewhere in a manifest does not hide its services: Deventit Atlantis writes
`"annotations": [null]`, which the normalising parsers that viewers use reject.
That makes it deliberately more tolerant than
[@lde/iiif-validator](./iiif-validator), which reports such a manifest as one
that does not load.

It throws a `TypeError` for a document that is not a manifest it can read: one
without canvases, such as an error page served as JSON or a collection, or a
Presentation 2 manifest the upgrade rejects. A caller that stores results needs
that difference: a manifest without image services is a fact about its images,
the other is not, and the caller decides whether to retry it or remember it.

## Reading `info.json`

`readImageService(url, info)` returns an `ImageService`, or `undefined` where the
document does not state its dimensions as positive integers.

| Field             | Meaning                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `url`             | The service URL you passed, not the document’s own `id`, which a server behind a proxy may report as an internal one |
| `width`, `height` | The full image                                                                                                       |
| `sizes`           | Whole-image JPEG renditions worth requesting, smallest first, each with its `width`, `height` and `url`              |

The sizes are the ones the server lists. Where it lists none, they are derived
from its tile scale factors, or else by halving the full image. Derived sizes are rounded to the nearest pixel, as servers list them, are at least
64 pixels wide, and stay within the declared limits: asking above a limit answers
404 rather than 400. A level-0 server only serves what it lists, so without a list
it gets no sizes.

Each size’s `url` is in the canonical form of the service’s Image API version –
`w,h` in version 3, `w,` before it, and the `native` quality in version 1 – so
that a server which prepared the size finds it. JPEG is the one format every
compliance level must support.

## Fetching

This package does no fetching. Use [@lde/public-fetch](./public-fetch) for
manifests and `info.json` documents taken from other people’s data, and
[@lde/resolver](./resolver) to keep what you learn between runs.
