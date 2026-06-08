# IIIF Validator

Validates that a URL dereferences to a valid [IIIF Presentation](https://iiif.io/api/presentation/) Manifest. A small, dependency-light building block for Linked Data tooling that needs to tell a _declared_ IIIF manifest apart from one that actually resolves and parses.

```ts
import { validateManifest } from '@lde/iiif-validator';

const verdict = await validateManifest('https://example.org/manifest.json');
if (verdict.valid) {
  // verdict.reason === 'valid-manifest'
}
```

`validateManifest` never throws; every outcome is reported as a `ManifestValidation`:

```ts
interface ManifestValidation {
  valid: boolean;
  reason:
    | 'valid-manifest'
    | 'timeout'
    | 'network-error'
    | 'http-error'
    | 'invalid-json'
    | 'not-a-manifest';
}
```

## Behaviour

- **Dereference over HTTP** with `Accept: */*`, following redirects, using the global `fetch` with an `AbortSignal` timeout (default 10 000 ms). The wildcard mirrors what real IIIF viewers send (the browser `fetch` default); a JSON-specific `Accept` would be more correct but trips up hosts that do backwards content negotiation – serving the manifest to `*/*` while returning 404 for a JSON-specific request. Both `fetch` and `timeoutMs` are injectable via the options argument.
- **Lightweight, version-aware structural check.** A document is valid when the response is HTTP 2xx, the body parses as JSON, its `@context` references an IIIF Presentation context, and its `type`/`@type` indicates a manifest – accepting both v3 (`Manifest`) and v2 (`sc:Manifest`). The `@context` value may be a string, an array, or an object; all forms are handled. The version segment of the context is accepted version-agnostically.
- **Strict failure semantics, no retries.** A timeout, network error, non-2xx status, unparseable body, missing IIIF `@context`, or wrong `type` all yield `valid: false` with the corresponding coarse `reason`. There is no deep JSON Schema validation and no dependency on the hosted IIIF Presentation Validator service.

## Options

```ts
interface ValidateManifestOptions {
  /** `fetch` implementation to use. Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}
```
