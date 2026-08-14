// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeGraphSession } from '../src/KnowledgeGraphSession';
import { MemoryDataSource } from '../src/MemoryDataSource';
import type { KgGraphData } from '../src/types';
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
