/**
 * Aggregate the results of several browser processes into one summary.
 *
 * Page-internal trials cover algorithm jitter — the same JIT-warmed code, the same
 * GPU cache, the same process. They cannot cover the thing that actually moved the
 * numbers: a 652/945/954 ms spread across three invocations of the same benchmark
 * is process-level variance from JIT tiering, GC timing, GPU cache state and
 * kernel scheduling, and no amount of in-page repetition sees it. Only running the
 * browser again does.
 *
 * Rows are joined by index, not by content. Every iteration runs the same code
 * over the same arms in the same order, so row `i` is the same arm everywhere; and
 * unlike a key built from field values, an index cannot silently mis-join when a
 * label changes. The risk of index joining is misalignment, so it is checked
 * rather than assumed: iterations with differing row counts are rejected, and the
 * non-numeric fields of each row are compared across iterations and reported as a
 * mismatch if they differ.
 */

import { roundSummary, summarize, type Summary } from './stats.ts';

/** The subset of a result file this module reads. */
export interface AggregatableResult {
  schemaVersion?: number;
  runId: string;
  suiteRunId?: string;
  iteration?: number;
  name: string;
  engine: string;
  commit?: string | null;
  mode?: string;
  refreshHz?: number;
  durationMs?: number;
  validation?: { ok: boolean; issues: string[] };
  failed?: boolean;
  rows?: unknown[];
}

/** One row field, summarized across iterations. */
export interface FieldAggregate {
  field: string;
  summary: Summary;
}

/** One arm (one row index), summarized across iterations. */
export interface RowAggregate {
  index: number;
  /** The row's non-numeric fields, which identify the arm. */
  identity: Record<string, unknown>;
  /** Numeric fields, each summarized across iterations. */
  fields: FieldAggregate[];
}

export interface AggregateReport {
  name: string;
  engine: string;
  suiteRunId: string | null;
  commit: string | null;
  mode: string | null;
  /** Iterations that contributed to these figures. */
  iterations: number;
  /**
   * Iterations excluded, and why. Counted separately rather than silently
   * dropped: three valid iterations out of ten is a different situation from
   * three out of three, and a median over the survivors hides that.
   */
  invalid: { runId: string; reason: string }[];
  /** Measured refresh rate across iterations; a wide spread invalidates the run. */
  refreshHz: Summary | null;
  rows: RowAggregate[];
  /** Problems with the aggregation itself, as opposed to any single run. */
  issues: string[];
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Why a result cannot contribute to an aggregate.
 *
 * A failed run and a run whose environment was invalid are both excluded, but for
 * different reasons, and the report says which.
 */
function rejectionReason(result: AggregatableResult): string | null {
  if (result.failed)
    return `benchmark failed: ${'error' in result ? String(result.error) : 'unknown'}`;
  if (result.validation && !result.validation.ok) {
    return `invalid environment: ${result.validation.issues.join('; ')}`;
  }
  if (!Array.isArray(result.rows)) return 'no rows';
  return null;
}

/** The non-numeric fields of a row: what identifies the arm rather than measures it. */
function identityOf(row: unknown): Record<string, unknown> {
  if (typeof row !== 'object' || row === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    // Only PRIMITIVE non-numbers identify an arm. Treating every non-number as
    // identity swept in nested objects, which are usually measurements: an
    // `atlas: {hits, misses, size, resets}` glyph-cache counter differs between
    // iterations by design, and comparing it produced four "arms may be
    // misaligned" warnings on a run whose arms were in exactly the same order.
    // A warning that fires on correct runs is worse than no warning, because the
    // real misalignment it exists to catch then reads as more of the same noise.
    if (isNumber(v)) continue;
    if (v !== null && typeof v === 'object') continue;
    out[k] = v;
  }
  return out;
}

/** The numeric fields of a row: the measurements. */
function numericOf(row: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof row !== 'object' || row === null) return out;
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (isNumber(v)) out.set(k, v);
  }
  return out;
}

/**
 * Aggregate several results for the same benchmark and engine.
 *
 * Results are not required to be sorted; they are ordered by iteration so the
 * report is stable. Anything unusable is listed in `invalid` with its reason
 * rather than dropped.
 */
