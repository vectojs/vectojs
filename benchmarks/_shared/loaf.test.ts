import { describe, expect, test } from 'bun:test';
import {
  observeLongAnimationFrames,
  type LongAnimationFrameObserverEnvironment,
  type LongAnimationFrameObserverLike,
} from './loaf.ts';

function entry(properties: Record<string, unknown>): PerformanceEntry {
  return {
    name: '',
    entryType: 'long-animation-frame',
    startTime: 100,
    duration: 60,
    toJSON: () => ({}),
    ...properties,
  } as PerformanceEntry;
}

function createHarness(now = 100): {
  environment: LongAnimationFrameObserverEnvironment;
  observer: LongAnimationFrameObserverLike;
  observeCalls: PerformanceObserverInit[];
  pending: PerformanceEntry[];
  emit: (entries: readonly PerformanceEntry[]) => void;
  disconnectCount: () => number;
} {
  let onEntries: (entries: readonly PerformanceEntry[]) => void = () => {};
  let disconnects = 0;
  const observeCalls: PerformanceObserverInit[] = [];
  const pending: PerformanceEntry[] = [];
  const observer: LongAnimationFrameObserverLike = {
    observe(options) {
      observeCalls.push(options);
    },
    takeRecords() {
      return pending.splice(0);
    },
    disconnect() {
      disconnects += 1;
    },
  };
  const environment: LongAnimationFrameObserverEnvironment = {
    now: () => now,
    supportedEntryTypes: ['long-animation-frame'],
    create(callback) {
      onEntries = callback;
      return observer;
    },
  };
  return {
    environment,
    observer,
    observeCalls,
    pending,
    emit: (entries) => onEntries(entries),
    disconnectCount: () => disconnects,
  };
}

