import type { GraphData, GraphLayout } from '@vectojs/graph3d';
import { describe, expect, it, vi } from 'vitest';
import {
  KnowledgeGraphModel,
  MemoryDataSource,
  type KgDataSource,
  type KgGraphData,
  type KgNeighborhood,
  type NodeId,
} from '../src/model';

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

class RecordingLayout implements GraphLayout {
  positions = new Float32Array();
  graphs: GraphData[] = [];

  setGraph(data: GraphData): void {
    this.graphs.push(data);
    const previous = this.positions;
    this.positions = new Float32Array(data.nodes.length * 3);
    this.positions.set(previous.subarray(0, this.positions.length));
    for (let i = previous.length; i < this.positions.length; i++) this.positions[i] = i + 1;
  }

  step(): boolean {
    return false;
  }

  dispose = vi.fn();
}

describe('KnowledgeGraphModel', () => {
  it('paginates, dedupes pages, and preserves layout positions', async () => {
    const layout = new RecordingLayout();
    const model = new KnowledgeGraphModel({
      source: new MemoryDataSource(SAMPLE),
      layout,
      pageSize: 1,
    });

    await model.bootstrap(['a'], false);
    layout.positions[0] = 42;
    const first = await model.expand('a');
    expect(first.state).toMatchObject({ status: 'partial', loaded: 1, total: 2, cursor: '1' });
    expect(layout.positions[0]).toBe(42);

    const second = await model.expand('a');
    expect(second.state).toMatchObject({ status: 'complete', loaded: 2, total: 2 });
    expect(model.entityCount).toBe(3);
    expect(model.factCount).toBe(2);
    model.dispose();
  });

  it('cancels without losing pages and resumes from the retained cursor', async () => {
    let resolvePage: ((value: KgNeighborhood) => void) | undefined;
    const source: KgDataSource = {
      getNodes: () => SAMPLE.entities,
      getNeighbors: (_id, options) =>
        new Promise((resolve) => {
          expect(options?.cursor).toBe('next');
          resolvePage = resolve;
        }),
    };
    const model = new KnowledgeGraphModel({ source });
    model.importSnapshot({
      version: 1,
      entities: SAMPLE.entities.slice(0, 2),
      facts: SAMPLE.facts.slice(0, 1),
      expansions: [{ id: 'a', status: 'partial', loaded: 1, cursor: 'next', hasMore: true }],
    });

    const pending = model.expand('a');
    model.cancelExpand('a');
    resolvePage?.({
      entity: SAMPLE.entities[0]!,
      neighbors: [SAMPLE.entities[2]!],
      facts: [SAMPLE.facts[1]!],
      hasMore: false,
    });
    const cancelled = await pending;
    expect(cancelled.state).toMatchObject({ status: 'cancelled', loaded: 1, cursor: 'next' });
    expect(model.factCount).toBe(1);

    const resumedPromise = model.expand('a');
    resolvePage?.({
      entity: SAMPLE.entities[0]!,
      neighbors: [SAMPLE.entities[2]!],
      facts: [SAMPLE.facts[1]!],
      hasMore: false,
    });
    const resumed = await resumedPromise;
    expect(resumed.state).toMatchObject({ status: 'complete', loaded: 2 });
  });

  it('preserves retry state after failure and makes same-node expansion single-flight', async () => {
    let rejectPage: ((reason: Error) => void) | undefined;
    const source: KgDataSource = {
      getNodes: () => SAMPLE.entities,
      getNeighbors: () =>
        new Promise((_resolve, reject) => {
          rejectPage = reject;
        }),
    };
    const model = new KnowledgeGraphModel({ source });
    const first = model.expand('a');
    expect(model.expand('a')).toBe(first);
    rejectPage?.(new Error('temporary'));
    await expect(first).rejects.toThrow('temporary');
    expect(model.getExpansionState('a')).toMatchObject({ status: 'failed', loaded: 0 });
  });

  it('round-trips snapshots and rejects use after dispose', async () => {
    const model = new KnowledgeGraphModel({ source: new MemoryDataSource(SAMPLE) });
    await model.bootstrap(['a'], true);
    const restored = new KnowledgeGraphModel({ source: new MemoryDataSource() });
    restored.importSnapshot(model.exportSnapshot());
    expect(restored.listEntities()).toEqual(model.listEntities());
    expect(restored.listFacts()).toEqual(model.listFacts());
    restored.dispose();
    await expect(restored.expand('a')).rejects.toThrow('disposed');
  });

  it('versions stale completions after snapshot replacement', async () => {
    let resolvePage: ((value: KgNeighborhood) => void) | undefined;
    const source: KgDataSource = {
      getNodes: () => [],
      getNeighbors: (_id: NodeId) => new Promise((resolve) => (resolvePage = resolve)),
    };
    const model = new KnowledgeGraphModel({ source });
    const pending = model.expand('a');
    model.importSnapshot({ version: 1, entities: [], facts: [], expansions: [] });
    resolvePage?.({ entity: SAMPLE.entities[0]!, neighbors: [], facts: [], hasMore: false });
    await pending;
    expect(model.entityCount).toBe(0);
  });
});
