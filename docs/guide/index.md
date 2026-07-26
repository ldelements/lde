# Guide

Learn LDE, then get things done.

## Introduction

- [What is LDE?](./what-is-lde)
- [When to use LDE](./when-to-use-lde)
- [Core concepts](./core-concepts) – how a pipeline run works.
- [Architecture](./architecture) – how the packages fit together.

## Tutorials

- [Build a pipeline](./build-a-pipeline) – your first Linked Data pipeline, step by step.
- [Build a search API](./build-a-search-api) – from RDF datasets to a GraphQL search API with the prebuilt Docker images.

## How-to

Goal-oriented recipes. Each assumes the basics from [Build a pipeline](./build-a-pipeline).

### Pipeline

- [Select datasets from a registry](./select-datasets-from-a-registry)
- [Import data dumps for missing or unreliable endpoints](./import-data-dumps)
- [Adapt timeouts to endpoint health](./adapt-timeouts-to-endpoint-health)
- [Validate pipeline output with SHACL](./validate-pipeline-output)
- [Skip unchanged datasets](./skip-unchanged-datasets)
- [Extend a stage with a quad transform](./extend-a-stage-with-a-quad-transform)
- [Write a pipeline plugin](./write-a-pipeline-plugin)
- [Observe a run with a reporter](./observe-a-run-with-a-reporter)
- [Chain stage outputs](./chain-stage-outputs)
- [Analyze a dataset with VoID](./analyze-a-dataset-with-void)
- [Test a pipeline against a local endpoint](./test-a-pipeline-locally)

### Publication

- [Serve RDF with content negotiation](./serve-rdf-with-content-negotiation)
- [Generate documentation from SHACL shapes](./generate-documentation-from-shacl)

Looking for package APIs and options? See the [reference](../reference/).
