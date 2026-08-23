// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { FixedZLayout } from '../src/FixedZLayout';
import { KnowledgeGraphSession } from '../src/KnowledgeGraphSession';
import { MemoryDataSource } from '../src/MemoryDataSource';
import type { KgDataSource, KgGraphData } from '../src/types';
import * as THREE from 'three';

const SAMPLE: KgGraphData = {
  entities: [
    { id: 'a', type: 'Person', labels: { en: 'Ada' } },
    { id: 'b', type: 'Person', labels: { en: 'Bob' } },
    { id: 'c', type: 'Org', labels: { en: 'Corp' } },
  ],
  facts: [
    { source: 'a', target: 'b', predicate: 'knows' },
    { source: 'a', target: 'c', predicate: 'worksAt' },
  ],
};

const dom = () => {
  const el = document.createElement('canvas');
  Object.defineProperty(el, 'clientWidth', { value: 400 });
  Object.defineProperty(el, 'clientHeight', { value: 300 });
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  return el;
};

describe('KnowledgeGraphSession', () => {
  it('bootstraps seeds and expands one hop', async () => {
    const src = new MemoryDataSource(SAMPLE);
    const session = new KnowledgeGraphSession({
      domElement: dom(),
      source: src,
      mode: '2d',
      expandOnSelect: false,
    });
    await session.bootstrap(['a'], true);
    expect(session.entityCount).toBe(3);
    expect(session.factCount).toBe(2);
    expect(session.getMode()).toBe('2d');
    // Layout has planar z
    const pos = session.layout.positions;
    for (let i = 0; i < session.entityCount; i++) {
      expect(pos[i * 3 + 2]).toBe(0);
    }
    session.tick(5);
    session.dispose();
  });

  it('does not re-fetch an already expanded node', async () => {
    const src = new MemoryDataSource(SAMPLE);
    const spy = vi.spyOn(src, 'getNeighbors');
    const session = new KnowledgeGraphSession({
      domElement: dom(),
      source: src,
      expandOnSelect: false,
    });
    await session.bootstrap(['a'], true);
    const n = spy.mock.calls.length;
    await session.expand('a');
    expect(spy.mock.calls.length).toBe(n);
    session.dispose();
  });

  it('attach + render does not throw with a headless WebGL mock skip', async () => {
    const session = new KnowledgeGraphSession({
      domElement: dom(),
      source: new MemoryDataSource(SAMPLE),
      expandOnSelect: false,
    });
    await session.bootstrap(['b'], false);
    const scene = new THREE.Scene();
    session.attach(scene);
    expect(scene.children).toContain(session.graph.group);
    session.dispose();
  });
});

describe('KnowledgeGraphSession review fixes', () => {
  it('tick returns true when settled (inverts layout.step hot flag)', async () => {
    const session = new KnowledgeGraphSession({
      domElement: dom(),
      source: new MemoryDataSource(SAMPLE),
      expandOnSelect: false,
    });
    session.loadSnapshot(SAMPLE);
    // Immediately after load, layout is hot → tick should be false (not settled)
    const first = session.tick(1);
    // Drive to cool
    let settled = first;
    let guard = 0;
    while (!settled && guard < 500) {
      settled = session.tick(2);
      guard++;
    }
    expect(settled).toBe(true);
    expect(session.tick(1)).toBe(true);
    session.dispose();
  });

  it('expand preserves positions of pre-existing nodes', async () => {
    const src = new MemoryDataSource(SAMPLE);
    const session = new KnowledgeGraphSession({
      domElement: dom(),
      source: src,
      expandOnSelect: false,
    });
    await session.bootstrap(['b'], false);
    // settle a bit
    for (let i = 0; i < 40; i++) session.tick(2);
    const before = session.listEntities();
    const bIdx = before.findIndex((e) => e.id === 'b');
    expect(bIdx).toBeGreaterThanOrEqual(0);
    const pos = session.layout.positions;
    const bx = pos[bIdx * 3]!;
    const by = pos[bIdx * 3 + 1]!;
    await session.expand('b');
    const after = session.listEntities();
    const bIdx2 = after.findIndex((e) => e.id === 'b');
    const pos2 = session.layout.positions;
    // Same id keeps roughly the same coordinates (warm start)
    expect(pos2[bIdx2 * 3]!).toBeCloseTo(bx, 4);
    expect(pos2[bIdx2 * 3 + 1]!).toBeCloseTo(by, 4);
    // Graph grew
    expect(session.entityCount).toBeGreaterThan(before.length);
    session.dispose();
  });
});

describe('KnowledgeGraphSession async safety and ownership', () => {
  /** Select a node through the wired handler without simulating pointer events. */
  const selectAt = (session: KnowledgeGraphSession, index: number | null): void => {
    (session as unknown as { handleSelect(index: number | null): void }).handleSelect(index);
  };

  it('routes select-triggered expand failures to onError', async () => {
    let calls = 0;
    const failing: KgDataSource = {
      getNodes: (ids) => SAMPLE.entities.filter((e) => ids?.includes(e.id)),
      getNeighbors: () => {
        calls++;
        return Promise.reject(new Error('loader down'));
      },
    };
    const onError = vi.fn();
    const session = new KnowledgeGraphSession({
      domElement: dom(),
      source: failing,
      onError,
    });
    await session.bootstrap(['b'], false); // no expansion yet, so select expands
    selectAt(session, 0);
    // The rejection must be routed to onError — an unhandled rejection would
    // fail this suite.
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(calls).toBe(1);
    const [error, entity] = onError.mock.calls[0]!;
    expect((error as Error).message).toBe('loader down');
    expect(entity?.id).toBe('b');
    session.dispose();
  });

  it('logs instead of throwing when no onError handler is given', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: KgDataSource = {
      getNodes: () => SAMPLE.entities,
      getNeighbors: () => Promise.reject(new Error('boom')),
    };
    const session = new KnowledgeGraphSession({ domElement: dom(), source: failing });
    try {
      await session.bootstrap(['b'], false);
      selectAt(session, 0);
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          '[KnowledgeGraphSession] select expand failed:',
          expect.any(Error),
        ),
      );
    } finally {
      consoleError.mockRestore();
      session.dispose();
    }
  });

  it('model is the single layout driver during expand', async () => {
    const setGraphSpy = vi.spyOn(FixedZLayout.prototype, 'setGraph');
    const reheatSpy = vi.spyOn(FixedZLayout.prototype, 'reheat');
    const session = new KnowledgeGraphSession({
      domElement: dom(),
      source: new MemoryDataSource(SAMPLE),
      expandOnSelect: false,
    });
    try {
      await session.bootstrap(['b'], false); // one initial build, no reheat
      const builds = setGraphSpy.mock.calls.length;
      const heats = reheatSpy.mock.calls.length;
      await session.expand('b'); // exactly one setGraph + one reheat, from the model
      expect(setGraphSpy.mock.calls.length).toBe(builds + 1);
      expect(reheatSpy.mock.calls.length).toBe(heats + 1);
      // b was seeded alone; expanding it pulls in a (fact a→b).
      expect(session.entityCount).toBe(2);
    } finally {
      setGraphSpy.mockRestore();
      reheatSpy.mockRestore();
      session.dispose();
    }
  });

  it('disposes the layout it constructed', () => {
    const disposeSpy = vi.spyOn(FixedZLayout.prototype, 'dispose');
    const session = new KnowledgeGraphSession({
      domElement: dom(),
      source: new MemoryDataSource(SAMPLE),
      expandOnSelect: false,
    });
    expect(disposeSpy).not.toHaveBeenCalled();
    session.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    disposeSpy.mockRestore();
  });
});
