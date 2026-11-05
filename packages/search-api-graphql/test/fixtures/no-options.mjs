/** A schema-declaration module without a `schemaOptions` export. */
export default [
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [{ name: 'title', kind: 'text', locales: ['en'], output: true }],
  },
];
