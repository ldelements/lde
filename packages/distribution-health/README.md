# Distribution Health

Derives a distribution’s **usability** from two separately-produced signals:

- **reachability** – can the distribution be fetched? (HTTP/SPARQL level, produced continuously by the crawler’s probe)
- **validity** – does the fetched content actually parse as RDF? (a by-product of parsing: shallow by the crawler, deep by the knowledge-graph pipeline)

This is a pure leaf: it _interprets_ the raw results of `@lde/distribution-probe`
and `@lde/sparql-importer` rather than producing them. It contains no I/O.

## What it provides

- A `ValidityVerdict` type with a typed failure reason (`parse-error` / `empty`),
  a best-effort parser message, the `validatedFingerprint` it was judged against,
  and its producer depth (`shallow` / `deep`).
- Mappers from a probe result (shallow) and an import outcome (deep) to a verdict.
- The **usability rollup**: `(reachability, validity verdicts) → { usable | unusable | unknown, cause }`,
  the one canonical rule consumers share. Reachability dominates; a stale verdict
  (one whose fingerprint no longer matches the currently-observed one) decays to
  `unknown`; a deep verdict beats a shallow one.
- A mapping from a verdict to DQV/PROV quads.

The normative usability rule and the rejected alternatives are recorded in the
PRD: netwerk-digitaal-erfgoed/dataset-register#2103.
