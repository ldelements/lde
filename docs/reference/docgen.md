# @lde/docgen

Generate human-readable documentation from [SHACL](https://www.w3.org/TR/shacl/) shapes using [Liquid](https://liquidjs.com) templates.

- **Template-driven:** you control the output format (Markdown, HTML, plain text) with Liquid templates.
- **Standards-based:** reads any RDF serialization (Turtle, JSON-LD, N-Triples, etc.) via [rdf-dereference](https://github.com/rubensworks/rdf-dereference.js).
- **Structured output:** SHACL shapes are framed into a clean JSON-LD tree before rendering, so templates work with predictable, nested objects.

## Installation

```sh
npm install @lde/docgen
```

## How it works

```mermaid
graph LR
    A[SHACL file] --> B[Parse to JSON-LD] --> C[Frame by NodeShape] --> D[Render with Liquid template] --> E[Output]
```

1. **Parse** – the SHACL file is dereferenced and converted to JSON-LD.
2. **Frame** – the JSON-LD is [framed](https://www.w3.org/TR/json-ld11-framing/) using a JSON-LD Frame that selects `sh:NodeShape` resources and nests their property shapes. A default frame is included; you can supply your own.
3. **Render** – the framed data is passed to a Liquid template as `nodeShapes`, an array of node shape objects.

## CLI usage

```sh
npx @lde/docgen@latest from-shacl <shacl-file> <template-file> [options]
```

### Arguments

| Argument          | Description                                         |
| ----------------- | --------------------------------------------------- |
| `<shacl-file>`    | Path to a SHACL shapes file (any RDF serialization) |
| `<template-file>` | Path to a Liquid template file                      |

### Options

| Option                    | Description                                                                                                                                                 | Default                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `-f, --frame <file>`      | Path to a JSON-LD Frame file. Deep-merged on top of the built-in default frame, so it only needs to contain your additions (e.g. extra `@context` entries). | Built-in `frames/shacl.frame.jsonld` |
| `-p, --partials <folder>` | Path to a folder of partials that the template can render, next to those in its own folder. See [shared partials](#shared-partials).                        | None                                 |

### Example

Given a SHACL file `shapes.ttl`:

```turtle
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .

[] a sh:NodeShape ;
    sh:targetClass dcat:Dataset ;
    sh:property [
        sh:path dct:title ;
        sh:minCount 1 ;
    ] ,
    [
        sh:path dct:description ;
        sh:minCount 1 ;
        sh:datatype xsd:string ;
        sh:description "A description of the dataset"@en ;
    ] .
```

And a template `spec.md.liquid`:

```liquid
{% for nodeShape in nodeShapes -%}
## {{ nodeShape.targetClass }}

| Property | Required | Type | Description |
|---|---|---|---|
{% assign mergedProperties = nodeShape.property | mergePropertiesByPath -%}
{% for property in mergedProperties -%}
| `{{ property.path }}` | {{ property.minCount | default: "no" }} | {{ property.datatype }} | {{ property.description | lang: "en" }} |
{% endfor %}
{% endfor %}
```

Run:

```sh
npx @lde/docgen@latest from-shacl shapes.ttl spec.md.liquid > spec.md
```

## Programmatic usage

```typescript
import { generateDocumentation } from '@lde/docgen';

const output = await generateDocumentation(
  'shapes.ttl',
  'spec.md.liquid',
  'frames/shacl.frame.jsonld', // optional: path to custom frame
  'partials', // optional: folder of shared partials
);
```

## Template data

The Liquid template receives a `nodeShapes` array. Each node shape object has the structure produced by the JSON-LD Frame – keys are SHACL term names (`targetClass`, `property`, `name`, etc.) with IRIs as values.

Value shapes to expect:

- **Plain strings** arrive as bare strings.
- **Numbers** (e.g. `sh:minCount`) arrive as native JavaScript numbers, so numeric comparisons in templates work.
- **Language-tagged strings** (e.g. `sh:description "…"@en`) arrive as `{"@value": …, "@language": …}` objects – render them through the `lang` filter rather than directly.
- **`sh:or`** arrives as `or`, an array with one entry per `sh:or` list on the shape, and each entry is an array of alternatives. A shape can carry more than one `sh:or` list, so `or` is an array even when there is only one: take <code v-pre>{{ property.or | first | map: "datatype" }}</code> for the common single list, or loop over `or` to show every list.

The Liquid engine’s root is set to the template’s directory with extension `.liquid`, so `{% include %}` and `{% render %}` of sibling partials work out of the box.

### Shared partials

Several documents built from different shapes often render some parts the same way, such as a cell that shows a property’s cardinality.
Put those partials in one folder and pass it with `--partials`, so each template can `{% render %}` them by name as if they were its siblings.
When a partial of the same name sits next to the template, that one wins, so a document can override a shared partial.
A relative path is resolved against the working directory, not against the template, and docgen fails when the folder does not exist.

```sh
npx @lde/docgen@latest from-shacl shapes.ttl spec.md.liquid --partials ../shared-partials > spec.md
```

Property shapes with the same `sh:path` are common in SHACL (e.g. one for cardinality, another for datatype). The `mergePropertiesByPath` filter combines them into a single object per path.

### Custom filters

| Filter                  | Description                                         | Example                                                             |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `lang`                  | Select a value by language tag                      | <code v-pre>{{ property.description \| lang: "en" }}</code>         |
| `mergePropertiesByPath` | Merge property shapes that share the same `sh:path` | `{% assign merged = nodeShape.property \| mergePropertiesByPath %}` |
| `expandIri`             | Expand a compact IRI with a prefix from the frame   | <code v-pre>{{ property.path \| expandIri }}</code>                 |

`lang` returns the **first** value matching the language tag, and an empty string when none matches. `mergePropertiesByPath` resolves key conflicts first-value-wins: when merged property shapes both define a key, the first shape’s value is kept. `expandIri` uses the prefixes in the frame’s `@context`, including those added by a custom frame, and returns an absolute IRI or a name with an unknown prefix unchanged – so a template can link `schema:name` to `https://schema.org/name`.

## Custom frames

The default frame selects all `sh:NodeShape` resources and provides type coercions for common SHACL terms (`targetClass`, `path`, `severity`, etc.). To extend it, pass a partial [JSON-LD Frame](https://www.w3.org/TR/json-ld11-framing/) – it is **deep-merged** on top of the default, so you only need to specify your additions:

```json
{
  "@context": {
    "nde": "https://def.nde.nl#",
    "nde:futureChange": {},
    "nde:version": {}
  }
}
```

```sh
npx @lde/docgen@latest from-shacl shapes.ttl template.liquid -f my-frame.jsonld
```

Plain objects are merged key-by-key, with user values winning; arrays and primitives in your frame replace the default. To override a built-in coercion (e.g. change `severity` from `@vocab` to `@id`), redefine the same key in your `@context`. Leave `or` out of your `@context`: an `"@container": "@list"` on it keeps only one `sh:or` list per shape.
