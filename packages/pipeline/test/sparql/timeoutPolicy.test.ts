import { describe, it, expect, vi } from 'vitest';
import {
  AdaptiveTimeoutPolicy,
  ConstantTimeoutPolicy,
  adaptiveTimeoutPolicy,
  constantTimeoutPolicy,
} from '../../src/sparql/timeoutPolicy.js';

const endpointA = new URL('https://example.org/a/sparql');
const endpointB = new URL('https://example.org/b/sparql');

describe('ConstantTimeoutPolicy', () => {
  it('returns the configured timeout from beforeRequest', () => {
    const policy = new ConstantTimeoutPolicy(1234);
    expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1234);
  });

  it('ignores outcomes in afterRequest', () => {
    const policy = new ConstantTimeoutPolicy(1000);
    policy.afterRequest({
      endpoint: endpointA,
      outcome: 'timeout',
      durationMs: 500,
    });
    expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
  });

  it('rejects non-positive timeouts', () => {
    expect(() => new ConstantTimeoutPolicy(0)).toThrow();
    expect(() => new ConstantTimeoutPolicy(-1)).toThrow();
    expect(() => new ConstantTimeoutPolicy(Number.NaN)).toThrow();
  });
});

describe('constantTimeoutPolicy factory', () => {
  it('returns a factory that builds independent ConstantTimeoutPolicy instances', () => {
    const factory = constantTimeoutPolicy(5_000);
    const a = factory();
    const b = factory();
    expect(a).toBeInstanceOf(ConstantTimeoutPolicy);
    expect(a).not.toBe(b);
    expect(a.beforeRequest({ endpoint: endpointA })).toBe(5_000);
  });
});

describe('AdaptiveTimeoutPolicy', () => {
  describe('construction-time validation', () => {
    it('throws when `short` >= `default`', () => {
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            default: 1000,
            short: 1000,
            threshold: 2,
          }),
      ).toThrow();
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            default: 1000,
            short: 2000,
            threshold: 2,
          }),
      ).toThrow();
    });

    it('throws when `threshold` < 1', () => {
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            default: 1000,
            short: 100,
            threshold: 0,
          }),
      ).toThrow();
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            default: 1000,
            short: 100,
            threshold: -1,
          }),
      ).toThrow();
    });

    it('throws when timeouts are non-positive', () => {
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            default: 0,
            short: -1,
            threshold: 1,
          }),
      ).toThrow();
    });
  });

  describe('state machine', () => {
    it('returns default before any events', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 2,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
    });

    it('tightens after exactly threshold=1 consecutive timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('tightens after exactly threshold=2 consecutive timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 2,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('tightens after exactly threshold=3 consecutive timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 3,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('stays tightened on further timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      for (let i = 0; i < 5; i++) {
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'timeout',
          durationMs: 1000,
        });
      }
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('relaxes to default on a single ok', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
    });

    it('resets the counter on ok so subsequent timeouts must accumulate again', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 2,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
    });

    it('treats `error` outcomes as neutral (neither tighten nor relax)', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'error',
        durationMs: 50,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
      // An `error` while tightened keeps state tightened.
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'error',
        durationMs: 50,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('isolates state per endpoint', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
      expect(policy.beforeRequest({ endpoint: endpointB })).toBe(1000);
    });
  });

  describe('transition events', () => {
    it('emits onTighten when state flips to tightened', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 2,
      });
      const onTighten = vi.fn();
      const onRelax = vi.fn();
      policy.subscribe({ onTighten, onRelax });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(onTighten).not.toHaveBeenCalled();
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(onTighten).toHaveBeenCalledTimes(1);
      expect(onTighten).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: endpointA,
          consecutiveTimeouts: 2,
          fromTimeoutMs: 1000,
          toTimeoutMs: 100,
        }),
      );
      expect(onRelax).not.toHaveBeenCalled();
    });

    it('does not re-emit onTighten while already tightened', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      const onTighten = vi.fn();
      policy.subscribe({ onTighten });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(onTighten).toHaveBeenCalledTimes(1);
    });

    it('emits onRelax when an ok arrives in tightened state', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      const onRelax = vi.fn();
      policy.subscribe({ onRelax });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
      });
      expect(onRelax).toHaveBeenCalledTimes(1);
      expect(onRelax).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: endpointA,
          fromTimeoutMs: 100,
          toTimeoutMs: 1000,
        }),
      );
    });

    it('does not emit onRelax when ok arrives in healthy state', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      const onRelax = vi.fn();
      policy.subscribe({ onRelax });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
      });
      expect(onRelax).not.toHaveBeenCalled();
    });

    it('unsubscribe stops further notifications', () => {
      const policy = new AdaptiveTimeoutPolicy({
        default: 1000,
        short: 100,
        threshold: 1,
      });
      const onTighten = vi.fn();
      const unsubscribe = policy.subscribe({ onTighten });
      unsubscribe();
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
      });
      expect(onTighten).not.toHaveBeenCalled();
    });
  });
});

describe('adaptiveTimeoutPolicy factory', () => {
  it('returns a factory that builds independent AdaptiveTimeoutPolicy instances', () => {
    const factory = adaptiveTimeoutPolicy({
      default: 1000,
      short: 100,
      threshold: 2,
    });
    const a = factory();
    const b = factory();
    expect(a).toBeInstanceOf(AdaptiveTimeoutPolicy);
    expect(a).not.toBe(b);
  });

  it('isolates state across factory invocations', () => {
    const factory = adaptiveTimeoutPolicy({
      default: 1000,
      short: 100,
      threshold: 1,
    });
    const a = factory();
    a.afterRequest({
      endpoint: endpointA,
      outcome: 'timeout',
      durationMs: 1000,
    });
    const b = factory();
    expect(b.beforeRequest({ endpoint: endpointA })).toBe(1000);
  });
});