describe('observeLongAnimationFrames', () => {
  test('reports unsupported without constructing an observer', () => {
    let createCalls = 0;
    const collector = observeLongAnimationFrames({
      now: () => 0,
      supportedEntryTypes: ['measure'],
      create() {
        createCalls += 1;
        throw new Error('must not construct');
      },
    });

    expect(collector.finish()).toEqual({
      status: 'unavailable',
      reason: 'unsupported',
      entryCount: 0,
      totalDurationMs: 0,
      totalBlockingDurationMs: 0,
      droppedEntries: 0,
      entries: [],
    });
    expect(createCalls).toBe(0);
  });

  test('collects callback and pending records, filters bootstrap entries, and normalizes attribution', () => {
    const harness = createHarness();
    const collector = observeLongAnimationFrames(harness.environment);
    const shortScript = entry({
      startTime: 102.1114,
      duration: 2.1114,
      executionStart: 102.2,
      forcedStyleAndLayoutDuration: 0.1236,
      invoker: 'short',
      invokerType: 'event-listener',
      pauseDuration: 0,
      sourceCharPosition: 42,
      sourceFunctionName: 'shortWork',
      sourceURL: 'http://localhost/short.js',
      windowAttribution: 'self',
    });
    const longScript = entry({
      startTime: 101.5555,
      duration: 9.5555,
      executionStart: 101.6,
      forcedStyleAndLayoutDuration: 1.5555,
      invoker: 'long',
      invokerType: 'user-callback',
      pauseDuration: 0.3333,
    });

    harness.emit([
      entry({ entryType: 'measure', startTime: 110 }),
      entry({ startTime: 99, duration: 999, blockingDuration: 999 }),
      entry({
        startTime: 101.1114,
        duration: 80.1236,
        blockingDuration: 30.5678,
        renderStart: 170.1236,
        styleAndLayoutStart: 175.1236,
        firstUIEventTimestamp: 100.1236,
        scripts: [shortScript, longScript],
      }),
    ]);
    harness.pending.push(entry({ startTime: 200, duration: 60, blockingDuration: 40 }));

    const result = collector.finish();
    expect(harness.observeCalls).toEqual([{ entryTypes: ['long-animation-frame'] }]);
    expect(harness.disconnectCount()).toBe(1);
    expect(result).toMatchObject({
      status: 'supported',
      reason: null,
      entryCount: 2,
      totalDurationMs: 140.124,
      totalBlockingDurationMs: 70.568,
      droppedEntries: 0,
    });
    expect(result.entries.map((frame) => frame.blockingDurationMs)).toEqual([40, 30.568]);
    expect(result.entries[1]).toMatchObject({
      startTimeMs: 101.111,
      durationMs: 80.124,
      renderStartMs: 170.124,
      styleAndLayoutStartMs: 175.124,
      firstUIEventTimestampMs: 100.124,
      scriptCount: 2,
      droppedScripts: 0,
    });
    expect(result.entries[1]!.scripts.map((script) => script.invoker)).toEqual(['long', 'short']);
    expect(result.entries[1]!.scripts[0]).toEqual({
      startTimeMs: 101.556,
      durationMs: 9.556,
      executionStartMs: 101.6,
      forcedStyleAndLayoutDurationMs: 1.556,
      pauseDurationMs: 0.333,
      invoker: 'long',
      invokerType: 'user-callback',
      sourceURL: '',
      sourceFunctionName: '',
      sourceCharPosition: 0,
      windowAttribution: '',
    });

    harness.emit([entry({ startTime: 300, blockingDuration: 100 })]);
    expect(collector.finish()).toBe(result);
    expect(result.entryCount).toBe(2);
  });

  test('retains only the ten heaviest frames and scripts while preserving totals', () => {
    const harness = createHarness();
    const collector = observeLongAnimationFrames(harness.environment);
    harness.emit(
      Array.from({ length: 12 }, (_, frameIndex) =>
        entry({
          startTime: 100 + frameIndex,
          duration: 100 + frameIndex,
          blockingDuration: frameIndex + 0.25,
          scripts: Array.from({ length: 12 }, (_, scriptIndex) =>
            entry({ startTime: scriptIndex, duration: scriptIndex }),
          ),
        }),
      ),
    );

    const result = collector.finish();
    expect(result.entryCount).toBe(12);
    expect(result.totalDurationMs).toBe(1266);
    expect(result.totalBlockingDurationMs).toBe(69);
    expect(result.droppedEntries).toBe(2);
    expect(result.entries.map((frame) => frame.blockingDurationMs)).toEqual([
      11.25, 10.25, 9.25, 8.25, 7.25, 6.25, 5.25, 4.25, 3.25, 2.25,
    ]);
    for (const frame of result.entries) {
      expect(frame.scriptCount).toBe(12);
      expect(frame.droppedScripts).toBe(2);
      expect(frame.scripts.map((script) => script.durationMs)).toEqual([
        11, 10, 9, 8, 7, 6, 5, 4, 3, 2,
      ]);
    }
  });

  test('turns observer setup and shutdown failures into stable unavailable results', () => {
    const createFailure = observeLongAnimationFrames({
      now: () => 0,
      supportedEntryTypes: ['long-animation-frame'],
      create() {
        throw new Error('create failed');
      },
    });
    expect(createFailure.finish().reason).toBe('observer-error');

    const observeFailureHarness = createHarness();
    observeFailureHarness.observer.observe = () => {
      throw new Error('observe failed');
    };
    const observeFailure = observeLongAnimationFrames(observeFailureHarness.environment);
    expect(observeFailure.finish().reason).toBe('observer-error');
    expect(observeFailureHarness.disconnectCount()).toBe(1);

    const takeFailureHarness = createHarness();
    takeFailureHarness.observer.takeRecords = () => {
      throw new Error('take failed');
    };
    const takeFailure = observeLongAnimationFrames(takeFailureHarness.environment);
    expect(takeFailure.finish().reason).toBe('observer-error');
    expect(takeFailureHarness.disconnectCount()).toBe(1);

    const disconnectFailureHarness = createHarness();
    disconnectFailureHarness.observer.disconnect = () => {
      throw new Error('disconnect failed');
    };
    const disconnectFailure = observeLongAnimationFrames(disconnectFailureHarness.environment);
    expect(disconnectFailure.finish().reason).toBe('observer-error');
    expect(disconnectFailure.finish()).toBe(disconnectFailure.finish());
  });
});
