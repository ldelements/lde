# Generate documentation from SHACL shapes

This guide shows how to render [SHACL](https://www.w3.org/TR/shacl/) shapes into human-readable documentation with [@lde/docgen](../reference/docgen), using a [Liquid](https://liquidjs.com) template that controls the output format – Markdown, HTML or plain text.

## Write the shapes and a template

Given a SHACL file `shapes.ttl`:

```turtle
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix sh:   <http://www.w3.org/ns/shacl#> .

[] a sh:NodeShape ;
    sh:targetClass dcat:Dataset ;
    sh:property [
        sh:path dct:description ;
        sh:minCount 1 ;
        sh:description "A description of the dataset"@en ;
    ] .
```

Write a template `spec.md.liquid` that iterates over the `nodeShapes` array:

```liquid
{% for nodeShape in nodeShapes -%}
## {{ nodeShape.targetClass }}

| Property | Required | Description |
|---|---|---|
{% assign mergedProperties = nodeShape.property | mergePropertiesByPath -%}
{% for property in mergedProperties -%}
| `{{ property.path }}` | {{ property.minCount | default: "no" }} | {{ property.description | lang: "en" }} |
{% endfor %}
{% endfor %}
```

`mergePropertiesByPath` combines property shapes that share an `sh:path` and `lang` selects a value by language tag – see [custom filters](../reference/docgen#custom-filters) and the shape of the [template data](../reference/docgen#template-data).

## Render

```sh
npx @lde/docgen@latest from-shacl shapes.ttl spec.md.liquid > spec.md
```

The shapes file may be any RDF serialization, not just Turtle. To expose your own vocabulary terms to the template, pass a partial JSON-LD Frame with `-f` – it is deep-merged on top of the built-in default, see [custom frames](../reference/docgen#custom-frames).
