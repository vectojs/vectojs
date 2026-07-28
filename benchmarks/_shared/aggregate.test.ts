import { expect, test } from 'bun:test';
import {
  aggregateByEngine,
  aggregateResults,
  formatAggregate,
  type AggregatableResult,
} from './aggregate.ts';

const result = (
  iteration: number,
  rows: unknown[],
  over: Partial<AggregatableResult> = {},
): AggregatableResult => ({
  schemaVersion: 1,
  runId: `run-i${iteration}`,
  suiteRunId: 'suite-1',
  iteration,
  name: 'demo',
  engine: 'chrome',
  commit: 'abc1234',
  mode: 'measure',
  refreshHz: 240.1,
  durationMs: 1000,
  validation: { ok: true, issues: [] },
  rows,
  ...over,
});

test('numeric row fields are summarized across processes', () => {
  // The 652/945/954 spread this exists for: process-level, invisible to
  // page-internal trials.
  const report = aggregateResults([
    result(1, [{ nodes: 1000, msPerFrame: 652 }]),
    result(2, [{ nodes: 1000, msPerFrame: 945 }]),
    result(3, [{ nodes: 1000, msPerFrame: 954 }]),
  ]);
  expect(report.iterations).toBe(3);
  const field = report.rows[0]!.fields.find((f) => f.field === 'msPerFrame')!;
  expect(field.summary.median).toBe(945);
  expect(field.summary.min).toBe(652);
  expect(field.summary.max).toBe(954);
  expect(field.summary.n).toBe(3);
  // MAD is small even though the range is 300ms wide, because two of three
  // iterations agree — which is the signal a mean would erase.
  expect(field.summary.mad).toBe(9);
});

test('non-numeric fields become the arm identity, not a measurement', () => {
  const report = aggregateResults([
    result(1, [{ mode: 'always', label: 'a', msPerFrame: 10 }]),
    result(2, [{ mode: 'always', label: 'a', msPerFrame: 12 }]),
  ]);
  expect(report.rows[0]!.identity).toEqual({ mode: 'always', label: 'a' });
  expect(report.rows[0]!.fields.map((f) => f.field)).toEqual(['msPerFrame']);
});

test('a failed iteration is excluded with its reason, not silently dropped', () => {
  // Three usable out of four is a different situation from four out of four, and
  // a median over the survivors alone hides that.
  const report = aggregateResults([
    result(1, [{ msPerFrame: 10 }]),
    result(2, [], {
      failed: true,
      error: 'ReferenceError: x is not defined',
    } as Partial<AggregatableResult>),
    result(3, [{ msPerFrame: 12 }]),
  ]);
  expect(report.iterations).toBe(2);
  expect(report.invalid).toHaveLength(1);
  expect(report.invalid[0]!.reason).toContain('benchmark failed');
});

test('an iteration with an invalid environment is excluded', () => {
  const report = aggregateResults([
    result(1, [{ msPerFrame: 10 }]),
    result(2, [{ msPerFrame: 999 }], {
      validation: {
        ok: false,
        issues: ['refreshHz is 0: no animation frames were observed'],
      },
    }),
  ]);
  expect(report.iterations).toBe(1);
  expect(report.invalid[0]!.reason).toContain('refreshHz is 0');
});

test('differing row counts stop row aggregation instead of mis-joining', () => {
  // Joining by index is only valid when the arms line up; a differing count means
  // an arm was skipped, so a median would compare unlike arms.
  const report = aggregateResults([
    result(1, [{ msPerFrame: 10 }, { msPerFrame: 20 }]),
    result(2, [{ msPerFrame: 12 }]),
  ]);
  expect(report.rows).toEqual([]);
  expect(report.issues.join(' ')).toContain('different row counts');
});

test('an identity field that changes between iterations is reported as misalignment', () => {
  const report = aggregateResults([
    result(1, [{ mode: 'always', msPerFrame: 10 }]),
    result(2, [{ mode: 'ondemand', msPerFrame: 12 }]),
  ]);
  expect(report.issues.join(' ')).toContain('may be misaligned');
});

test('a nested counter object is not mistaken for arm identity', () => {
  // `atlas: {hits, misses, ...}` is a glyph-cache counter — a measurement that
  // differs between iterations by design. Treating every non-number as identity
  // reported four misalignment warnings on a run whose arms were correctly
  // ordered, which trains a reader to ignore the warning that matters.
  const report = aggregateResults([
    result(1, [{ mode: 'always', atlas: { hits: 331070, misses: 28 }, msPerFrame: 10 }]),
    result(2, [{ mode: 'always', atlas: { hits: 330670, misses: 28 }, msPerFrame: 12 }]),
  ]);
  expect(report.issues.join(' ')).not.toContain('may be misaligned');
  // The real aggregation still happens alongside it.
  const field = report.rows[0]!.fields.find((f) => f.field === 'msPerFrame')!;
  expect(field.summary.median).toBe(11);
});