export function aggregateResults(results: readonly AggregatableResult[]): AggregateReport {
  const issues: string[] = [];
  const invalid: { runId: string; reason: string }[] = [];
  const usable: AggregatableResult[] = [];

  for (const r of results) {
    const reason = rejectionReason(r);
    if (reason === null) usable.push(r);
    else invalid.push({ runId: r.runId, reason });
  }

  usable.sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));

  const first = results[0];
  const report: AggregateReport = {
    name: first?.name ?? 'unknown',
    engine: first?.engine ?? 'unknown',
    suiteRunId: first?.suiteRunId ?? null,
    commit: first?.commit ?? null,
    mode: first?.mode ?? null,
    iterations: usable.length,
    invalid,
    refreshHz: null,
    rows: [],
    issues,
  };

  if (usable.length === 0) {
    issues.push('no usable iterations');
    return report;
  }

  // Mixing commits or modes in one aggregate produces a number that describes
  // neither. Reported rather than rejected: the caller may have deliberately
  // pointed this at a comparison.
  const commits = new Set(usable.map((r) => r.commit ?? 'unknown'));
  if (commits.size > 1) issues.push(`iterations span multiple commits: ${[...commits].join(', ')}`);
  const modes = new Set(usable.map((r) => r.mode ?? 'unknown'));
  if (modes.size > 1) issues.push(`iterations span multiple modes: ${[...modes].join(', ')}`);
  const engines = new Set(usable.map((r) => r.engine));
  if (engines.size > 1) {
    issues.push(
      `iterations span multiple engines: ${[...engines].join(', ')} — do not aggregate these together`,
    );
  }

  const refreshRates = usable.map((r) => r.refreshHz).filter(isNumber);
  if (refreshRates.length > 0) report.refreshHz = roundSummary(summarize(refreshRates));

  const rowCounts = new Set(usable.map((r) => (r.rows ?? []).length));
  if (rowCounts.size > 1) {
    // Index joining is only valid when the arms line up. A differing row count
    // means an iteration skipped or added an arm, so joining by index would
    // compare unlike arms and produce a plausible-looking median of two
    // different things.
    issues.push(
      `iterations reported different row counts (${[...rowCounts].join(', ')}); rows not aggregated`,
    );
    return report;
  }

  const rowCount = [...rowCounts][0] ?? 0;
  for (let i = 0; i < rowCount; i++) {
    const rows = usable.map((r) => (r.rows ?? [])[i]);
    const identity = identityOf(rows[0]);
    // Verify the join: same index, same arm. A label that differs between
    // iterations means the ordering is not stable and the aggregate is invalid.
    for (let k = 1; k < rows.length; k++) {
      const other = identityOf(rows[k]);
      for (const [key, value] of Object.entries(identity)) {
        if (JSON.stringify(other[key]) !== JSON.stringify(value)) {
          issues.push(
            `row ${i} field "${key}" differs between iterations (${JSON.stringify(value)} vs ${JSON.stringify(other[key])}); arms may be misaligned`,
          );
        }
      }
    }

    const perField = new Map<string, number[]>();
    for (const row of rows) {
      for (const [field, value] of numericOf(row)) {
        const list = perField.get(field);
        if (list) list.push(value);
        else perField.set(field, [value]);
      }
    }

    const fields: FieldAggregate[] = [];
    for (const [field, values] of perField) {
      if (values.length !== rows.length) {
        issues.push(
          `row ${i} field "${field}" present in ${values.length} of ${rows.length} iterations`,
        );
      }
      fields.push({ field, summary: roundSummary(summarize(values)) });
    }
    fields.sort((a, b) => a.field.localeCompare(b.field));
    report.rows.push({ index: i, identity, fields });
  }

  return report;
}

/**
 * Group results by benchmark name and engine, then aggregate each group.
 *
 * Never aggregates across engines: V8 and SpiderMonkey diverge substantially, so
 * a median over both is a number that describes no browser.
 */
