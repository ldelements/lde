/**
 * A minimal schema-declaration module, shaped exactly as a deployment mounts
 * it: plain data, no imports. Its `schemaOptions` renames the root query
 * field, so the printed SDL shows whether the options were forwarded.
 */
export default [
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      {
        name: 'title',
        kind: 'text',
        locales: ['nl', 'en'],
        output: true,
        searchable: { weight: 5 },
      },
      {
        name: 'keyword',
        kind: 'keyword',
        array: true,
        facetable: true,
        filterable: true,
        output: true,
      },
    ],
  },
];

export const schemaOptions = { types: { Dataset: { queryField: 'catalogue' } } };
