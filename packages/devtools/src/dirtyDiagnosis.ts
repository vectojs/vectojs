/**
 * Diagnose why an `onDemand` scene never sleeps.
 *
 * `renderMode: 'onDemand'` is supposed to make an idle scene cost nothing, but it
 * degrades to always-on the moment something marks the scene dirty every frame —
 * and the scene's `dirty` flag says only *that* it happened, never *what* did it.
 * Finding the cause previously meant bisecting `markDirty()` call sites by hand.
 *
 * This turns the Scene's raw attribution counts into a verdict: which reason
 * dominates, and whether its rate is high enough to be keeping the loop awake.
 *
 * Headless on purpose — usable from Vitest, Playwright, CI, or an agent, with no
 * panel and no `@vectojs/ui` dependency.
 */
import type { Scene } from '@vectojs/core';

/** One attributed cause, with its rate relative to the sampled frames. */
export interface DirtyCause {
  entity?: string;
  reason: string;
  property?: string;
  count: number;
  /** Times per frame over the sampled window. `>= 1` means every frame. */
  perFrame: number;
  firstFrame: number;
  lastFrame: number;
}

export interface DirtyDiagnosis {
  /** `renderMode` at the time of sampling — `'always'` makes the rest moot. */
  renderMode: 'always' | 'onDemand';
  /** Frames covered by the sample. */
  frames: number;
  /** Attributed causes, most frequent first. */
  causes: DirtyCause[];
  /**
   * Causes firing at least once per frame. These are what an `onDemand` scene has
   * to stop doing to actually idle; anything rarer is not the problem.
   */
  everyFrame: DirtyCause[];
  /**
   * Human-readable verdict, safe to print straight into a report or panel.
   */
  summary: string;
}

export interface DirtyDiagnosisOptions {
  /**
   * Frames the sample covers. Defaults to the span between the first and last
   * recorded attribution, which is right when tracking was enabled for exactly
   * the window of interest.
   */
  frames?: number;
  /** Causes to include. Defaults to 10 — enough to see the shape, short enough to read. */
  limit?: number;
}

/**
 * Summarise the Scene's recorded dirty attributions.
 *
 * Call `scene.setDirtyTracking(true)`, run the scene for a while, then call this.
 * Returns an empty diagnosis (rather than throwing) when tracking was never
 * enabled, so a probe left in a test does not become a failure.
 */
export function diagnoseDirty(scene: Scene, options: DirtyDiagnosisOptions = {}): DirtyDiagnosis {
  const entries = scene.dirtyReasons;
  const renderMode = scene.renderMode;

  if (entries.length === 0) {
    return {
      renderMode,
      frames: 0,
      causes: [],
      everyFrame: [],
      summary: scene.dirtyTracking
        ? 'No dirty attributions recorded. Either the scene is genuinely idle, or the code marking it dirty does not pass a source yet.'
        : 'Dirty tracking is off — call scene.setDirtyTracking(true) before sampling.',
    };
  }

  // Span of frames the recorded window covers. `+1` because first and last are
  // inclusive: one attribution on a single frame is a one-frame window, not zero.
  const firstFrame = Math.min(...entries.map((e) => e.firstFrame));
  const lastFrame = Math.max(...entries.map((e) => e.lastFrame));
  const frames = options.frames ?? Math.max(1, lastFrame - firstFrame + 1);

  const causes: DirtyCause[] = entries.map((e) => ({
    entity: e.entity,
    reason: e.reason,
    property: e.property,
    count: e.count,
    perFrame: e.count / frames,
    firstFrame: e.firstFrame,
    lastFrame: e.lastFrame,
  }));

  // `>= 0.9` rather than `>= 1`: a cause firing on nearly every frame is the same
  // problem, and an exact ratio is brittle against the frame the sample started
  // or ended on.
  const everyFrame = causes.filter((c) => c.perFrame >= 0.9);
  const limited = causes.slice(0, options.limit ?? 10);

  const label = (c: DirtyCause): string =>
    `${c.entity ?? 'scene'} — ${c.reason}${c.property ? `.${c.property}` : ''}`;

  let summary: string;
  if (renderMode === 'always') {
    summary = `renderMode is 'always', so the scene redraws every frame regardless. Top cause over ${frames} frames: ${label(causes[0]!)} (${causes[0]!.count}x). Switch to 'onDemand' before reading anything into this.`;
  } else if (everyFrame.length > 0) {
    const worst = everyFrame[0]!;
    summary = `Continuous redraw detected: ${label(worst)} marked the scene dirty ${worst.count}x over ${frames} frames (${worst.perFrame.toFixed(2)}/frame). onDemand cannot idle while this continues.`;
  } else {
    summary = `No cause fires every frame over ${frames} frames, so onDemand is idling as intended. Top cause: ${label(causes[0]!)} (${causes[0]!.count}x).`;
  }

  return { renderMode, frames, causes: limited, everyFrame, summary };
}
