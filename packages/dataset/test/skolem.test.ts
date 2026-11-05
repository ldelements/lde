import { describe, expect, it } from 'vitest';
import { hashSuffix, skolemIri } from '../src/skolem.js';

describe('skolemIri', () => {
  it('extends the base with hyphen-joined suffixes', () => {
    expect(
      skolemIri('https://example.org/dataset/1#subset-abc', 'activity'),
    ).toBe('https://example.org/dataset/1#subset-abc-activity');
    expect(
      skolemIri(
        'https://example.org/dataset/1#subset-abc',
        'measurement',
        'sampled',
      ),
    ).toBe('https://example.org/dataset/1#subset-abc-measurement-sampled');
  });

  it('is deterministic — same inputs yield the same IRI', () => {
    const base = 'https://example.org/dataset/1#subset-abc';
    expect(skolemIri(base, 'usage', hashSuffix('http://x/1'))).toBe(
      skolemIri(base, 'usage', hashSuffix('http://x/1')),
    );
  });

  it('keeps distinct bases and suffixes distinct (no collision)', () => {
    const a = skolemIri(
      'https://example.org/d1#subset',
      'usage',
      hashSuffix('http://x/1'),
    );
    const differentBase = skolemIri(
      'https://example.org/d2#subset',
      'usage',
      hashSuffix('http://x/1'),
    );
    const differentSuffix = skolemIri(
      'https://example.org/d1#subset',
      'usage',
      hashSuffix('http://x/2'),
    );
    expect(a).not.toBe(differentBase);
    expect(a).not.toBe(differentSuffix);
  });
});

describe('hashSuffix', () => {
  it('is a deterministic md5 hex digest', () => {
    expect(hashSuffix('http://example.org/id/1')).toBe(
      hashSuffix('http://example.org/id/1'),
    );
    expect(hashSuffix('http://example.org/id/1')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('maps distinct values to distinct digests', () => {
    expect(hashSuffix('http://example.org/id/1')).not.toBe(
      hashSuffix('http://example.org/id/2'),
    );
  });
});
