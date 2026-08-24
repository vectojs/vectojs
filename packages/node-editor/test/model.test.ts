import { describe, expect, it } from 'vitest';
import {
  addLink,
  cloneDocument,
  createDocument,
  getNode,
  updateNodePosition,
  validateLink,
} from '../src/model';

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

  it('deep clones nested data records so history snapshots cannot alias them', () => {
    const document = createDocument({
      nodes: [
        {
          id: 'a',
          type: 'input',
          title: 'A',
          position: { x: 1, y: 2 },
          data: { nested: { value: 1 } },
        },
      ],
      links: [{ id: 'l1', source: 'a', target: 'a2', data: { inner: { weight: 2 } } }],
    });
    const copy = cloneDocument(document);
    (copy.nodes[0].data as { nested: { value: number } }).nested.value = 99;
    (copy.links[0].data as { inner: { weight: number } }).inner.weight = 99;
    expect((document.nodes[0].data as { nested: { value: number } }).nested.value).toBe(1);
    expect((document.links[0].data as { inner: { weight: number } }).inner.weight).toBe(2);
  });

  it('rejects duplicate link ids at creation', () => {
    const document = createDocument({
      nodes: [
        {
          id: 'a',
          type: 'input',
          title: 'A',
          position: { x: 0, y: 0 },
          ports: [{ id: 'out', direction: 'output' }],
        },
        {
          id: 'b',
          type: 'output',
          title: 'B',
          position: { x: 200, y: 0 },
          ports: [{ id: 'in', direction: 'input' }],
        },
        {
          id: 'c',
          type: 'output',
          title: 'C',
          position: { x: 400, y: 0 },
          ports: [{ id: 'in', direction: 'input' }],
        },
      ],
      links: [],
    });
    const first = addLink(document, {
      id: 'l1',
      source: 'a',
      sourcePort: 'out',
      target: 'b',
      targetPort: 'in',
    });
    expect(
      validateLink(first, {
        id: 'l1',
        source: 'a',
        sourcePort: 'out',
        target: 'c',
        targetPort: 'in',
      }),
    ).toEqual({
      valid: false,
      error: 'duplicate-link-id',
    });
    expect(() =>
      addLink(first, {
        id: 'l1',
        source: 'a',
        sourcePort: 'out',
        target: 'c',
        targetPort: 'in',
      }),
    ).toThrow(/duplicate-link-id/);
  });

  it('validates typed port direction and capacity', () => {
    const document = createDocument({
      nodes: [
        {
          id: 'source',
          type: 'source',
          title: 'Source',
          position: { x: 0, y: 0 },
          ports: [{ id: 'out', direction: 'output', dataType: 'number' }],
        },
        {
          id: 'target',
          type: 'target',
          title: 'Target',
          position: { x: 200, y: 0 },
          ports: [{ id: 'in', direction: 'input', dataType: 'number' }],
        },
      ],
      links: [],
    });
    const link = {
      id: 'l1',
      source: 'source',
      sourcePort: 'out',
      target: 'target',
      targetPort: 'in',
    };
    expect(validateLink(document, link)).toEqual({ valid: true });
    const connected = addLink(document, link);
    expect(validateLink(connected, { ...link, id: 'l2' })).toEqual({
      valid: false,
      error: 'duplicate-link',
    });
  });
});
