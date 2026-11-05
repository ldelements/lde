/**
 * A minimal schema-declaration module, shaped exactly as a deployment mounts
 * it into the image: plain data, no imports.
 */
export default [
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      {
        name: 'title',
        kind: 'text',
        path: '<http://purl.org/dc/terms/title>',
        locales: ['nl', 'en'],
        output: true,
        searchable: { weight: 5 },
      },
      {
        name: 'keyword',
        kind: 'keyword',
        path: '<http://www.w3.org/ns/dcat#keyword>',
        array: true,
        facetable: true,
        filterable: true,
        output: true,
      },
    ],
  },
];