test('a primitive identity change is still caught when a nested object is present', () => {
  const report = aggregateResults([
    result(1, [{ mode: 'always', atlas: { hits: 1 }, msPerFrame: 10 }]),
    result(2, [{ mode: 'ondemand', atlas: { hits: 2 }, msPerFrame: 12 }]),
  ]);
  expect(report.issues.join(' ')).toContain('may be misaligned');
});

test('iterations spanning multiple commits are flagged', () => {
  // A median across two builds describes neither.
  const report = aggregateResults([
    result(1, [{ msPerFrame: 10 }]),
    result(2, [{ msPerFrame: 12 }], { commit: 'def5678' }),
  ]);
  expect(report.issues.join(' ')).toContain('multiple commits');
});

test('iterations spanning measure and profile mode are flagged', () => {
  // Profiler overhead makes the two incomparable.
  const report = aggregateResults([
    result(1, [{ msPerFrame: 10 }]),
    result(2, [{ msPerFrame: 40 }], { mode: 'profile' }),
  ]);
  expect(report.issues.join(' ')).toContain('multiple modes');
});

test('refresh rate is summarized so a throttled iteration is visible', () => {
  const report = aggregateResults([
    result(1, [{ msPerFrame: 10 }], { refreshHz: 240.1 }),
    result(2, [{ msPerFrame: 10 }], { refreshHz: 240.0 }),
    result(3, [{ msPerFrame: 10 }], { refreshHz: 60.0 }),
  ]);
  expect(report.refreshHz!.median).toBe(240);
  expect(report.refreshHz!.min).toBe(60);
  // A run where one process got a quarter of the frames is visible in the spread
  // rather than averaged into the per-frame figures.
  expect(report.refreshHz!.spreadPct).toBeGreaterThan(50);
});

test('no usable iterations yields an explicit issue rather than an empty success', () => {
  const report = aggregateResults([
    result(1, [], {
      failed: true,
      error: 'boom',
    } as Partial<AggregatableResult>),
  ]);
  expect(report.iterations).toBe(0);
  expect(report.issues).toContain('no usable iterations');
  expect(report.rows).toEqual([]);
});

test('engines are never aggregated together', () => {
  // V8 and SpiderMonkey diverge substantially; one median over both describes no
  // browser that exists.
  const reports = aggregateByEngine([
    result(1, [{ msPerFrame: 10 }], { engine: 'chrome' }),
    result(1, [{ msPerFrame: 40 }], { engine: 'firefox' }),
    result(2, [{ msPerFrame: 12 }], { engine: 'chrome' }),
  ]);
  expect(reports).toHaveLength(2);
  const chrome = reports.find((r) => r.engine === 'chrome')!;
  const firefox = reports.find((r) => r.engine === 'firefox')!;
  expect(chrome.iterations).toBe(2);
  expect(firefox.iterations).toBe(1);
  expect(chrome.rows[0]!.fields[0]!.summary.median).toBe(11);
});

test('mixed engines inside one group are flagged rather than quietly averaged', () => {
  const report = aggregateResults([
    result(1, [{ msPerFrame: 10 }], { engine: 'chrome' }),
    result(2, [{ msPerFrame: 40 }], { engine: 'firefox' }),
  ]);
  expect(report.issues.join(' ')).toContain('multiple engines');
});

test('iterations are ordered by index regardless of input order', () => {
  const report = aggregateResults([
    result(3, [{ msPerFrame: 30 }]),
    result(1, [{ msPerFrame: 10 }]),
    result(2, [{ msPerFrame: 20 }]),
  ]);
  expect(report.rows[0]!.fields[0]!.summary.median).toBe(20);
});

test('a field missing from some iterations is reported', () => {
  const report = aggregateResults([
    result(1, [{ msPerFrame: 10, gpuMs: 2 }]),
    result(2, [{ msPerFrame: 12 }]),
  ]);
  expect(report.issues.join(' ')).toContain('gpuMs');
  expect(report.issues.join(' ')).toContain('1 of 2');
});

test('the formatted report names the benchmark, engine and iteration count', () => {
  const text = formatAggregate(
    aggregateResults([
      result(1, [{ mode: 'always', msPerFrame: 10 }]),
      result(2, [{ mode: 'always', msPerFrame: 12 }]),
    ]),
  );
  expect(text).toContain('demo / chrome');
  expect(text).toContain('2 iteration(s)');
  expect(text).toContain('msPerFrame');
  expect(text).toContain('median');
});

test('the formatted report surfaces exclusions and issues', () => {
  const text = formatAggregate(
    aggregateResults([
      result(1, [{ msPerFrame: 10 }]),
      result(2, [], {
        failed: true,
        error: 'boom',
      } as Partial<AggregatableResult>),
    ]),
  );
  expect(text).toContain('excluded');
  expect(text).toContain('boom');
});
