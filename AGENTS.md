# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

LDE (Linked Data Elements) is an Nx monorepo of Node.js libraries for building Linked Data applications and pipelines.
Built on SPARQL, SHACL, and DCAT-AP 3.0 standards.
Uses TypeScript with ESNext modules and Vite for building/testing.

## Documentation

- Record architecture decisions in @docs/decisions following the ADR format.
  ADR titles start with a verb (e.g. ‘Merge pipeline approaches’).

## Development

- We’re pre-release, so be aggressive about removing dead code. Do not yet care about backward compatibility.
- All exported/public APIs must have JSDoc comments for a good developer experience.
- With all code changes, ensure all README.md files (including diagrams) are still accurate.

## Development Commands

### Building

- `npx nx build <package-name>` - Build a specific package
- `npx nx run-many -t build` - Build all packages

### Testing

- `npx nx test <package-name>` - Run tests for a specific package (Vitest)
- `npx nx run-many -t test` - Run all tests
- `npx vitest <test-file-path>` - Run individual test file

### Linting and Type Checking

- `npx nx lint <package-name>` - Lint a specific package
- `npx nx typecheck <package-name>` - Type check a specific package
- `npx nx run-many -t lint typecheck` - Lint and type check all packages

### Affected Commands

- `npx nx affected -t lint test typecheck build` - Run tasks only on changed packages (used in CI)
- **Always run this before pushing** to catch CI failures locally.

## Architecture

### Package Structure

Packages live in `/packages/` with `@lde/` scope:

- **Data**: `dataset`, `dataset-registry-client` (DCAT-AP 3.0 discovery)
- **Processing**: `distribution-download`, `sparql-importer`, `sparql-qlever`, `pipeline`
- **Infrastructure**: `local-sparql-endpoint`, `wait-for-sparql`, `task-runner*`
- **Documentation**: `docgen` (SHACL shapes to docs)
- **Web**: `fastify-rdf` (RDF content negotiation plugin)

### TypeScript Configuration

- Module resolution: `nodenext` (ESM)
- Strict mode enabled with composite projects for incremental builds
- Each package has `tsconfig.json`, `tsconfig.lib.json`, and `tsconfig.spec.json`

### Package Exports

Each package uses conditional exports with a `development` condition for local development:

```json
"exports": {
  ".": {
    "development": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
}
```

### Testing

- Vitest with coverage via `@vitest/coverage-v8`
- Test files use `.test.ts` suffix in `test/` directory
- Fixtures in `test/fixtures/`
- HTTP mocking with Nock
- Tests that start a local SPARQL endpoint (`@lde/local-sparql-endpoint`) must use unique ports across packages to avoid conflicts when Nx runs tests in parallel. Current port allocations: `dataset-registry-client` (3002), `pipeline` sparqlQuery (3001), `pipeline` executor (3003), `pipeline` provenance store (3004)

### Key Dependencies

- RDF: `n3`, `sparqljs`, `jsonld`
- Query engines: `@comunica/query-sparql-file`, `ldkit`
- CLI packages use Commander

## Creating New Packages

The `@nx/js:library` generator’s output diverges from the conventions in this monorepo (different test directory layout, standalone instead of base-extending vitest config, missing per-package metadata and peerDependencies). Rather than maintain a custom generator, **copy a sibling package** and adjust:

1. **Pick a sibling that matches the new package’s shape.** For a library that depends on `@lde/pipeline`, copy from e.g. `packages/pipeline-shacl-validator`. For an executable/CLI, copy from one that already uses Commander.
2. **Copy the package directory.** `cp -R packages/<sibling> packages/<new-name>`.
3. **Update `package.json`:**
   - `name` → `@lde/<new-name>`
   - `description` — write something useful
   - `repository.directory` → `packages/<new-name>`
   - `version` → `0.0.0` from the get-go (do NOT keep the sibling’s version). nx release bumps from there via conventional commits, so the introducing `feat:` commit lands the first release at `0.1.0`; any higher starting version overshoots it. This must be in place before the PR merges — see [Releasing a new package](#releasing-a-new-package).
   - `dependencies` and `peerDependencies` — replace with what the new package actually needs
4. **Replace the source.** Empty out `src/` and `test/`, write the new code.
5. **Update `tsconfig.lib.json` `references`** to match the new package’s actual `@lde/*` peers.
6. **Reset coverage thresholds.** In `vite.config.ts`, drop the explicit numbers to `0`; the first test run with `autoUpdate: true` will set the real baseline.
7. **Update the root README.md** packages table with a row for the new package.
8. **Run `npx nx sync`** to add the new package’s path to the workspace root `tsconfig.json` references array.
9. **Configure Nx in `package.json`** (not `project.json`) — already enforced by copying a sibling.
10. **For CLIs**, expose the version from `package.json` (the existing CLI packages do this via Commander).

For releasing the new package’s first version, see [Releasing a new package](#releasing-a-new-package) below.

## CI/CD

### GitHub Actions

- `.github/workflows/ci.yml` - Runs tests, linting, and builds on PRs and main branch pushes
- `.github/workflows/release.yml` - Automated releases on main branch pushes using `nx release`

### Release

- Automated releases via GitHub Actions on pushes to main
- Uses conventional commits for version determination
- Independent versioning per package
- Uses NPM OIDC Trusted Publishing

#### Releasing a new package

`.github/workflows/release.yml` publishes existing packages on every push to main, but the CI workflow alone cannot bring up a brand-new `@lde/<name>` package: npm’s Trusted Publisher configuration can only be added to a package that already exists on the registry. The first version has to be published manually by a maintainer; CI takes over from the second version onwards.

The package’s `version` must already be `0.0.0` before the PR merges (set in [Creating New Packages](#creating-new-packages) step 3) so the introducing `feat:` commit publishes `0.1.0`.

One-time bootstrap for a new package (do this once it has been merged to main):

1. **Publish the first version manually.** From a maintainer’s machine:

   ```sh
   npm login --auth-type=web   # opens a browser tab; handles 2FA
   npm whoami                  # verify the publisher account
   npx nx build <name>         # populate dist/ — see warning below
   cd packages/<name>
   npm publish --access public --provenance
   ```

   The package is created on npm at the version in its `package.json`.

   > **Build first, or you ship an empty package.** Package manifests use `"files": ["dist"]`, so `npm publish` packs only `package.json` and `README.md` unless `dist/` exists on disk. CI releases get `dist/` for free via `release.version.preVersionCommand` (`nx run-many -t build`) in `nx.json`, but this manual bootstrap is the one publish path that bypasses it — always run `npx nx build <name>` immediately before `npm publish`.

2. **Add a Trusted Publisher to the now-existing package.** On npmjs.com, open the new package → ‘Settings’ → ‘Trusted Publishers’ → ‘Add trusted publisher’. Fill in:
   - Publisher: GitHub Actions
   - Organization or user: `ldelements`
   - Repository: `lde`
   - Workflow filename: `release.yml`
   - Environment name: leave blank (the workflow does not use a deployment environment)
3. **Lock the package down.** On the same package settings page, enable ‘Require two-factor authentication and disallow tokens (recommended)’. From now on, only the Trusted Publisher (i.e. the `release.yml` workflow) can publish further versions; classic NPM tokens are rejected.
4. **Verify CI takes over.** Push a follow-up conventional commit that bumps the package; the next `release.yml` run on main should publish via OIDC + provenance with no token involvement.

Until step 1 is done, the CI release run’s publish step for the new package will fail (the token cannot create new packages once the org-wide policy is in place); existing packages continue to publish normally.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
