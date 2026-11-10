# @lde/iiif-image

Find the images a IIIF Presentation manifest paints, with their stated size and
image service, and read that service’s
`info.json` into dimensions and a ladder of sizes, in either API
version, without the consumer having to know which.

## Installation

```sh
npm install @lde/iiif-image
```

```ts
import { images, readImageService } from '@lde/iiif-image';

const [cover] = images(manifest);
const serviceUrl = cover?.service;
if (serviceUrl !== undefined) {
  // `info` is the document at `${serviceUrl}/info.json`.
  const thumbnail = readImageService(serviceUrl, info)?.sizes[0]?.url;
}
```

## Documentation

See the [full documentation](https://ldelements.org/reference/iiif-image).
