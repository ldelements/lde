# @lde/iiif-image

Find the image service in a IIIF Presentation manifest, and read that service’s
`info.json` into dimensions, server limits and a ladder of sizes, in either API
version, without the consumer having to know which.

## Installation

```sh
npm install @lde/iiif-image
```

```ts
import { firstImageService, imageUrl, readImageService } from '@lde/iiif-image';

const serviceUrl = firstImageService(manifest);
const service = readImageService(serviceUrl, info);
const thumbnail = imageUrl(service, service.sizes[0]);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/iiif-image).
