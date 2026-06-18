# @lde/text-normalization

Zero-dependency text folding for search index and query normalization.

`fold()` produces a diacritic- and case-insensitive form of a string, applied
**identically at index time and query time** so that a search index never
diverges from the queries run against it (divergence = silent search misses).

```ts
import { fold } from '@lde/text-normalization';

fold('Møhlmann'); // 'mohlmann'
fold('Coöperatieve'); // 'cooperatieve'
fold('Straße'); // 'strasse'
```

It combines Unicode NFKD decomposition + combining-mark stripping (which folds
é, ö, å, ç, …) with an explicit transliteration map for letters that do **not**
decompose under NFKD (ø, æ, œ, ß, ð, þ, ł, đ, …) — notably ø, the flagship
[#1661](https://github.com/netwerk-digitaal-erfgoed/dataset-register/issues/1661)
case where “Mohlmann” must find “Møhlmann”.

`fold()` is idempotent (`fold(fold(x)) === fold(x)`). Punctuation and word
boundaries are preserved; tokenization is left to the search engine.

Because folded values are stored in the search index, the same `fold()` must be
used at index time and query time, and any change to it requires a full rebuild.
