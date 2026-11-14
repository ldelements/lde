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
      timeoutMs: 1000,
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
    it('throws when `tightenedMs` >= `defaultMs`', () => {
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            defaultMs: 1000,
            tightenedMs: 1000,
            tightenAfterTimeouts: 2,
          }),
      ).toThrow();
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            defaultMs: 1000,
            tightenedMs: 2000,
            tightenAfterTimeouts: 2,
          }),
      ).toThrow();
    });

    it('throws when `tightenAfterTimeouts` < 1', () => {
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            defaultMs: 1000,
            tightenedMs: 100,
            tightenAfterTimeouts: 0,
          }),
      ).toThrow();
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            defaultMs: 1000,
            tightenedMs: 100,
            tightenAfterTimeouts: -1,
          }),
      ).toThrow();
    });

    it('throws when timeouts are non-positive', () => {
      expect(
        () =>
          new AdaptiveTimeoutPolicy({
            defaultMs: 0,
            tightenedMs: -1,
            tightenAfterTimeouts: 1,
          }),
      ).toThrow();
    });
  });

  describe('state machine', () => {
    it('returns default before any events', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 2,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
    });

    it('tightens after exactly tightenAfterTimeouts=1 consecutive timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('tightens after exactly tightenAfterTimeouts=2 consecutive timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 2,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('tightens after exactly tightenAfterTimeouts=3 consecutive timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 3,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('stays tightened on further timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      for (let i = 0; i < 5; i++) {
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'timeout',
          durationMs: 1000,
          timeoutMs: 1000,
        });
      }
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('relaxes to default on a single ok', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
    });

    it('resets the counter on ok so subsequent timeouts must accumulate again', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 2,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
        timeoutMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
    });

    it('treats `error` outcomes as neutral (neither tighten nor relax)', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'error',
        durationMs: 50,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
      // An `error` while tightened keeps state tightened.
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'error',
        durationMs: 50,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
    });

    it('isolates state per endpoint', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
      expect(policy.beforeRequest({ endpoint: endpointB })).toBe(1000);
    });

    describe('re-probing a tightened endpoint', () => {
      function tightenedPolicy(): AdaptiveTimeoutPolicy {
        const policy = new AdaptiveTimeoutPolicy({
          defaultMs: 1000,
          tightenedMs: 100,
          tightenAfterTimeouts: 1,
        });
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'timeout',
          durationMs: 1000,
          timeoutMs: 1000,
        });
        return policy;
      }

      it('gives the next request the default budget after a timeout at the tightened budget', () => {
        const policy = tightenedPolicy();
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'timeout',
          durationMs: 100,
          timeoutMs: 100,
        });
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
        // One probe at a time: concurrent requests keep the tightened budget.
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
      });

      it('relaxes a healthy-but-slow endpoint when the probe succeeds', () => {
        const policy = tightenedPolicy();
        const onRelax = vi.fn();
        policy.subscribe({ onRelax });
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'timeout',
          durationMs: 100,
          timeoutMs: 100,
        });
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'ok',
          durationMs: 900,
          timeoutMs: 1000,
        });
        expect(onRelax).toHaveBeenCalledTimes(1);
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      });

      it('stays tightened when the probe times out at the default budget', () => {
        const policy = tightenedPolicy();
        const onTighten = vi.fn();
        const onRelax = vi.fn();
        policy.subscribe({ onTighten, onRelax });
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'timeout',
          durationMs: 100,
          timeoutMs: 100,
        });
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'timeout',
          durationMs: 1000,
          timeoutMs: 1000,
        });
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
        expect(onTighten).not.toHaveBeenCalled();
        expect(onRelax).not.toHaveBeenCalled();
      });

      it('ignores a late timeout at the tightened budget after the endpoint relaxed', () => {
        const policy = tightenedPolicy();
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(100);
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'ok',
          durationMs: 50,
          timeoutMs: 100,
        });
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'timeout',
          durationMs: 100,
          timeoutMs: 100,
        });
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
        expect(policy.beforeRequest({ endpoint: endpointA })).toBe(1000);
      });

      it('does not count timeouts at the tightened budget toward tightening', () => {
        const policy = new AdaptiveTimeoutPolicy({
          defaultMs: 1000,
          tightenedMs: 100,
          tightenAfterTimeouts: 2,
        });
        const onRelax = vi.fn();
        policy.subscribe({ onRelax });
        for (const timeoutMs of [1000, 1000, 100, 1000]) {
          policy.afterRequest({
            endpoint: endpointA,
            outcome: 'timeout',
            durationMs: timeoutMs,
            timeoutMs,
          });
        }
        policy.afterRequest({
          endpoint: endpointA,
          outcome: 'ok',
          durationMs: 900,
          timeoutMs: 1000,
        });
        expect(onRelax).toHaveBeenCalledWith(
          expect.objectContaining({ consecutiveTimeouts: 3 }),
        );
      });
    });
  });

  describe('transition events', () => {
    it('emits onTighten when state flips to tightened', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 2,
      });
      const onTighten = vi.fn();
      const onRelax = vi.fn();
      policy.subscribe({ onTighten, onRelax });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(onTighten).not.toHaveBeenCalled();
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
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
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      const onTighten = vi.fn();
      policy.subscribe({ onTighten });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(onTighten).toHaveBeenCalledTimes(1);
    });

    it('emits onRelax when an ok arrives in tightened state', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      const onRelax = vi.fn();
      policy.subscribe({ onRelax });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
        timeoutMs: 1000,
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
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      const onRelax = vi.fn();
      policy.subscribe({ onRelax });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
        timeoutMs: 1000,
      });
      expect(onRelax).not.toHaveBeenCalled();
    });

    it('unsubscribe stops further notifications', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      const onTighten = vi.fn();
      const unsubscribe = policy.subscribe({ onTighten });
      unsubscribe();
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        timeoutMs: 1000,
      });
      expect(onTighten).not.toHaveBeenCalled();
    });
  });
});

describe('adaptiveTimeoutPolicy factory', () => {
  it('returns a factory that builds independent AdaptiveTimeoutPolicy instances', () => {
    const factory = adaptiveTimeoutPolicy({
      defaultMs: 1000,
      tightenedMs: 100,
      tightenAfterTimeouts: 2,
    });
    const a = factory();
    const b = factory();
    expect(a).toBeInstanceOf(AdaptiveTimeoutPolicy);
    expect(a).not.toBe(b);
  });

  it('isolates state across factory invocations', () => {
    const factory = adaptiveTimeoutPolicy({
      defaultMs: 1000,
      tightenedMs: 100,
      tightenAfterTimeouts: 1,
    });
    const a = factory();
    a.afterRequest({
      endpoint: endpointA,
      outcome: 'timeout',
      durationMs: 1000,
      timeoutMs: 1000,
    });
    const b = factory();
    expect(b.beforeRequest({ endpoint: endpointA })).toBe(1000);
  });
});
