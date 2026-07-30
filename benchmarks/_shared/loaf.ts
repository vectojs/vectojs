import type {
  LongAnimationFrameObservation,
  LongAnimationFrameRecord,
  LongAnimationFrameScriptAttribution,
} from './schema.ts';

const MAX_RETAINED_FRAMES = 10;
const MAX_RETAINED_SCRIPTS = 10;

interface RawScriptTiming extends PerformanceEntry {
  executionStart?: number;
  forcedStyleAndLayoutDuration?: number;
  invoker?: string;
  invokerType?: string;
  pauseDuration?: number;
  sourceCharPosition?: number;
  sourceFunctionName?: string;
  sourceURL?: string;
  windowAttribution?: string;
}

interface RawLongAnimationFrame extends PerformanceEntry {
  blockingDuration?: number;
  firstUIEventTimestamp?: number;
  renderStart?: number;
  scripts?: readonly RawScriptTiming[];
  styleAndLayoutStart?: number;
}

export interface LongAnimationFrameObserverLike {
  observe(options: PerformanceObserverInit): void;
  takeRecords(): PerformanceEntry[];
  disconnect(): void;
}

export interface LongAnimationFrameObserverEnvironment {
  now(): number;
  supportedEntryTypes: readonly string[];
  create(onEntries: (entries: readonly PerformanceEntry[]) => void): LongAnimationFrameObserverLike;
}

