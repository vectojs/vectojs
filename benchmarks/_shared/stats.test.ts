import { expect, test } from 'bun:test';
import { mad, median, percentile, roundSummary, summarize } from './stats.ts';

test('median averages the two middle values on an even count', () => {
  // The variant hand-copied into nine entry files returned the upper-middle
  // sample (3) here. Half an interval, always in the same direction.
  expect(median([1, 2, 3, 4])).toBe(2.5);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test('median returns the middle sample on an odd count', () => {
  expect(median([5, 1, 3])).toBe(3);
});

test('median does not mutate its input', () => {
  const xs = [3, 1, 2];
  median(xs);
  expect(xs).toEqual([3, 1, 2]);
});

test('median of one sample is that sample', () => {
  expect(median([7.5])).toBe(7.5);
});

test('empty sample sets throw rather than returning a plausible number', () => {
  // A silent NaN or 0 here would flow into a result file and be quoted.
  expect(() => median([])).toThrow(RangeError);
  expect(() => mad([])).toThrow(RangeError);
  expect(() => percentile([], 0.9)).toThrow(RangeError);
  expect(() => summarize([])).toThrow(RangeError);
});

test('percentile interpolates instead of collapsing to max on small samples', () => {
  const xs = [1, 2, 3, 4, 5];
  // The old nearest-rank form, sorted[floor(n * q)], gave 5 for both of these:
  // p90 and p95 were the same number, and that number was just the maximum.
  expect(percentile(xs, 0.9)).toBeCloseTo(4.6, 10);
  expect(percentile(xs, 0.95)).toBeCloseTo(4.8, 10);
  expect(percentile(xs, 0.9)).not.toBe(percentile(xs, 0.95));
});

test('percentile hits the exact sample when the rank is integral', () => {
  // R-7 on 0..10 puts every decile exactly on a sample, so no interpolation
  // error can hide here.
  const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  expect(percentile(xs, 0.5)).toBe(5);
  expect(percentile(xs, 0.9)).toBe(9);
});

test('percentile endpoints are min and max', () => {
  const xs = [3, 9, 1, 7];
  expect(percentile(xs, 0)).toBe(1);
  expect(percentile(xs, 1)).toBe(9);
});

test('percentile rejects quantiles outside 0..1', () => {
  expect(() => percentile([1, 2], 1.5)).toThrow(RangeError);
  expect(() => percentile([1, 2], -0.1)).toThrow(RangeError);
});

test('percentile of a single sample is that sample at every quantile', () => {
  expect(percentile([4], 0)).toBe(4);
  expect(percentile([4], 0.95)).toBe(4);
});

test('mad is the median of absolute deviations from the median', () => {
  // median 4; deviations 3,1,0,1,5 -> sorted 0,1,1,3,5 -> median 1.
  expect(mad([1, 3, 4, 5, 9])).toBe(1);
});

test('mad is zero when every sample is identical', () => {
  expect(mad([2, 2, 2, 2])).toBe(0);
});

test('mad ignores a single extreme outlier where stddev would not', () => {
  const clean = [10, 10, 10, 10, 10, 10, 10];
  const withOutlier = [10, 10, 10, 10, 10, 10, 1000];
  // This is the whole reason MAD is the dispersion measure: one descheduled
  // iteration must not be able to condemn an otherwise clean run.
  expect(mad(clean)).toBe(0);
  expect(mad(withOutlier)).toBe(0);
  const stddev = (xs: number[]): number => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  expect(stddev(withOutlier)).toBeGreaterThan(300);
});

test('summarize reports n so percentiles can be judged trustworthy', () => {
  const s = summarize([1, 2, 3, 4, 5]);
  expect(s.n).toBe(5);
  expect(s.min).toBe(1);
  expect(s.max).toBe(5);
  expect(s.median).toBe(3);
  expect(s.mean).toBe(3);
});

test('summarize percentage fields are relative to the median', () => {
  const s = summarize([8, 10, 12]);
  expect(s.median).toBe(10);
  expect(s.mad).toBe(2);
  expect(s.madPct).toBeCloseTo(20, 10);
  expect(s.spreadPct).toBeCloseTo(40, 10);
});

test('summarize yields 0 not Infinity for percentages when the median is 0', () => {
  // A median of 0 means the measurement was under the clock resolution. NaN or
  // Infinity in the JSON breaks aggregation downstream for no benefit.
  const s = summarize([0, 0, 0]);
  expect(s.madPct).toBe(0);
  expect(s.spreadPct).toBe(0);
  expect(Number.isFinite(s.madPct)).toBe(true);
});

test('summarize spread is 0 for identical samples', () => {
  const s = summarize([5, 5, 5, 5]);
  expect(s.spreadPct).toBe(0);
  expect(s.mad).toBe(0);
  expect(s.p90).toBe(5);
});

test('mean and median diverge on skewed samples, and both are reported', () => {
  // Right-skewed, which is the shape of real per-iteration timings. Keeping
  // both makes the skew visible instead of hiding it behind one number.
  const s = summarize([10, 10, 10, 10, 60]);
  expect(s.median).toBe(10);
  expect(s.mean).toBe(20);
});

test('roundSummary rounds for reporting without altering the statistics', () => {
  const raw = summarize([1 / 3, 2 / 3, 1]);
  const rounded = roundSummary(raw, 3);
  expect(rounded.median).toBe(0.667);
  expect(rounded.n).toBe(3);
  // The source summary is untouched, so a rounded report cannot feed back into
  // a later computation.
  expect(raw.median).toBeCloseTo(0.6666666, 6);
});

test('summarize handles a single sample without dividing by zero', () => {
  const s = summarize([42]);
  expect(s).toMatchObject({
    n: 1,
    min: 42,
    max: 42,
    median: 42,
    mad: 0,
    p95: 42,
  });
  expect(s.spreadPct).toBe(0);
});
