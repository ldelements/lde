# 17. Make the docs site the source of truth for documentation

Date: 2026-07-24

## Status

Accepted

## Context

Documentation grew up inside the package READMEs. That worked while packages were small, but the substantial ones outgrew README form – `@lde/pipeline`’s README reached ~480 lines covering timeout policies, provenance stores and validation semantics in a single scroll, with no navigation, search or cross-package structure. Meanwhile a VitePress docs site was added in `docs/`, which immediately raised the duplication question: the site’s tutorial and how-to guides adapted README content, creating two copies that drift.

Two constraints shape the answer:

1. A package’s README is its npm page, snapshotted per published version. It is what people see when evaluating a package on npmjs.com, so it must stand alone at the ‘what is this, do I want it’ level – but nothing requires it to carry the full manual.
2. Every copy of a fact is a maintenance obligation. The repository rule that READMEs must stay accurate with every code change doubles in cost for each duplicated section.

## Decision

The VitePress docs site in `docs/` is the single source of truth for all documentation. Content lives in exactly one place:

- **Docs site** – everything cross-package and everything deep: the tutorial, how-to guides, concept pages, per-package reference (`docs/reference/<package>.md`) and these decision records. The site is deployed to GitHub Pages on every push to `main`.
- **Package READMEs** – a fixed slim shape: one-to-three-sentence description, an Installation section, at most one minimal usage example, and a link to the package’s page on the docs site. Substantive documentation added to a package goes to `docs/reference/<package>.md`, not the README.
- **Root README** – the repository pitch: capabilities, quick example, packages table, users, comparison and the contributor quickstart, plus a link to the docs site. It is a landing page, not documentation.

## Consequences

- One place to update per fact; the docs build (which fails on dead links) runs in CI for every PR.
- npm pages become thin. That is intentional: they stay accurate because they contain little that can go stale, and the one example they carry is chosen to change rarely.
- npm READMEs are frozen per version while the site tracks `main`. Pre-1.0, with no backward-compatibility promises, a single live site is acceptable; if that changes, versioned docs become the site’s problem, not the READMEs’.
- Contributors browsing `packages/` on GitHub must follow one link to the docs site for details.
