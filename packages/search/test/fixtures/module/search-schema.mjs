/**
 * A minimal schema-declaration module, shaped exactly as a deployment mounts
 * it into an image: plain data, no imports.
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
    ],
  },
];

export const schemaOptions = { maxPerPage: 50 };