export function aggregateByEngine(results: readonly AggregatableResult[]): AggregateReport[] {
  const groups = new Map<string, AggregatableResult[]>();
  for (const r of results) {
    const key = `${r.name}\u0000${r.engine}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()]
    .map((group) => aggregateResults(group))
    .sort((a, b) => a.name.localeCompare(b.name) || a.engine.localeCompare(b.engine));
}

/**
 * Load every result for one suite run out of a benchmark's `results/history/`.
 *
 * Scoped to a suiteRunId rather than reading the whole directory: history is kept
 * indefinitely, so an unscoped read would silently fold in runs from other
 * commits and other days.
 */
export async function loadSuiteResults(
  historyDir: string,
  suiteRunId: string,
): Promise<AggregatableResult[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let names: string[];
  try {
    names = await readdir(historyDir);
  } catch {
    return [];
  }
  const out: AggregatableResult[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = (await Bun.file(join(historyDir, name)).json()) as AggregatableResult;
      // Match on the recorded field, not the filename: the server sanitizes the
      // runId for the filename, so a filename match would miss any id containing
      // a character that got replaced.
      if (parsed.suiteRunId === suiteRunId) out.push(parsed);
    } catch {
      // A partially written or hand-edited file is skipped rather than failing
      // the whole aggregation.
    }
  }
  return out;
}

/** Render an aggregate as a fixed-width table for a terminal. */
export function formatAggregate(report: AggregateReport): string {
  const lines: string[] = [];
  const refresh = report.refreshHz;
  lines.push(
    `${report.name} / ${report.engine}  ${report.iterations} iteration(s)` +
      `${report.commit === null ? '' : `  commit ${report.commit}`}` +
      `${report.mode === null ? '' : `  mode ${report.mode}`}`,
  );
  if (refresh) {
    lines.push(
      `  refreshHz  median ${refresh.median}  mad ${refresh.mad}  min ${refresh.min}  max ${refresh.max}`,
    );
  }
  if (report.invalid.length > 0) {
    lines.push(`  ${report.invalid.length} iteration(s) excluded:`);
    for (const bad of report.invalid) lines.push(`    ${bad.runId}: ${bad.reason}`);
  }
  for (const issue of report.issues) lines.push(`  ! ${issue}`);
  for (const row of report.rows) {
    const label = Object.entries(row.identity)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    lines.push(`  [${row.index}] ${label}`);
    for (const f of row.fields) {
      const s = f.summary;
      lines.push(
        `    ${f.field.padEnd(28)} median ${String(s.median).padStart(10)}` +
          `  mad ${String(s.mad).padStart(8)}` +
          `  p90 ${String(s.p90).padStart(10)}` +
          `  p95 ${String(s.p95).padStart(10)}` +
          `  n ${s.n}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * CLI: `bun run benchmarks/_shared/aggregate.ts <bench-dir> <suiteRunId> [--json]`.
 *
 * Writes `results/aggregate/<name>-<engine>-<suiteRunId>.json` per engine and
 * prints the tables. Exits non-zero when no iteration was usable, so a runner that
 * shells out here fails loudly rather than reporting a pass over nothing.
 */
if (import.meta.main) {
  const [dir, suiteRunId] = process.argv.slice(2);
  if (!dir || !suiteRunId) {
    console.error('usage: aggregate.ts <bench-dir> <suiteRunId> [--json]');
    process.exit(1);
  }
  const { resolve } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const benchRoot = resolve(process.cwd(), dir);
  const historyDir = resolve(benchRoot, 'results', 'history');
  const results = await loadSuiteResults(historyDir, suiteRunId);
  if (results.length === 0) {
    console.error(`no results for suiteRunId ${suiteRunId} in ${historyDir}`);
    process.exit(1);
  }
  const reports = aggregateByEngine(results);
  const aggregateDir = resolve(benchRoot, 'results', 'aggregate');
  await mkdir(aggregateDir, { recursive: true });
  const asJson = process.argv.includes('--json');
  for (const report of reports) {
    const file = resolve(aggregateDir, `${report.name}-${report.engine}-${suiteRunId}.json`);
    await Bun.write(file, JSON.stringify(report, null, 2));
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else console.log(formatAggregate(report));
  }
  const usable = reports.reduce((sum, r) => sum + r.iterations, 0);
  if (usable === 0) {
    console.error('no usable iterations in any engine');
    process.exit(1);
  }
}
