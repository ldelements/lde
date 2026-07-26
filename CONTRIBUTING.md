# Contributing to LDE

Thanks for your interest in contributing to LDE! This guide will help you get
started.

## Getting started

```sh
git clone https://github.com/ldelements/lde.git
cd lde
npm install
```

## Development workflow

LDE is an [Nx](https://nx.dev) monorepo.
Use Nx to run tasks for individual packages or the entire workspace:

```sh
npx nx build <package>        # build a single package
npx nx test <package>         # run tests for a single package (Vitest)
npx nx lint <package>         # lint a single package
npx nx typecheck <package>    # type-check a single package
npx nx run-many -t build      # build everything
npx nx run-many -t test       # test everything
```

To run tasks only for packages affected by your changes:

```sh
npx nx affected -t lint test typecheck build
```

## Documentation

The [documentation site](https://ldelements.org) is the source of truth for all documentation
(see [ADR 17](docs/decisions/0017-make-the-docs-site-the-source-of-truth-for-documentation.md)).
It lives in `docs/` as a [VitePress](https://vitepress.dev) site:

```sh
npm run docs:dev      # serve locally with hot reload
npm run docs:build    # build; fails on dead links (also runs in CI)
```

Substantive documentation for a package goes to `docs/reference/<package>.md`, not its README.
Package READMEs stay slim – they are the npm pages: a short description, an Installation section,
at most one minimal example, and a link to the package’s docs page.

## Code style

- **TypeScript** in strict mode with ESNext modules.
- **ESLint** and **Prettier** run automatically via pre-commit hooks (lint-staged + Husky).
  You normally don’t need to run them manually.
- **Conventional commits** – prefix your commit messages with a type (`feat:`, `fix:`, `chore:`, etc.).
  This drives automated versioning.

## Submitting changes

1. Fork the repository and create a feature branch from `main`.
2. Make your changes, ensuring `npx nx affected -t lint test typecheck build` passes.
3. Commit using [conventional commits](https://www.conventionalcommits.org/).
4. Open a pull request against `main`.

## Licence

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
