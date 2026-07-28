import { expect, test } from 'bun:test';
import {
  beginPhaseCapture,
  buildPhaseReport,
  endPhaseCapture,
  KNOWN_PHASES,
  medianPhaseCapture,
  PHASE_PARENT,
  type PhaseEntry,
  type PhaseSource,
} from './phases.ts';

const entry = (phase: string, totalMs: number, calls = 1): PhaseEntry => ({
  phase,
  totalMs,
  calls,
  avgMs: totalMs / calls,
  maxMs: totalMs,
  share: null,
});

/** A stand-in for `Scene`, so these tests need no canvas and no engine. */
class FakeScene implements PhaseSource {
  public timingEnabled = false;
  public clears = 0;
  constructor(private entries: PhaseEntry[]) {}
  get renderPhases(): readonly PhaseEntry[] {
    return this.entries;
  }
  setPhaseTiming(enabled: boolean): void {
    this.timingEnabled = enabled;
  }
  clearRenderPhases(): void {
    this.clears++;
    this.entries = [];
  }
}

test('every phase in the parent map is a known phase', () => {
  // A typo in either list would silently make a phase look top-level, which
  // inflates totalSelfMs and every selfShare.
  for (const [child, parent] of Object.entries(PHASE_PARENT)) {
    expect(KNOWN_PHASES).toContain(child);
    expect(KNOWN_PHASES).toContain(parent);
  }
});

test('the parent map has no cycles and every chain ends at a top-level phase', () => {
  for (const phase of Object.keys(PHASE_PARENT)) {
    const seen = new Set<string>([phase]);
    let cursor: string | undefined = PHASE_PARENT[phase];
    while (cursor !== undefined) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
      cursor = PHASE_PARENT[cursor];
    }
  }
});

test('nesting matches the engine call sites', () => {
  // Verified against the _recordPhase call sites in Scene.ts, not the doc
  // comments — those describe gridMaterialize as nested in a11ySync without
  // mentioning contentProjection and gridSync in between.
  expect(PHASE_PARENT.entityPaint).toBe('drawWalk');
  expect(PHASE_PARENT.drawWalk).toBe('render');
  expect(PHASE_PARENT.gridSync).toBe('contentProjection');
  expect(PHASE_PARENT.gridMaterialize).toBe('gridSync');
  expect(PHASE_PARENT.calibScan).toBe('gridCalibrateSchedule');
  // render, a11ySync and a11yOrder are frame-loop siblings, not nested.
  expect(PHASE_PARENT.render).toBeUndefined();
  expect(PHASE_PARENT.a11ySync).toBeUndefined();
  expect(PHASE_PARENT.a11yOrder).toBeUndefined();
});

test('selfMs subtracts direct children from a parent', () => {
  const report = buildPhaseReport([
    entry('render', 10),
    entry('transform', 2),
    entry('drawWalk', 6),
    entry('flush', 1),
    entry('entityPaint', 4),
  ]);
  const byName = new Map(report.entries.map((e) => [e.phase, e]));
  expect(byName.get('render')!.selfMs).toBe(1); // 10 - (2 + 6 + 1)
  expect(byName.get('drawWalk')!.selfMs).toBe(2); // 6 - 4
  expect(byName.get('entityPaint')!.selfMs).toBe(4); // no children
});

test('totalSelfMs equals the enclosing phase total when nesting is exact', () => {
  // render 10 fully decomposed: the frame's real cost is 10, not the 23 a naive
  // sum of every phase would report.
  const report = buildPhaseReport([
    entry('render', 10),
    entry('transform', 2),
    entry('drawWalk', 6),
    entry('flush', 1),
    entry('entityPaint', 4),
  ]);
  expect(report.totalSelfMs).toBe(10);
});

test('selfShare partitions the frame and sums to 100', () => {
  const report = buildPhaseReport([
    entry('render', 10),
    entry('transform', 2),
    entry('drawWalk', 6),
    entry('flush', 1),
    entry('entityPaint', 4),
  ]);
  const total = report.entries.reduce((s, e) => s + e.selfShare, 0);
  expect(total).toBeCloseTo(100, 1);
});

test('a negative self time from timer overhead is clamped to zero', () => {
  // A parent whose cost is almost entirely one child can measure a hair under
  // the sum, because each performance.now() pair carries its own overhead.
  const report = buildPhaseReport([entry('drawWalk', 5.0), entry('entityPaint', 5.0001)]);
  const drawWalk = report.entries.find((e) => e.phase === 'drawWalk')!;
  expect(drawWalk.selfMs).toBe(0);
  expect(drawWalk.selfShare).toBeGreaterThanOrEqual(0);
});

