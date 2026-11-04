## 0.4.0 (2026-11-04)

### 🚀 Features

- ⚠️  add iiif-image and public-fetch packages ([#986](https://github.com/ldelements/lde/pull/986))

### ⚠️  Breaking Changes

- add iiif-image and public-fetch packages  ([#986](https://github.com/ldelements/lde/pull/986))
  ManifestValidationReason gains refused-url and too-large, so code that
  handles every reason must handle these two.
  * refactor(iiif-image,public-fetch): shrink the public interfaces
  - iiif-image: replace firstImageService and hasCanvases with an imageServices iterator that throws for a document it cannot read as a manifest
  - iiif-image: give each size the URL of its JPEG rendition, replacing imageUrl, and drop version, level, server limits and size sources from ImageService
  - public-fetch: bound the body of the Response fetchPublic returns, replacing readJson, and read nothing until the caller does
  - public-fetch: stop exporting isPublicWebUrl, the option and limit constants, and the fields on its errors
  - iiif-validator: read manifests with response.json()"
  M	README.md
  M	docs/.vitepress/config.mts
  A	docs/reference/iiif-image.md
  M	docs/reference/iiif-validator.md
  M	docs/reference/packages.md
  A	docs/reference/public-fetch.md
  M	package-lock.json
  A	packages/iiif-image/README.md
  A	packages/iiif-image/eslint.config.mjs
  A	packages/iiif-image/package.json
  A	packages/iiif-image/src/imageService.ts
  A	packages/iiif-image/src/index.ts
  A	packages/iiif-image/src/manifest.ts
  A	packages/iiif-image/src/serviceBase.ts
  A	packages/iiif-image/test/fixtures/ark11978.json
  A	packages/iiif-image/test/fixtures/fehac.json
  A	packages/iiif-image/test/fixtures/gouda.json
  A	packages/iiif-image/test/fixtures/limb.json
  A	packages/iiif-image/test/imageService.test.ts
  A	packages/iiif-image/test/manifest.test.ts
  A	packages/iiif-image/tsconfig.json
  A	packages/iiif-image/tsconfig.lib.json
  A	packages/iiif-image/tsconfig.spec.json
  A	packages/iiif-image/vite.config.ts
  M	packages/iiif-validator/package.json
  M	packages/iiif-validator/src/validateManifest.ts
  M	packages/iiif-validator/test/validateManifest.test.ts
  M	packages/iiif-validator/tsconfig.lib.json
  M	packages/iiif-validator/vite.config.ts
  A	packages/public-fetch/README.md
  A	packages/public-fetch/eslint.config.mjs
  A	packages/public-fetch/package.json
  A	packages/public-fetch/src/index.ts
  A	packages/public-fetch/src/publicFetch.ts
  A	packages/public-fetch/test/publicFetch.test.ts
  A	packages/public-fetch/tsconfig.json
  A	packages/public-fetch/tsconfig.lib.json
  A	packages/public-fetch/tsconfig.spec.json
  A	packages/public-fetch/vite.config.ts
  M	tsconfig.json

### 🧱 Updated Dependencies

- Updated @lde/public-fetch to 0.1.0

## 0.3.0 (2026-10-30)

This was a version bump only for @lde/iiif-validator to align it with other projects, there were no code changes.

## 0.2.0 (2026-10-15)

This was a version bump only for @lde/iiif-validator to align it with other projects, there were no code changes.

## 0.1.7 (2026-10-14)

This was a version bump only for @lde/iiif-validator to align it with other projects, there were no code changes.

## 0.1.6 (2026-07-24)

This was a version bump only for @lde/iiif-validator to align it with other projects, there were no code changes.

## 0.1.5 (2026-06-26)

This was a version bump only for @lde/iiif-validator to align it with other projects, there were no code changes.

## 0.1.4 (2026-06-10)

### 🩹 Fixes

- **iiif-validator:** gate validity on loading in a real viewer ([#446](https://github.com/ldelements/lde/pull/446))

## 0.1.3 (2026-06-08)

### 🩹 Fixes

- **iiif-validator:** request manifests with Accept: */* ([#443](https://github.com/ldelements/lde/pull/443))

## 0.1.2 (2026-06-08)

### 🩹 Fixes

- **iiif-validator:** skip downloading non-manifest binary media ([#440](https://github.com/ldelements/lde/pull/440))

## 0.1.1 (2026-06-04)

### 🚀 Features

- **iiif-validator:** add IIIF Presentation Manifest validator ([#426](https://github.com/ldelements/lde/pull/426))