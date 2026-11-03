# @lde/iiif-image

Find the image service in a IIIF Presentation manifest, and read that service’s
`info.json` into dimensions and a ladder of sizes, in either API
version, without the consumer having to know which.

## Installation

```sh
npm install @lde/iiif-image
```

```ts
import { imageServices, readImageService } from '@lde/iiif-image';

const [serviceUrl] = imageServices(manifest);
if (serviceUrl !== undefined) {
  // `info` is the document at `${serviceUrl}/info.json`.
  const thumbnail = readImageService(serviceUrl, info)?.sizes[0]?.url;
}
```

## Documentation

See the [full documentation](https://ldelements.org/reference/iiif-image).
