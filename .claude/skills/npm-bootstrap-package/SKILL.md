---
name: npm-bootstrap-package
description: Agent-driven first publication of a NEW npm package in an nx monorepo with Trusted Publishing. Use ANTICIPATORILY when merging a PR that introduces a package not yet on npmjs (check with npm view before merge; the release run WILL fail on it — start this flow right after the merge instead of discovering the failure), when a release workflow fails to publish such a package (404 / "could not be found or you do not have permission"), or when asked to bootstrap/first-publish a new @scope package. The agent performs every step itself and asks the user only for the browser login and the 2FA one-time password.
---

# Bootstrap a new npm package (first manual publication)

npm Trusted Publishing can only be attached to a package that already exists on
the registry, so CI (`release.yml` with OIDC) cannot create a new package: its
publish step fails with a 404 until the first version is published manually.
Drive that bootstrap yourself; the user only touches the browser/authenticator.

## Steps (agent runs all of these)

1. **Preflight the registry.** `npm config get registry` MUST be
   `https://registry.npmjs.org/`. A local Verdaccio (`http://localhost:4873/`)
   shadowing the default in `~/.npmrc` silently redirects login AND publish —
   comment that line out (reversibly, with a note) rather than passing
   `--registry` flags everywhere.
2. **Check auth.** `npm whoami`. On 401: ask the user to run
   `! npm login --auth-type=web` (the `!` prefix so THEIR terminal/browser
   completes it) — the agent cannot finish a web login from a non-TTY.
3. **Check the version.** The manifest version must be the intended FIRST
   release. If the failed release run already versioned it (nx wrote the bump
   and tagged), `git pull` first and publish exactly that version.
4. **Build first.** `npx nx build <package>` — manifests use
   `"files": ["dist"]`, so publishing without a fresh build ships an empty
   package. CI gets this via `preVersionCommand`; the manual path does not.
5. **Publish — WITHOUT `--provenance`.** Provenance requires a CI runner’s
   OIDC identity; locally it fails with “Automatic provenance generation not
   supported for provider: null”. CI adds provenance from the next version.
   For 2FA, do NOT rely on the web-auth flow: in a non-TTY, npm exits with
   EOTP instead of polling. Instead ask the user for a current 6-digit OTP and
   run immediately (codes rotate every 30 s; on EOTP just ask for a fresh one):

   ```sh
   cd packages/<package>
   npm publish --access public --otp=<code>
   ```

6. **Verify.** `npm view @scope/<package> version` returns the new version.
7. **Trusted Publisher + lockdown.** Walk the user through (or drive via
   browser tools if connected): npmjs.com → package → Settings →
   ‘Trusted Publishers’ → GitHub Actions, with the org, repo and workflow
   filename read from `git remote get-url origin` and
   `.github/workflows/release.yml`; environment blank unless the workflow uses
   one. Then enable ‘Require two-factor authentication and disallow tokens’.
8. **Do not re-run the failed release action.** Once the manual publish lands
   there is nothing left for it to do; the next push to main releases normally
   (nx skips already-published versions). Re-running is optional cosmetics.

## Related failure modes seen in the wild

- **`preserveMatchingDependencyRanges` aborts versioning** when a breaking bump
  pushes a workspace dependency outside its dependents’ declared ranges. Widen
  the ranges in the same PR — and pre-state the bumped package’s manifest
  version to the upcoming version (nx resolves current versions from git TAGS,
  so this is inert), or npm workspaces stop linking the package and resolve it
  from a registry, poisoning the lockfile (e.g. with local-Verdaccio URLs CI
  cannot reach).
- **First release overshoots** (e.g. lands at 0.2.0) when the introducing
  commits are breaking (`!`) and the manifest already says 0.1.0 under
  `adjustSemverBumpsForZeroMajorVersion`: start the manifest at 0.0.0 so the
  first release computes to exactly 0.1.0.
- **Stale `package-lock.json`**: a new package’s PR must run `npm install`
  before merging or CI’s `npm ci` fails.
