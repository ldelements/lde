import { composeDecorators } from '../../src/index.js';
import type { Executor, ExecutorDecorator } from '../../src/index.js';
import { describe, it, expect } from 'vitest';

/**
 * A trivial executor whose identity we can track through decoration. Its
 * `execute()` is never called in these tests — composition only rewires which
 * executor wraps which, so identity is all we need to assert on.
 */
function namedExecutor(name: string): Executor & { name: string } {
  return {
    name,
    async execute() {
      return new (class {
        message = name;
      })() as never;
    },
  };
}

/** Records the order in which decorators see their inner executor. */
function tagging(tag: string, order: string[]): ExecutorDecorator {
  return (inner) => {
    order.push(tag);
    return { ...inner, execute: inner.execute.bind(inner) };
  };
}

describe('composeDecorators', () => {
  it('returns the base executor unchanged when no decorators are given', () => {
    const base = namedExecutor('base');
    expect(composeDecorators()(base)).toBe(base);
  });

  it('applies decorators innermost-first, last argument outermost', () => {
    const order: string[] = [];
    const base = namedExecutor('base');

    composeDecorators(tagging('inner', order), tagging('outer', order))(base);

    // The first argument wraps the base first, then the second wraps that.
    expect(order).toEqual(['inner', 'outer']);
  });

  it('skips undefined decorators', () => {
    const order: string[] = [];
    const base = namedExecutor('base');

    composeDecorators(undefined, tagging('only', order), undefined)(base);

    expect(order).toEqual(['only']);
  });

  it('returns the base executor untouched when every decorator is undefined', () => {
    const base = namedExecutor('base');
    expect(composeDecorators(undefined, undefined)(base)).toBe(base);
  });
});
