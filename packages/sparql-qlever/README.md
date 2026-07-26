# @lde/sparql-qlever

An adapter for the [QLever](https://github.com/ad-freiburg/qlever) SPARQL server.

## Installation

```sh
npm install @lde/sparql-qlever
```

```ts
const { importer, server } = createQlever({
  mode: 'docker',
  image: 'adfreiburg/qlever:latest',
  serverOptions: {
    'memory-max-size': '12G',
    'default-query-timeout': '120s',
  },
});
```

## Documentation

See the [full documentation](https://ldelements.org/reference/sparql-qlever).
