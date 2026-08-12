/** A schema-declaration module whose `schemaOptions` is not an object. */
export default [
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [{ name: 'title', kind: 'text', locales: ['en'], output: true }],
  },
];

export const schemaOptions = 'nope';
