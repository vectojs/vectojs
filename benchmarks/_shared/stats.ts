/**
 * The one set of summary statistics for every benchmark.
 *
 * Before this existed, `median` was hand-copied into 13 entry files in two
 * subtly different variants: five averaged the two middle values on an even
 * count, nine returned the upper-middle sample. Benchmarks whose numbers get
 * compared against each other were therefore not computing the same statistic,
 * and nothing anywhere computed a dispersion measure — the closest was a
 * `spreadPct` that used the median as its denominator in one benchmark and the
 * best-of value in another.
 *
 * Two deliberate choices:
 *
 *   * **Median, not mean.** A single GC pause or compositor hitch moves a mean
 *     by more than the effect most of these benchmarks are trying to resolve.
 *   * **MAD, not standard deviation.** Stddev is computed against the mean and
 *     squares the deviations, so one outlier dominates it. MAD is the median of
 *     the absolute deviations from the median, so a minority of bad iterations
 *     cannot inflate it — which is what makes it usable as a run-quality gate.
 */

/** A sample set summarized. Field names are the schema's; do not rename. */
export interface Summary {
  /** Number of samples that went into these figures. */
  n: number;
  min: number;
  max: number;
  median: number;
  /** R-7 interpolated. Meaningless below ~20 samples; see {@link percentile}. */
  p90: number;
  p95: number;
  /**
   * Median absolute deviation: `median(|x - median|)`. Same units as the
   * samples. Zero means every sample was identical.
   */
  mad: number;
  /** MAD as a percentage of the median, so it is comparable across scales. */
  madPct: number;
  /** `(max - min) / median * 100`. Kept because two benchmarks already report it. */
  spreadPct: number;
  /**
   * Retained for continuity with existing published numbers, which used
   * best-of-N. Not the headline figure.
   */
  mean: number;
}

const ascending = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

/**
 * Median of a sorted array, averaging the two middle values on an even count.
 *
 * This is the definition the five newer benchmarks used; the nine that returned
 * the upper-middle sample were wrong by half an interval on even counts, which
 * is small but systematic and always in the same direction.
 */
function medianOfSorted(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median of an unsorted sample set. Throws on empty input rather than guessing. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError('median of an empty sample set');
  return medianOfSorted(ascending(xs));
}

/**
 * The `q`-quantile by R-7 linear interpolation (the default in R and NumPy).
 *
 * The previous nearest-rank form, `sorted[floor(n * q)]`, collapses on the
 * sample counts these benchmarks actually collect: at n=5 it returns the
 * maximum for both p90 and p95, so the two numbers are identical and neither is
 * a tail estimate — it is just `max` reported twice under two names.
 * Interpolation at least distinguishes them.
 *
 * It does not manufacture information, though. A p95 from 5 samples is not a
 * 95th percentile in any useful sense, which is why {@link summarize} reports
 * `n` alongside it: read the percentiles only when `n` is at least ~20.
 */
export function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) throw new RangeError('percentile of an empty sample set');
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile out of range: ${q}`);
  const sorted = ascending(xs);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (sorted.length - 1) * q;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[rank]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
}

/**
 * Median absolute deviation.
 *
 * Not scaled by 1.4826. That constant makes MAD a consistent estimator of the
 * standard deviation *for normally distributed data*, and per-iteration
 * benchmark timings are right-skewed — bounded below by the real cost, unbounded
 * above by scheduling and GC. Applying it here would dress a robust dispersion
 * measure up as a Gaussian sigma it is not.
 */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError('MAD of an empty sample set');
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Summarize a sample set.
 *
 * `madPct` and `spreadPct` are 0 when the median is 0, rather than `Infinity` or
 * `NaN`: a zero median means the measurement was below the clock's resolution,
 * and a JSON field of `null`/`NaN` there breaks downstream aggregation for no
 * benefit.
 */
export function summarize(xs: readonly number[]): Summary {
  if (xs.length === 0) throw new RangeError('cannot summarize an empty sample set');
  const sorted = ascending(xs);
  const med = medianOfSorted(sorted);
  const deviation = mad(sorted);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  return {
    n: sorted.length,
    min,
    max,
    median: med,
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    mad: deviation,
    madPct: med === 0 ? 0 : (deviation / med) * 100,
    spreadPct: med === 0 ? 0 : ((max - min) / med) * 100,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

/**
 * Round every figure in a summary to `digits` decimals, for a readable result
 * file. Applied at report time only — never before computing the statistics,
 * because rounding samples first changes the median on tightly clustered data.
 */
export function roundSummary(s: Summary, digits = 3): Summary {
  const f = (x: number): number => +x.toFixed(digits);
  return {
    n: s.n,
    min: f(s.min),
    max: f(s.max),
    median: f(s.median),
    p90: f(s.p90),
    p95: f(s.p95),
    mad: f(s.mad),
    madPct: f(s.madPct),
    spreadPct: f(s.spreadPct),
    mean: f(s.mean),
  };
}
