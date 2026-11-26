# @lde/cql2

Reads a subset of [CQL2 JSON](https://docs.ogc.org/is/21-065r2/21-065r2.html),
the OGC filter language: checks a filter against the properties it may name,
and tests records against it.

```ts
import { compileFilter } from '@lde/cql2';

const compiled = compileFilter(
  { op: 'a_contains', args: [{ property: 'about' }, ['pottery']] },
  (property) => (property === 'about' ? { array: true } : undefined),
);

if (compiled.ok) {
  compiled.matches({ about: ['pottery', 'glass'] }); // true
} else {
  console.error(compiled.problems);
}
```

## Installation

```sh
npm install @lde/cql2
```

## What it reads

The package covers the part of CQL2 that
[stored filters](./search.md#stored-filters) need, and refuses the rest when a
filter is compiled. It does not parse CQL2 text, and it compares strings only.

| Operator     | Property      | Matches when the property        |
| ------------ | ------------- | -------------------------------- |
| `=`          | single-valued | equals the value                 |
| `in`         | single-valued | equals one of the values         |
| `a_contains` | array         | holds every one of the values    |
| `a_overlaps` | array         | holds at least one of the values |
| `and`, `or`  | –             | combine two or more of the above |

The property comes first, then the value or values:

```json
{
  "op": "and",
  "args": [
    {
      "op": "a_overlaps",
      "args": [{ "property": "about" }, ["pottery", "glass"]]
    },
    { "op": "=", "args": [{ "property": "genre" }, "plate"] }
  ]
}
```

A property without a value matches nothing. `not` is refused for that reason:
what it means for a record that lacks the value has to be the same here as in
any engine that runs the same filter as a query.

## Queryables

A filter names properties, and the caller says which exist. The second
argument of `compileFilter` is a lookup from a property name to one of:

- a **queryable**, `{ array?, read? }`: the filter may use the property.
  `array` says whether it holds a list, which decides the operators it takes.
  `read` returns its value or values from a record, for a record that does not
  simply hold strings under the property’s name;
- `{ reason }`: the property exists, but a filter may not read it. The reason
  is reported as written;
- `undefined`: no such property.

```ts
compileFilter(filter, (property) => {
  if (property === 'maker') {
    return {
      array: true,
      read: (record) =>
        (record.maker as { id: string }[] | undefined)?.map(({ id }) => id),
    };
  }
  if (property === 'internalNote') {
    return { reason: 'property “internalNote” is not for filters.' };
  }
  return undefined;
});
```

## Problems

A filter is data from outside the program, so `compileFilter` assumes nothing
about it and does not throw. It returns `{ ok: true, matches }`, or
`{ ok: false, problems }` with every mistake it found: a value that is not a
CQL2 JSON object, an unsupported operator, arguments of the wrong shape, an
unknown or refused property, and an operator that does not fit the property.
