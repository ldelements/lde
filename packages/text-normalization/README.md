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
decompose under NFKD (ø, æ, œ, ß, ð, þ, ł, đ, …).

## When it’s needed

A search engine on its default locale often folds case and diacritics for you –
Typesense v30 (verified) even folds the non-decomposing `ø`/`æ`/`ß` – so there
`fold()` is belt-and-suspenders for _search_. It becomes necessary when:

- **Sorting** – engines sort strings by raw code-point order with no collation,
  so a `fold()`-ed companion field is the only way to sort case- and
  diacritic-insensitively.
- **Stemming** – enabling a language’s stemmer requires a non-default
  `locale`, which switches the tokenizer (Typesense → ICU) to one that
  _preserves_ diacritics; the default folding is lost, and `fold()` restores
  diacritic-insensitive matching.

`fold()` is idempotent (`fold(fold(x)) === fold(x)`). Punctuation and word
boundaries are preserved; tokenization is left to the search engine.

Because folded values are stored in the search index, the same `fold()` must be
used at index time and query time, and any change to it requires a full rebuild.
