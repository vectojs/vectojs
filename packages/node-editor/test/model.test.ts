import { describe, expect, it } from 'vitest';
import { cloneDocument, createDocument, getNode, updateNodePosition } from '../src/model';

describe('node document model', () => {
  it('clones nested document data without sharing mutable records', () => {
    const document = createDocument({
      nodes: [{ id: 'a', type: 'input', title: 'A', position: { x: 1, y: 2 }, data: { value: 3 } }],
      links: [],
    });
    const copy = cloneDocument(document);
    expect(copy).toEqual(document);
    expect(copy.nodes[0]).not.toBe(document.nodes[0]);
    expect(getNode(copy, 'a')?.title).toBe('A');
  });

  it('updates only the requested node position', () => {
    const document = createDocument({
      nodes: [
        { id: 'a', type: 'input', title: 'A', position: { x: 1, y: 2 } },
        { id: 'b', type: 'output', title: 'B', position: { x: 4, y: 5 } },
      ],
      links: [],
    });
    const next = updateNodePosition(document, 'a', { x: 10, y: 20 });
    expect(next.nodes.map((node) => node.position)).toEqual([
      { x: 10, y: 20 },
      { x: 4, y: 5 },
    ]);
    expect(document.nodes[0].position).toEqual({ x: 1, y: 2 });
  });
});
