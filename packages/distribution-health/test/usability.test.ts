import { describe, it, expect } from 'vitest';
import {
  usability,
  type Reachability,
  type ValidityVerdict,
} from '../src/index.js';

const reachable: Reachability = { reachable: true, fingerprint: 'fp-1' };
const unreachable: Reachability = { reachable: false, fingerprint: 'fp-1' };

function verdict(overrides: Partial<ValidityVerdict> = {}): ValidityVerdict {
  return {
    valid: true,
    validatedFingerprint: 'fp-1',
    depth: 'deep',
    ...overrides,
  };
}

describe('usability', () => {
  it('is unusable when the distribution is unreachable, whatever the validity', () => {
    expect(usability(unreachable, [verdict({ valid: true })])).toEqual({
      state: 'unusable',
      cause: 'unreachable',
    });
  });

  it('is usable when reachable with a fresh valid verdict', () => {
    expect(usability(reachable, [verdict({ valid: true })])).toEqual({
      state: 'usable',
    });
  });

  it('is unusable/invalid when reachable with a fresh invalid verdict', () => {
    expect(
      usability(reachable, [verdict({ valid: false, reason: 'parse-error' })]),
    ).toEqual({ state: 'unusable', cause: 'invalid' });
  });

  it('is unknown/no-verdict when reachable with no verdicts', () => {
    expect(usability(reachable, [])).toEqual({
      state: 'unknown',
      cause: 'no-verdict',
    });
  });

  it('is unknown/stale-verdict when the only verdict was judged against a different fingerprint', () => {
    expect(
      usability(reachable, [
        verdict({ valid: false, validatedFingerprint: 'fp-OLD' }),
      ]),
    ).toEqual({ state: 'unknown', cause: 'stale-verdict' });
  });

  it('lets a fresh deep verdict win over a conflicting fresh shallow one', () => {
    const shallowValid = verdict({ valid: true, depth: 'shallow' });
    const deepInvalid = verdict({
      valid: false,
      reason: 'parse-error',
      depth: 'deep',
    });

    // Order must not matter: deep wins either way.
    expect(usability(reachable, [shallowValid, deepInvalid])).toEqual({
      state: 'unusable',
      cause: 'invalid',
    });
    expect(usability(reachable, [deepInvalid, shallowValid])).toEqual({
      state: 'unusable',
      cause: 'invalid',
    });
  });

  it('flags a usability resting on a shallow verdict as shallow', () => {
    expect(
      usability(reachable, [verdict({ valid: true, depth: 'shallow' })]),
    ).toEqual({ state: 'usable', shallow: true });
  });

  it('does not flag a usability resting on a deep verdict', () => {
    expect(
      usability(reachable, [verdict({ valid: true, depth: 'deep' })]),
    ).toEqual({ state: 'usable' });
  });

  it('flags a shallow-only invalid verdict as unusable and shallow', () => {
    expect(
      usability(reachable, [
        verdict({ valid: false, reason: 'parse-error', depth: 'shallow' }),
      ]),
    ).toEqual({ state: 'unusable', cause: 'invalid', shallow: true });
  });

  it('treats an unfingerprintable source (null fingerprint) as never fresh', () => {
    const noFingerprint: Reachability = { reachable: true, fingerprint: null };
    expect(
      usability(noFingerprint, [
        verdict({ valid: true, validatedFingerprint: null }),
      ]),
    ).toEqual({ state: 'unknown', cause: 'stale-verdict' });
  });
});
