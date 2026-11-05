# @lde/text-normalization

Zero-dependency text folding for search index and query normalization.

`fold()` produces a diacritic- and case-insensitive form of a string, applied
**identically at index time and query time** so that a search index never
diverges from the queries run against it (divergence = silent search misses).

## Installation

```sh
npm install @lde/text-normalization
```

```ts
import { fold } from '@lde/text-normalization';

fold('Møhlmann'); // 'mohlmann'
fold('Coöperatieve'); // 'cooperatieve'
fold('Straße'); // 'strasse'
```

## Documentation

See the [full documentation](https://ldelements.org/reference/text-normalization).
