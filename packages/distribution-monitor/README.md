# Distribution Monitor

Monitor DCAT distributions (SPARQL endpoints and data dumps) with periodic probes, storing observations in PostgreSQL. Uses [`@lde/distribution-probe`](../distribution-probe) for the actual health check.

## Installation

```bash
npm install @lde/distribution-monitor
```

## CLI Usage

The easiest way to run the monitor is via the CLI with a configuration file.

### Quick Start

1. Create a configuration file (TypeScript, JavaScript, JSON, or YAML)
2. Run the monitor

```bash
# Start continuous monitoring
npx distribution-monitor start

# Run a one-off check for all monitors
npx distribution-monitor check

# Check a specific monitor
npx distribution-monitor check dbpedia

# Use a custom config path
npx distribution-monitor start --config ./configs/production.config.ts
```

### TypeScript Config (`distribution-monitor.config.ts`)

```typescript
import { defineConfig } from '@lde/distribution-monitor';

export default defineConfig({
  databaseUrl: process.env.DATABASE_URL,
  intervalSeconds: 300,
  timeoutMs: 30_000,
  retries: 2,
  monitors: [
    {
      identifier: 'dbpedia',
      distribution: {
        accessUrl: 'https://dbpedia.org/sparql',
        conformsTo: 'https://www.w3.org/TR/sparql11-protocol/',
      },
      sparqlQuery: 'ASK { ?s ?p ?o }',
    },
    {
      identifier: 'wikidata',
      distribution: {
        accessUrl: 'https://query.wikidata.org/sparql',
        conformsTo: 'https://www.w3.org/TR/sparql11-protocol/',
      },
      sparqlQuery: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
    },
    {
      identifier: 'my-dump',
      distribution: {
        accessUrl: 'https://example.org/data.nt',
        mediaType: 'application/n-triples',
      },
    },
  ],
});
```

`retries` controls how many times the probe retries a connection-level failure (socket reset, TLS hiccup, …) within a single check before recording a distribution as unavailable. It defaults to the probe’s own default; set it to `0` to disable. Because availability is read from the latest observation, this keeps a transient transport blip from flipping an otherwise healthy source to ‘unavailable’ – without looking backward across checks, so a genuine outage is still reported on the current check. Each retry gets its own `timeoutMs`, so a hung endpoint takes up to `(retries + 1) × timeoutMs` to be marked down – size `intervalSeconds` accordingly. HTTP errors and content-validation failures are never retried.

### YAML Config (`distribution-monitor.config.yaml`)

```yaml
databaseUrl: ${DATABASE_URL}
intervalSeconds: 300
monitors:
  - identifier: dbpedia
    distribution:
      accessUrl: https://dbpedia.org/sparql
      conformsTo: https://www.w3.org/TR/sparql11-protocol/
    sparqlQuery: ASK { ?s ?p ?o }
  - identifier: my-dump
    distribution:
      accessUrl: https://example.org/data.nt
      mediaType: application/n-triples
```

### Environment Variables

Create a `.env` file for sensitive configuration:

```
DATABASE_URL=postgres://user:pass@localhost:5432/monitoring
```

The CLI automatically loads `.env` files.

### Config Auto-Discovery

The CLI searches for configuration in this order:

1. `distribution-monitor.config.{ts,mts,js,mjs,json,yaml,yml}`
2. `.distribution-monitorrc`
3. `package.json` → `"distribution-monitor"` key

## Programmatic Usage

```typescript
import { Distribution } from '@lde/dataset';
import {
  MonitorService,
  PostgresObservationStore,
  type MonitorConfig,
} from '@lde/distribution-monitor';

const monitors: MonitorConfig[] = [
  {
    identifier: 'dbpedia',
    distribution: Distribution.sparql(new URL('https://dbpedia.org/sparql')),
    sparqlQuery: 'ASK { ?s ?p ?o }',
  },
  {
    identifier: 'my-dump',
    distribution: new Distribution(
      new URL('https://example.org/data.nt'),
      'application/n-triples',
    ),
  },
];

const store = await PostgresObservationStore.create(
  'postgres://user:pass@localhost:5432/db',
);

const service = new MonitorService({
  store,
  monitors,
  intervalSeconds: 300,
  timeoutMs: 30_000,
  headers: new Headers({ 'User-Agent': 'my-monitor/1.0' }),
});

service.start();
// …or run immediate checks
await service.checkAll();
await service.checkNow('dbpedia');

const observations = await store.getLatest();
for (const [identifier, observation] of observations) {
  console.log(
    `${identifier}: ${observation.success ? 'OK' : 'FAIL'} (${
      observation.responseTimeMs
    }ms)`,
  );
}

service.stop();
await store.close();
```

## Distribution shape

Each monitor targets a DCAT `Distribution`. Supply:

- `accessUrl` — required. The URL to probe.
- `mediaType` (optional) — plain content-type (e.g. `application/n-triples`) or DCAT-AP 3.0 IANA URI. Omit for SPARQL endpoints that only serve the protocol.
- `conformsTo` (optional) — use `https://www.w3.org/TR/sparql11-protocol/` to mark a distribution as a SPARQL endpoint. Required when `accessUrl` doesn’t already imply SPARQL via `mediaType`.
- `sparqlQuery` (optional) — for SPARQL endpoints. Query type (ASK / SELECT / CONSTRUCT / DESCRIBE) is autodetected. Defaults to a minimal `SELECT` availability probe.

Distributions with embedded credentials (`https://user:pass@host/path`) are supported: the credentials are stripped from the URL and forwarded as an `Authorization: Basic` header.

## Database Initialisation

`PostgresObservationStore.create()` automatically initializes the database schema:

- `observations` table for storing check results
- `latest_observations` materialized view for efficient queries
- Required indexes

This is idempotent and safe to call on every startup.
