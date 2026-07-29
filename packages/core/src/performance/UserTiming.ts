/** Stable User Timing measure names emitted by VectoJS instrumentation. */
export const VECTO_USER_TIMING = {
  scene: {
    transform: 'vecto:scene:transform',
    drawWalk: 'vecto:scene:draw-walk',
    entityPaint: 'vecto:scene:entity-paint',
    flush: 'vecto:scene:flush',
    a11ySync: 'vecto:scene:a11y-sync',
  },
  markdown: {
    parse: 'vecto:markdown:parse',
  },
} as const;

interface TimingPerformance {
  now(): number;
  mark(name: string, options?: { startTime?: number }): unknown;
  measure(name: string, startMark: string, endMark: string): unknown;
  clearMarks?(name?: string): void;
}

/** Opaque handle for one enabled User Timing interval. */
export interface VectoUserTimingSpan {
  readonly name: string;
  readonly startMark: string;
  readonly endMark: string;
  readonly performance: TimingPerformance;
}

let nextSpanId = 0;

/**
 * Begin a User Timing interval when the host implements marks and measures.
 * Returns `null` instead of making optional profiling a runtime requirement.
 */
export function beginVectoUserTiming(name: string): VectoUserTimingSpan | null {
  const candidate = globalThis.performance as Partial<TimingPerformance> | undefined;
  if (typeof candidate?.mark !== 'function' || typeof candidate.measure !== 'function') {
    return null;
  }

  const id = nextSpanId++;
  const startMark = `${name}:start:${id}`;
  const endMark = `${name}:end:${id}`;
  try {
    candidate.mark(startMark);
    return {
      name,
      startMark,
      endMark,
      performance: candidate as TimingPerformance,
    };
  } catch {
    return null;
  }
}

/** Finish a span and release its uniquely named marks. */
export function endVectoUserTiming(span: VectoUserTimingSpan | null): void {
  if (!span) return;
  const timing = span.performance;
  try {
    timing.mark(span.endMark);
    timing.measure(span.name, span.startMark, span.endMark);
  } catch {
    // Profiling is diagnostic-only and must never break rendering.
  } finally {
    try {
      timing.clearMarks?.(span.startMark);
      timing.clearMarks?.(span.endMark);
    } catch {
      // Host implementations may expose incomplete User Timing methods.
    }
  }
}

/**
 * Emit one measure for a duration accumulated from disjoint calls.
 *
 * The marks are anchored at the current time with the measured duration ending
 * there. This keeps one entry per frame while still reporting the sum of every
 * entity's paint call instead of instrumenting every entity individually.
 */
export function measureVectoUserTiming(name: string, durationMs: number): void {
  const candidate = globalThis.performance as Partial<TimingPerformance> | undefined;
  if (
    typeof candidate?.now !== 'function' ||
    typeof candidate.mark !== 'function' ||
    typeof candidate.measure !== 'function'
  ) {
    return;
  }

  const id = nextSpanId++;
  const startMark = `${name}:start:${id}`;
  const endMark = `${name}:end:${id}`;
  const endTime = candidate.now();
  const startTime = Math.max(0, endTime - Math.max(0, durationMs));
  try {
    candidate.mark(startMark, { startTime });
    candidate.mark(endMark, { startTime: endTime });
    candidate.measure(name, startMark, endMark);
  } catch {
    // Profiling is diagnostic-only and must never break rendering.
  } finally {
    try {
      candidate.clearMarks?.(startMark);
      candidate.clearMarks?.(endMark);
    } catch {
      // Host implementations may expose incomplete User Timing methods.
    }
  }
}
