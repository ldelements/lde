---
layout: home

hero:
  name: LDE
  text: Linked Data Elements
  tagline: Coherent, composable building blocks for your Linked Data apps and pipelines – covering the whole lifecycle, from discovery through transformation to publication.
  actions:
    - theme: brand
      text: Get started
      link: /guide/build-a-pipeline
    - theme: alt
      text: What is LDE?
      link: /guide/what-is-lde
    - theme: alt
      text: GitHub
      link: https://github.com/ldelements/lde

features:
  - title: Compose
    icon: 🧩
    details: Every capability is its own package behind a small interface. Adopt the whole lifecycle, or pick just the blocks you need.
    link: /reference/packages
    linkText: Browse the packages
  - title: Discover
    icon: 🔍
    details: Find datasets in DCAT-AP 3.0 registries and resolve each one to a usable distribution.
    link: /guide/select-datasets-from-a-registry
    linkText: Select from a registry
  - title: Import
    icon: 📥
    details: Download data dumps and import them into a local SPARQL endpoint, so every dataset is queryable – with or without a live endpoint.
    link: /guide/import-data-dumps
    linkText: Import data dumps
  - title: Transform
    icon: 🔄
    details: Express transformations as plain SPARQL CONSTRUCT queries, and run them over datasets far larger than memory.
    link: /guide/build-a-pipeline
    linkText: Build a pipeline
  - title: Validate & analyze
    icon: ✅
    details: Check pipeline output against SHACL shapes and compute VoID statistics over datasets.
    link: /guide/validate-pipeline-output
    linkText: Validate with SHACL
  - title: Search
    icon: 🔎
    details: Turn RDF into a fulltext, typo-tolerant, faceted search engine served over GraphQL, all from one declarative schema.
    link: /guide/build-a-search-api
    linkText: Build a search API
  - title: Publish
    icon: 🌐
    details: Serve RDF over HTTP with content negotiation and generate documentation from SHACL shapes.
    link: /guide/serve-rdf-with-content-negotiation
    linkText: Serve RDF
  - title: Monitor
    icon: 📊
    details: Watch pipeline runs with pluggable reporters and probe distribution health on a schedule.
    link: /guide/observe-a-run-with-a-reporter
    linkText: Observe a run
---
