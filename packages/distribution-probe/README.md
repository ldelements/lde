# @lde/distribution-probe

Probes a DCAT `Distribution` to check availability and gather metadata. Returns `SparqlProbeResult`, `DataDumpProbeResult`, or `NetworkError` – the probe never throws.

## Installation

```sh
npm install @lde/distribution-probe
```

```ts
import { Distribution } from '@lde/dataset';
import { probe } from '@lde/distribution-probe';

const distribution = new Distribution(
  new URL('https://example.org/data.ttl'),
  'text/turtle',
);
const result = await probe(distribution);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/distribution-probe).
