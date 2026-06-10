# IIIF Validator

Validates that a URL dereferences to a valid [IIIF Presentation](https://iiif.io/api/presentation/) Manifest. A small building block for Linked Data tooling that needs to tell a _declared_ IIIF manifest apart from one that actually resolves, parses, and loads in a real viewer.

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
    | 'binary-content'
    | 'not-a-manifest'
    | 'does-not-load';
}
```

## Behaviour

- **Dereference over HTTP** with `Accept: */*`, following redirects, using the global `fetch` with an `AbortSignal` timeout (default 10 000 ms). The wildcard mirrors what real IIIF viewers send (the browser `fetch` default); a JSON-specific `Accept` would be more correct but trips up hosts that do backwards content negotiation – serving the manifest to `*/*` while returning 404 for a JSON-specific request. Both `fetch` and `timeoutMs` are injectable via the options argument.
- **Version-aware structural check.** A document is manifest-shaped when the response is HTTP 2xx, the body parses as JSON, its `@context` references an IIIF Presentation context, and its `type`/`@type` indicates a manifest – accepting both v3 (`Manifest`) and v2 (`sc:Manifest`). The `@context` value may be a string, an array, or an object; all forms are handled. The version segment of the context is accepted version-agnostically.
- **Viewer-load gate.** Being manifest-shaped is not enough: a document can pass every structural check yet fail to load in the dominant Vault/`@iiif/parser`-based viewers (Mirador 4, Clover, Theseus), which eagerly upgrade every manifest to Presentation 3 and normalise the whole tree on load. A single structural slip – e.g. a `null` where an `AnnotationPage` belongs – crashes that pass, so the manifest renders in no such viewer. The validator reproduces that load path with `@iiif/parser` (`upgrade()` then `normalize()`); if it throws, the verdict is `does-not-load`. `upgrade()` is a no-op for v3, so this one path covers both v2 and v3. There are only two tiers – valid or invalid; cosmetic deviations that still load (a non-canonical `rights` URI, `image/jpg` instead of `image/jpeg`) stay valid.
- **Strict failure semantics, no retries.** A timeout, network error, non-2xx status, unparseable body, binary media type, missing IIIF `@context`, wrong `type`, or a document that does not load all yield `valid: false` with the corresponding coarse `reason`. There is no deep JSON Schema validation and no dependency on the hosted IIIF Presentation Validator service.

## Options

```ts
interface ValidateManifestOptions {
  /** `fetch` implementation to use. Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}
```
