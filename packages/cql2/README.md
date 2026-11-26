# @lde/cql2

Reads a subset of [CQL2 JSON](https://docs.ogc.org/is/21-065r2/21-065r2.html)
filters: checks a filter against the properties it may name, and tests records
against it.

It reads `=`, `in`, `a_contains`, `a_overlaps`, `and` and `or`, over string
values. Every other part of CQL2 is refused when the filter is compiled.

## Installation

```sh
npm install @lde/cql2
```

```ts
import { compileFilter } from '@lde/cql2';

const compiled = compileFilter(
  { op: 'a_contains', args: [{ property: 'about' }, ['pottery']] },
  (property) => (property === 'about' ? { array: true } : undefined),
);

if (compiled.ok) {
  compiled.matches({ about: ['pottery', 'glass'] }); // true
}
```

## Documentation

See the [full documentation](https://ldelements.org/reference/cql2).
