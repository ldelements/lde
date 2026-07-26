# @lde/iiif-validator

Validates that a URL dereferences to a valid [IIIF Presentation](https://iiif.io/api/presentation/) Manifest. A small building block for Linked Data tooling that needs to tell a _declared_ IIIF manifest apart from one that actually resolves, parses, and loads in a real viewer.

## Installation

```sh
npm install @lde/iiif-validator
```

```ts
import { validateManifest } from '@lde/iiif-validator';

const verdict = await validateManifest('https://example.org/manifest.json');
if (verdict.valid) {
  // verdict.reason === 'valid-manifest'
}
```

## Documentation

See the [full documentation](https://ldelements.org/reference/iiif-validator).
