import { describe, it, expect } from 'vitest';
import { Pipeline, Stage } from '../src/index.js';
import type { DatasetSelector, Writer } from '../src/index.js';

/**
 * Compile-time guarantees for `Stage<Out>` / `Pipeline<Out>`. These are checked
 * by the `typecheck` target, which compiles `test/**\/*.test.ts`: a wrong
 * assertion turns its `@ts-expect-error` into an "unused directive" error and
 * fails typecheck. The function is never called – the constructions exist only
 * to be type-checked, not run. See
 * {@link ../../../docs/decisions/0013-project-inside-the-batch-per-root-type.md | ADR 13}.
 */
function typeAssertions(): void {
  const selector = {} as DatasetSelector;
  const quadStage = {} as Stage; // Stage<Quad>
  const documentStage = {} as Stage<string>;
  const quadWriter = {} as Writer; // Writer<Quad>
  const documentWriter = {} as Writer<string>;

  // Homogeneous pipelines are well-typed.
  void new Pipeline({
    datasetSelector: selector,
    stages: [quadStage],
    writers: quadWriter,
  });
  void new Pipeline<string>({
    datasetSelector: selector,
    stages: [documentStage],
    writers: documentWriter,
  });

  void new Pipeline({
    datasetSelector: selector,
    // @ts-expect-error a quad pipeline cannot hold a document-producing stage
    stages: [quadStage, documentStage],
    writers: quadWriter,
  });

  void new Pipeline<string>({
    datasetSelector: selector,
    stages: [documentStage],
    // @ts-expect-error a document pipeline cannot take a quad writer
    writers: quadWriter,
  });

  void new Pipeline<string>({
    datasetSelector: selector,
    stages: [documentStage],
    writers: documentWriter,
    // @ts-expect-error a projecting pipeline has no quad plugins
    plugins: [],
  });
}

describe('Stage<Out> / Pipeline<Out> type safety', () => {
  it('rejects a mixed pipeline at compile time (checked by nx typecheck)', () => {
    // The assertions live in `typeAssertions`, verified when the test file is
    // type-checked; this keeps the module a runnable, non-empty spec.
    expect(typeof typeAssertions).toBe('function');
  });
});
