# @lde/distribution-monitor

Monitor DCAT distributions (SPARQL endpoints and data dumps) with periodic probes, storing observations in PostgreSQL. Uses [`@lde/distribution-probe`](../distribution-probe) for the actual health check.

## Installation

```sh
npm install @lde/distribution-monitor
```

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

## Documentation

See the [full documentation](https://ldelements.org/reference/distribution-monitor).
