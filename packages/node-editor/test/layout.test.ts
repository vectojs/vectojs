import { describe, expect, it } from 'vitest';
import { layoutDocument } from '../src/layout';
import type { NodeDocument } from '../src/model';

const node = (id: string, x = 99): NodeDocument['nodes'][number] => ({
  id,
  type: id,
  title: id,
  position: { x, y: x },
  width: 140,
  height: 80,
  data: { value: id },
});

describe('deterministic auto-layout', () => {
  it('layers links and sorts each layer by node ID regardless of input order', () => {
    const document: NodeDocument = {
      nodes: [node('c'), node('a'), node('b')],
      links: [
        { id: 'bc', source: 'b', target: 'c' },
        { id: 'ac', source: 'a', target: 'c' },
      ],
    };
    const result = layoutDocument(document, { originX: 10, originY: 20 });
    expect(result.nodes.map(({ id, position }) => [id, position])).toEqual([
      ['c', { x: 270, y: 20 }],
      ['a', { x: 10, y: 20 }],
      ['b', { x: 10, y: 140 }],
    ]);
  });

  it('places isolated nodes in the first layer and cycles together', () => {
    const document: NodeDocument = {
      nodes: [node('z'), node('y'), node('x')],
      links: [
        { id: 'xy', source: 'x', target: 'y' },
        { id: 'yx', source: 'y', target: 'x' },
      ],
    };
    const result = layoutDocument(document);
    expect(result.nodes.map(({ id, position }) => [id, position])).toEqual([
      ['z', { x: 0, y: 240 }],
      ['y', { x: 0, y: 120 }],
      ['x', { x: 0, y: 0 }],
    ]);
  });

  it('does not mutate nodes, positions, dimensions, data, or links', () => {
    const document: NodeDocument = { nodes: [node('a')], links: [] };
    const result = layoutDocument(document);
    expect(result).not.toBe(document);
    expect(result.nodes[0]).not.toBe(document.nodes[0]);
    expect(result.nodes[0].position).not.toBe(document.nodes[0].position);
    expect(result.nodes[0].width).toBe(140);
    expect(result.nodes[0].data).toBe(document.nodes[0].data);
    expect(result.links).toBe(document.links);
    expect(document.nodes[0].position).toEqual({ x: 99, y: 99 });
  });
});
