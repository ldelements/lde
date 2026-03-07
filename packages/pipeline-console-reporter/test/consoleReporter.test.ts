import { describe, it, expect, vi } from 'vitest';
import { ConsoleReporter } from '../src/consoleReporter.js';
import { Dataset, Distribution } from '@lde/dataset';

function makeDataset(): Dataset {
  return new Dataset({
    iri: new URL('http://example.org/dataset'),
    distributions: [],
  });
}

describe('ConsoleReporter', () => {
  it('can be instantiated', () => {
    const reporter = new ConsoleReporter();
    expect(reporter).toBeInstanceOf(ConsoleReporter);
  });

  describe('distributionSelected', () => {
    it('includes triple count when present', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.distributionSelected(
        makeDataset(),
        Distribution.sparql(new URL('http://localhost:7001/sparql')),
        new Distribution(
          new URL('http://example.org/data.nt'),
          'application/n-triples',
        ),
        5000,
        4800000,
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('4.8M triples');
      expect(output).toContain('to http://localhost:7001/sparql');
      spy.mockRestore();
    });

    it('omits triple count when absent', () => {
      const reporter = new ConsoleReporter();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      reporter.distributionSelected(
        makeDataset(),
        Distribution.sparql(new URL('http://localhost:7001/sparql')),
        new Distribution(
          new URL('http://example.org/data.nt'),
          'application/n-triples',
        ),
        5000,
      );

      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).not.toContain('triples');
      expect(output).toContain('to http://localhost:7001/sparql');
      spy.mockRestore();
    });
  });
});
