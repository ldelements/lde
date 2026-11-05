# Extend a stage with a quad transform

Some logic is hard to express in pure SPARQL – cleaning up messy date notations, converting locale-specific dates to ISO 8601, or sampling a reader’s output and firing follow-up queries. Rather than subclass `Reader`, attach a `QuadTransform` to it as data: a plain function `(quads, context) => quads` that post-processes one reader’s output before the stage merges it with its siblings. This is extension point 1 of [ADR 2](../decisions/0002-unify-pipeline-extension-on-quad-transforms).

## Write the transform

A transform receives a `ReaderContext` – the `dataset`, the `distribution` (so it can fire its own SPARQL queries), and the `stage` name. It runs once per reader call, so **write it to accept being called more than once**: a global stage calls it once over the reader’s complete output, but a per-class stage with batching enabled calls it once per batch (one class at `batchSize: 1`). Accumulate within an invocation, not across invocations – or keep the transform per-quad, where the number of calls makes no difference.

```typescript
import { DataFactory } from 'n3';
import {
  Stage,
  SparqlConstructReader,
  type QuadTransform,
  type ReaderContext,
} from '@lde/pipeline';

const cleanDates: QuadTransform<ReaderContext> = async function* (quads) {
  for await (const quad of quads) {
    if (quad.object.termType === 'Literal' && isMessyDate(quad.object)) {
      yield DataFactory.quad(
        quad.subject,
        quad.predicate,
        DataFactory.literal(
          parseDutchDate(quad.object.value),
          DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#date'),
        ),
      );
    } else {
      yield quad;
    }
  }
};
```

## Attach it to a reader

```typescript
new Stage({
  name: 'dates',
  readers: {
    reader: await SparqlConstructReader.fromFile('dates.rq'),
    transform: cleanDates,
  },
});
```

`transform` accepts a single transform or an array applied in order, so a stage can compose several. This keeps SPARQL doing the heavy lifting while TypeScript handles the edge cases. See [@lde/pipeline-void](../reference/pipeline-void)’s `withVocabularies` for a real-world example of this pattern.