test('deep nesting is attributed one level at a time', () => {
  const report = buildPhaseReport([
    entry('a11ySync', 100),
    entry('a11yNodes', 10),
    entry('contentProjection', 90),
    entry('gridSync', 80),
    entry('gridMaterialize', 30),
    entry('gridCalibrateSchedule', 40),
    entry('calibScan', 25),
    entry('calibProbeBuild', 10),
  ]);
  const byName = new Map(report.entries.map((e) => [e.phase, e]));
  expect(byName.get('a11ySync')!.selfMs).toBe(0); // 100 - (10 + 90)
  expect(byName.get('contentProjection')!.selfMs).toBe(10); // 90 - 80
  expect(byName.get('gridSync')!.selfMs).toBe(10); // 80 - (30 + 40)
  expect(byName.get('gridCalibrateSchedule')!.selfMs).toBe(5); // 40 - (25 + 10)
  expect(report.totalSelfMs).toBe(100);
});

test('phases the engine never reported are listed as missing', () => {
  const report = buildPhaseReport([entry('render', 5), entry('drawWalk', 4)]);
  // This is the check the enumerative approach could not make: a phase that was
  // never exercised is a different fact from one that was never instrumented.
  expect(report.missing).toContain('a11ySync');
  expect(report.missing).toContain('entityPaint');
  expect(report.missing).not.toContain('render');
});

test('a phase the engine adds later is kept, not filtered out', () => {
  // The whole point of reading renderPhases generically: a new engine phase must
  // appear in results without editing any benchmark.
  const report = buildPhaseReport([entry('render', 5), entry('brandNewPhase', 2)]);
  const names = report.entries.map((e) => e.phase);
  expect(names).toContain('brandNewPhase');
  const added = report.entries.find((e) => e.phase === 'brandNewPhase')!;
  expect(added.parent).toBeNull();
  expect(added.selfMs).toBe(2);
});

test('an empty capture yields zeroes and every phase missing', () => {
  const report = buildPhaseReport([]);
  expect(report.entries).toEqual([]);
  expect(report.totalSelfMs).toBe(0);
  expect(report.missing).toEqual([...KNOWN_PHASES]);
});

test('begin enables timing and clears stale totals', () => {
  // Clearing is per arm: totals accumulate, so a second arm measured without a
  // clear reports the sum of both and every share is wrong.
  const scene = new FakeScene([entry('render', 99)]);
  beginPhaseCapture(scene);
  expect(scene.timingEnabled).toBe(true);
  expect(scene.clears).toBe(1);
  expect(scene.renderPhases).toEqual([]);
});

test('end reads the breakdown then disables timing', () => {
  const scene = new FakeScene([entry('render', 8), entry('drawWalk', 5)]);
  const capture = endPhaseCapture(scene);
  expect(capture.totalSelfMs).toBe(8);
  expect(scene.timingEnabled).toBe(false);
});

test('median capture takes per-phase medians, not the phases of one trial', () => {
  // Per-phase medians so one trial's flush spike does not also distort its
  // transform.
  const captures = [
    buildPhaseReport([entry('render', 10), entry('flush', 1)]),
    buildPhaseReport([entry('render', 12), entry('flush', 50)]),
    buildPhaseReport([entry('render', 11), entry('flush', 2)]),
  ];
  const merged = medianPhaseCapture(captures);
  const byName = new Map(merged.entries.map((e) => [e.phase, e]));
  expect(byName.get('render')!.totalMs).toBe(11);
  expect(byName.get('flush')!.totalMs).toBe(2);
});

test('median capture recomputes selfMs from the medianed totals', () => {
  const captures = [
    buildPhaseReport([entry('render', 10), entry('drawWalk', 6), entry('entityPaint', 4)]),
    buildPhaseReport([entry('render', 10), entry('drawWalk', 6), entry('entityPaint', 4)]),
  ];
  const merged = medianPhaseCapture(captures);
  const byName = new Map(merged.entries.map((e) => [e.phase, e]));
  expect(byName.get('drawWalk')!.selfMs).toBe(2);
  expect(merged.totalSelfMs).toBe(10);
});

test('median of no captures is empty rather than a throw', () => {
  // Called on an arm that produced no trials; an exception here would lose the
  // arms that did succeed.
  const merged = medianPhaseCapture([]);
  expect(merged.entries).toEqual([]);
  expect(merged.missing).toEqual([...KNOWN_PHASES]);
});
