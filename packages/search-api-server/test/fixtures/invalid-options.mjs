export default [
  {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      { name: 'title', kind: 'text', locales: ['en'], output: true },
    ],
  },
];

// Not an object: rejected at boot.
export const schemaOptions = 'nope';
