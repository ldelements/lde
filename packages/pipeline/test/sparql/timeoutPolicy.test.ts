import { describe, it, expect, vi } from 'vitest';
import {
  AdaptiveTimeoutPolicy,
  ConstantTimeoutPolicy,
  adaptiveTimeoutPolicy,
  constantTimeoutPolicy,
  type RequestBudget,
  type TimeoutOutcome,
} from '../../src/sparql/timeoutPolicy.js';

const endpointA = new URL('https://example.org/a/sparql');
const endpointB = new URL('https://example.org/b/sparql');

describe('ConstantTimeoutPolicy', () => {
  it('returns the configured timeout from beforeRequest', () => {
    const policy = new ConstantTimeoutPolicy(1234);
    expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(1234);
  });

  it('ignores outcomes in afterRequest', () => {
    const policy = new ConstantTimeoutPolicy(1000);
    policy.afterRequest({
      endpoint: endpointA,
      outcome: 'timeout',
      durationMs: 500,
      budget: { timeoutMs: 1000 },
    });
    expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(1000);
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
    expect(a.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(5_000);
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
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(
        1000,
      );
    });

    it('tightens after exactly tightenAfterTimeouts=1 consecutive timeouts', () => {
      const policy = new AdaptiveTimeoutPolicy({
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(
        1000,
      );
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(100);
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
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(
        1000,
      );
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(100);
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
        budget: { timeoutMs: 1000 },
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(
        1000,
      );
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(100);
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
          budget: { timeoutMs: 1000 },
        });
      }
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(100);
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
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(100);
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(
        1000,
      );
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
        budget: { timeoutMs: 1000 },
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
        budget: { timeoutMs: 1000 },
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(
        1000,
      );
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
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(
        1000,
      );
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(100);
      // An `error` while tightened keeps state tightened.
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'error',
        durationMs: 50,
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(100);
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
        budget: { timeoutMs: 1000 },
      });
      expect(policy.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(100);
      expect(policy.beforeRequest({ endpoint: endpointB }).timeoutMs).toBe(
        1000,
      );
    });

    describe('re-probing a tightened endpoint', () => {
      const options = {
        defaultMs: 1000,
        tightenedMs: 100,
        tightenAfterTimeouts: 1,
      };

      function request(policy: AdaptiveTimeoutPolicy): RequestBudget {
        return policy.beforeRequest({ endpoint: endpointA });
      }

      function report(
        policy: AdaptiveTimeoutPolicy,
        budget: RequestBudget,
        outcome: TimeoutOutcome,
      ): void {
        policy.afterRequest({
          endpoint: endpointA,
          outcome,
          durationMs: budget.timeoutMs,
          budget,
        });
      }

      function timeOutNextRequest(policy: AdaptiveTimeoutPolicy): void {
        report(policy, request(policy), 'timeout');
      }

      function tightenedPolicy(): AdaptiveTimeoutPolicy {
        const policy = new AdaptiveTimeoutPolicy(options);
        timeOutNextRequest(policy);
        return policy;
      }

      /**
       * Time out requests at the tightened budget until the policy hands out
       * a probe; returns how many it took and the probe’s budget.
       */
      function nextProbe(policy: AdaptiveTimeoutPolicy): {
        timeouts: number;
        probe: RequestBudget;
      } {
        for (let timeouts = 0; timeouts < 1000; timeouts++) {
          const budget = request(policy);
          if (budget.timeoutMs === options.defaultMs) {
            return { timeouts, probe: budget };
          }
          report(policy, budget, 'timeout');
        }
        throw new Error('No probe handed out');
      }

      it('gives the next request the default budget after a timeout at the tightened budget', () => {
        const policy = tightenedPolicy();
        const tightened = request(policy);
        expect(tightened.timeoutMs).toBe(100);
        report(policy, tightened, 'timeout');
        expect(request(policy).timeoutMs).toBe(1000);
        // One probe at a time: concurrent requests keep the tightened budget.
        expect(request(policy).timeoutMs).toBe(100);
      });

      it('hands out no second probe while one is in flight', () => {
        const policy = tightenedPolicy();
        const first = request(policy);
        const second = request(policy);
        expect([first.timeoutMs, second.timeoutMs]).toEqual([100, 100]);
        report(policy, first, 'timeout');
        expect(request(policy).timeoutMs).toBe(1000);

        // A concurrent request at the tightened budget times out while the
        // probe is in flight: it schedules no other probe.
        report(policy, second, 'timeout');
        expect(request(policy).timeoutMs).toBe(100);
      });

      it('does not mistake a request budgeted before tightening for the probe', () => {
        const policy = new AdaptiveTimeoutPolicy({
          ...options,
          tightenAfterTimeouts: 2,
        });
        const budgetedWhileHealthy = request(policy);
        timeOutNextRequest(policy);
        timeOutNextRequest(policy);
        const { probe } = nextProbe(policy);

        // The request from before tightening times out at the default budget,
        // just like the probe would: the probe is still in flight.
        report(policy, budgetedWhileHealthy, 'timeout');
        const tightened = request(policy);
        report(policy, tightened, 'timeout');
        expect(request(policy).timeoutMs).toBe(100);

        report(policy, probe, 'timeout');
        expect(nextProbe(policy).timeouts).toBe(2);
      });

      it('releases the probe when it fails with an error, keeping the gap', () => {
        const policy = tightenedPolicy();
        const { probe } = nextProbe(policy);
        report(policy, probe, 'error');
        expect(nextProbe(policy).timeouts).toBe(1);
      });

      it('doubles the gap between probes after each timed-out probe, up to 64', () => {
        const policy = tightenedPolicy();
        const gaps: number[] = [];
        for (let attempt = 0; attempt < 8; attempt++) {
          const { timeouts, probe } = nextProbe(policy);
          gaps.push(timeouts);
          report(policy, probe, 'timeout');
        }
        expect(gaps).toEqual([1, 2, 4, 8, 16, 32, 64, 64]);
      });

      it('relaxes a healthy-but-slow endpoint when the probe succeeds', () => {
        const policy = tightenedPolicy();
        const onRelax = vi.fn();
        policy.subscribe({ onRelax });
        const { probe } = nextProbe(policy);
        report(policy, probe, 'ok');
        // The timeout at the tightened budget before the probe isn’t counted.
        expect(onRelax).toHaveBeenCalledTimes(1);
        expect(onRelax).toHaveBeenCalledWith(
          expect.objectContaining({ consecutiveTimeouts: 1 }),
        );
        expect(request(policy).timeoutMs).toBe(1000);
        expect(request(policy).timeoutMs).toBe(1000);
      });

      it('resets the gap between probes once the endpoint relaxes', () => {
        const policy = tightenedPolicy();
        report(policy, nextProbe(policy).probe, 'timeout');
        report(policy, nextProbe(policy).probe, 'ok');
        timeOutNextRequest(policy);
        expect(nextProbe(policy).timeouts).toBe(1);
      });

      it('stays tightened when the probe times out at the default budget', () => {
        const policy = tightenedPolicy();
        const onTighten = vi.fn();
        const onRelax = vi.fn();
        policy.subscribe({ onTighten, onRelax });
        const { probe } = nextProbe(policy);
        report(policy, probe, 'timeout');
        expect(request(policy).timeoutMs).toBe(100);
        expect(onTighten).not.toHaveBeenCalled();
        expect(onRelax).not.toHaveBeenCalled();
      });

      it('ignores a late timeout at the tightened budget after the endpoint relaxed', () => {
        const policy = tightenedPolicy();
        const succeeding = request(policy);
        const timingOut = request(policy);
        report(policy, succeeding, 'ok');
        report(policy, timingOut, 'timeout');
        expect(request(policy).timeoutMs).toBe(1000);
        expect(request(policy).timeoutMs).toBe(1000);
      });

      it('ignores a probe that reports after the endpoint relaxed and tightened again', () => {
        const policy = tightenedPolicy();
        const { probe: staleProbe } = nextProbe(policy);
        report(policy, request(policy), 'ok');
        timeOutNextRequest(policy);
        nextProbe(policy);

        report(policy, staleProbe, 'timeout');
        const tightened = request(policy);
        report(policy, tightened, 'timeout');
        expect(request(policy).timeoutMs).toBe(100);
      });

      it('does not count timeouts at the tightened budget toward tightening', () => {
        const policy = new AdaptiveTimeoutPolicy({
          ...options,
          tightenAfterTimeouts: 2,
        });
        timeOutNextRequest(policy);
        timeOutNextRequest(policy);
        const budgetedWhileTightened = request(policy);
        expect(budgetedWhileTightened.timeoutMs).toBe(100);
        report(policy, request(policy), 'ok');
        const onTighten = vi.fn();
        policy.subscribe({ onTighten });

        // Healthy again: one timeout at the default budget, then the request
        // budgeted while tightened times out at the tightened budget.
        timeOutNextRequest(policy);
        report(policy, budgetedWhileTightened, 'timeout');
        expect(request(policy).timeoutMs).toBe(1000);
        expect(onTighten).not.toHaveBeenCalled();

        timeOutNextRequest(policy);
        expect(onTighten).toHaveBeenCalledWith(
          expect.objectContaining({ consecutiveTimeouts: 2 }),
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
        budget: { timeoutMs: 1000 },
      });
      expect(onTighten).not.toHaveBeenCalled();
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
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
        budget: { timeoutMs: 1000 },
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'timeout',
        durationMs: 1000,
        budget: { timeoutMs: 1000 },
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
        budget: { timeoutMs: 1000 },
      });
      policy.afterRequest({
        endpoint: endpointA,
        outcome: 'ok',
        durationMs: 80,
        budget: { timeoutMs: 1000 },
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
        budget: { timeoutMs: 1000 },
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
        budget: { timeoutMs: 1000 },
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
      budget: { timeoutMs: 1000 },
    });
    const b = factory();
    expect(b.beforeRequest({ endpoint: endpointA }).timeoutMs).toBe(1000);
  });
});
