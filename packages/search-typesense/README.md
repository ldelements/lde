# @lde/search-typesense

[Typesense](https://typesense.org/) engine adapter for the engine- and
domain-agnostic [`@lde/search`](../search) core. **Engine-specific (Typesense) but
domain-agnostic** – you supply a `SearchType`; this package never names your
domain.

## Installation

```sh
npm install @lde/search-typesense
```

```ts
import { Client } from 'typesense';
import { BlueGreenRebuild } from '@lde/search-typesense';

const client = new Client({
  nodes: [{ host, port, protocol: 'https' }],
  apiKey,
});

// The collection is named from the type: `Dataset` → `datasets`.
const writer = new BlueGreenRebuild(client, DATASET);
// Standalone use; under @lde/pipeline the Pipeline drives this lifecycle.
const run = await writer.openRun(context);
await run.write(dataset, documents);
await run.commit();
```

## Documentation

See the [full documentation](https://ldelements.org/reference/search-typesense).
