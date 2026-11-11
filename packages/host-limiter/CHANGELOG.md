## 0.3.0 (2026-11-10)

### 🚀 Features

- ⚠️  adapt each host’s limit to how the host responds, in the limiter and the resolver ([#1043](https://github.com/ldelements/lde/pull/1043))

### ⚠️  Breaking Changes

- adapt each host’s limit to how the host responds, in the limiter and the resolver  ([#1043](https://github.com/ldelements/lde/pull/1043))
  the per-host limit of createHostLimiter and mapHostLimited is now a ceiling that
  each host starts below, at one task in flight; HostLimiter gains pause, and run hands its task a
  slot. The resolver limits concurrency and perHostConcurrency are removed: pass
  limiter: createHostLimiter(global, perHost) instead."
  M	README.md
  M	docs/reference/host-limiter.md
  M	docs/reference/resolver.md
  M	packages/host-limiter/README.md
  M	packages/host-limiter/package.json
  M	packages/host-limiter/src/index.ts
  M	packages/host-limiter/src/mapHostLimited.ts
  M	packages/host-limiter/test/mapHostLimited.test.ts
  M	packages/resolver/src/resolver.ts
  M	packages/resolver/test/resolver.test.ts

## 0.2.1 (2026-10-31)

### 🩹 Fixes

- **resolver:** hold concurrency limits across resolveAll calls ([#982](https://github.com/ldelements/lde/pull/982))

## 0.2.0 (2026-10-30)

This was a version bump only for @lde/host-limiter to align it with other projects, there were no code changes.

## 0.1.0 (2026-10-15)

This was a version bump only for @lde/host-limiter to align it with other projects, there were no code changes.

## 0.0.2 (2026-10-14)

This was a version bump only for @lde/host-limiter to align it with other projects, there were no code changes.

## 0.0.1 (2026-08-24)

### 🚀 Features

- **resolver:** resolve external references with bounds, persistence and isolation ([4ee5cb84b](https://github.com/ldelements/lde/commit/4ee5cb84b))