export interface LongAnimationFrameCollector {
  finish(): LongAnimationFrameObservation;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundedMilliseconds(value: unknown): number {
  return Math.round(finiteNumber(value) * 1000) / 1000;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * An observation carrying no data, with the reason it carries none.
 *
 * Exported so {@link buildResult} can withhold LoAF for a benchmark that drives
 * frames synthetically, which is a property of the harness rather than something
 * the observer could detect for itself.
 */
export function unavailableObservation(
  reason: LongAnimationFrameObservation['reason'],
): LongAnimationFrameObservation {
  return unavailable(reason);
}

function unavailable(
  reason: LongAnimationFrameObservation['reason'],
): LongAnimationFrameObservation {
  return {
    status: 'unavailable',
    reason,
    entryCount: 0,
    totalDurationMs: 0,
    totalBlockingDurationMs: 0,
    droppedEntries: 0,
    entries: [],
  };
}

function normalizeScript(raw: RawScriptTiming): LongAnimationFrameScriptAttribution {
  return {
    startTimeMs: roundedMilliseconds(raw.startTime),
    durationMs: roundedMilliseconds(raw.duration),
    executionStartMs: roundedMilliseconds(raw.executionStart),
    forcedStyleAndLayoutDurationMs: roundedMilliseconds(raw.forcedStyleAndLayoutDuration),
    pauseDurationMs: roundedMilliseconds(raw.pauseDuration),
    invoker: stringValue(raw.invoker),
    invokerType: stringValue(raw.invokerType),
    sourceURL: stringValue(raw.sourceURL),
    sourceFunctionName: stringValue(raw.sourceFunctionName),
    sourceCharPosition: finiteNumber(raw.sourceCharPosition),
    windowAttribution: stringValue(raw.windowAttribution),
  };
}

function compareScriptDuration(left: RawScriptTiming, right: RawScriptTiming): number {
  return finiteNumber(left.duration) - finiteNumber(right.duration);
}

function compareFrameWeight(left: RawLongAnimationFrame, right: RawLongAnimationFrame): number {
  return (
    finiteNumber(left.blockingDuration) - finiteNumber(right.blockingDuration) ||
    finiteNumber(left.duration) - finiteNumber(right.duration)
  );
}

function normalizeFrame(raw: RawLongAnimationFrame): LongAnimationFrameRecord {
  const rawScripts: readonly RawScriptTiming[] = Array.isArray(raw.scripts) ? raw.scripts : [];
  const retainedScripts: RawScriptTiming[] = [];
  for (const script of rawScripts) {
    if (retainedScripts.length < MAX_RETAINED_SCRIPTS) {
      retainedScripts.push(script);
      continue;
    }
    let shortest = 0;
    for (let index = 1; index < retainedScripts.length; index += 1) {
      if (compareScriptDuration(retainedScripts[index]!, retainedScripts[shortest]!) < 0) {
        shortest = index;
      }
    }
    if (compareScriptDuration(script, retainedScripts[shortest]!) > 0) {
      retainedScripts[shortest] = script;
    }
  }
  retainedScripts.sort(
    (left, right) =>
      compareScriptDuration(right, left) ||
      finiteNumber(left.startTime) - finiteNumber(right.startTime),
  );
  const scripts = retainedScripts.map(normalizeScript);
  return {
    startTimeMs: roundedMilliseconds(raw.startTime),
    durationMs: roundedMilliseconds(raw.duration),
    blockingDurationMs: roundedMilliseconds(raw.blockingDuration),
    renderStartMs: roundedMilliseconds(raw.renderStart),
    styleAndLayoutStartMs: roundedMilliseconds(raw.styleAndLayoutStart),
    firstUIEventTimestampMs: roundedMilliseconds(raw.firstUIEventTimestamp),
    scriptCount: rawScripts.length,
    droppedScripts: rawScripts.length - scripts.length,
    scripts,
  };
}

function defaultEnvironment(): LongAnimationFrameObserverEnvironment | null {
  if (typeof PerformanceObserver !== 'function') return null;
  return {
    now: () => performance.now(),
    supportedEntryTypes: PerformanceObserver.supportedEntryTypes ?? [],
    create: (onEntries) => {
      const observer = new PerformanceObserver((list) => onEntries(list.getEntries()));
      return observer;
    },
  };
}

/** Observe measured work and retain only the ten frames with the greatest blocking duration. */
export function observeLongAnimationFrames(
  environment: LongAnimationFrameObserverEnvironment | null = defaultEnvironment(),
): LongAnimationFrameCollector {
  if (!environment?.supportedEntryTypes.includes('long-animation-frame')) {
    const result = unavailable('unsupported');
    return { finish: () => result };
  }

  let active = true;
  let entryCount = 0;
  let totalDurationMs = 0;
  let totalBlockingDurationMs = 0;
  let result: LongAnimationFrameObservation | null = null;
  const retained: RawLongAnimationFrame[] = [];

  const observedAfter = environment.now();
  const collect = (entries: readonly PerformanceEntry[]): void => {
    if (!active) return;
    for (const entry of entries) {
      if (entry.entryType !== 'long-animation-frame' || entry.startTime < observedAfter) continue;
      const raw = entry as RawLongAnimationFrame;
      entryCount += 1;
      totalDurationMs += finiteNumber(raw.duration);
      totalBlockingDurationMs += finiteNumber(raw.blockingDuration);
      if (retained.length < MAX_RETAINED_FRAMES) {
        retained.push(raw);
        continue;
      }

      let weakest = 0;
      for (let index = 1; index < retained.length; index += 1) {
        if (compareFrameWeight(retained[index]!, retained[weakest]!) < 0) {
          weakest = index;
        }
      }
      if (compareFrameWeight(raw, retained[weakest]!) > 0) {
        retained[weakest] = raw;
      }
    }
  };

  let observer: LongAnimationFrameObserverLike | null = null;
  try {
    observer = environment.create(collect);
    // Use the entryTypes form exercised by Blink's own LoAF tests. It observes
    // future entries only, and observedAfter remains a defensive boundary.
    observer.observe({
      entryTypes: ['long-animation-frame'],
    } as PerformanceObserverInit);
  } catch {
    active = false;
    try {
      observer?.disconnect();
    } catch {}
    const failed = unavailable('observer-error');
    return { finish: () => failed };
  }
  const activeObserver = observer;

  return {
    finish(): LongAnimationFrameObservation {
      if (result) return result;
      let failed = false;
      try {
        collect(activeObserver.takeRecords());
      } catch {
        failed = true;
      }
      active = false;
      try {
        activeObserver.disconnect();
      } catch {
        failed = true;
      }
      if (failed) {
        result = unavailable('observer-error');
        return result;
      }

      retained.sort(
        (left, right) =>
          compareFrameWeight(right, left) ||
          finiteNumber(left.startTime) - finiteNumber(right.startTime),
      );
      result = {
        status: 'supported',
        reason: null,
        entryCount,
        totalDurationMs: roundedMilliseconds(totalDurationMs),
        totalBlockingDurationMs: roundedMilliseconds(totalBlockingDurationMs),
        droppedEntries: entryCount - retained.length,
        entries: retained.map(normalizeFrame),
      };
      return result;
    },
  };
}
