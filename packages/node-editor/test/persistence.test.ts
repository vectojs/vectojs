import { describe, expect, it } from 'vitest';
import {
  exportDocument,
  importDocument,
  NODE_EDITOR_SCHEMA_VERSION,
  serializeDocument,
  NodeEditorPersistenceError,
} from '../src/persistence';

const document = {
  nodes: [
    {
      id: 'source',
      type: 'number-source',
      title: 'Source',
      position: { x: 10, y: 20 },
      ports: [{ id: 'out', direction: 'output' as const, dataType: 'number' }],
      data: { config: { value: 42 } },
    },
    {
      id: 'target',
      type: 'number-target',
      title: 'Target',
      position: { x: 300, y: 20 },
      ports: [{ id: 'in', direction: 'input' as const, dataType: 'number' }],
    },
  ],
  links: [
    {
      id: 'link',
      source: 'source',
      sourcePort: 'out',
      target: 'target',
      targetPort: 'in',
      data: { weight: 1 },
    },
  ],
};

describe('node editor persistence', () => {
  it('round trips versioned documents with typed ports and links', () => {
    const serialized = exportDocument(document);
    expect(JSON.parse(serialized).schemaVersion).toBe(NODE_EDITOR_SCHEMA_VERSION);
    expect(importDocument(serialized)).toEqual(document);
    expect(serialized).toBe(serializeDocument(document));
  });

  it('rejects malformed JSON, versions, data, and references', () => {
    expect(() => importDocument('{')).toThrow(NodeEditorPersistenceError);
    expect(() => importDocument(JSON.stringify({ ...document, schemaVersion: 2 }))).toThrow(
      NodeEditorPersistenceError,
    );
    expect(() =>
      importDocument(
        JSON.stringify({
          ...document,
          links: [{ ...document.links[0], targetPort: 'missing' }],
        }),
      ),
    ).toThrow(NodeEditorPersistenceError);
    expect(() => importDocument(JSON.stringify(null))).toThrow(NodeEditorPersistenceError);
    expect(() =>
      importDocument(JSON.stringify({ schemaVersion: 1, nodes: {}, links: [] })),
    ).toThrow(NodeEditorPersistenceError);
  });

  it('deep clones nested data on both sides of the round trip', () => {
    const serialized = exportDocument(document);
    const restored = importDocument(serialized);
    const sourceData = document.nodes[0].data as { config: { value: number } };
    const restoredData = restored.nodes[0].data as { config: { value: number } };
    sourceData.config.value = 7;
    restoredData.config.value = 8;
    expect(sourceData.config.value).toBe(7);
    expect(restoredData.config.value).toBe(8);
    expect(JSON.parse(serialized).nodes[0].data.config.value).toBe(42);
    sourceData.config.value = 42;
  });

  it('rejects non-JSON-safe values before JSON serialization', () => {
    expect(() =>
      serializeDocument({
        ...document,
        nodes: [{ ...document.nodes[0], data: { value: undefined } }],
      }),
    ).toThrow();
    expect(() =>
      serializeDocument({
        ...document,
        nodes: [{ ...document.nodes[0], position: { x: Infinity, y: 0 } }],
      }),
    ).toThrow();
    const symbol = Symbol('not-json');
    expect(() =>
      serializeDocument({
        ...document,
        nodes: [{ ...document.nodes[0], data: { [symbol]: true } }],
      }),
    ).toThrow();
  });

  it('returns an independent imported document', () => {
    const restored = importDocument(exportDocument(document));
    const restoredNode = restored.nodes[0];
    const restoredLink = restored.links[0];
    const originalNode = document.nodes[0];
    const originalLink = document.links[0];

    (restoredNode.position as { x: number }).x = 99;
    (restoredNode.data as { config: { value: number } }).config.value = 99;
    (restoredNode.ports as { dataType?: string }[])[0].dataType = 'string';
    (restoredLink.data as { weight: number }).weight = 99;

    expect(originalNode.position.x).toBe(10);
    expect((originalNode.data as { config: { value: number } }).config.value).toBe(42);
    expect(originalNode.ports?.[0].dataType).toBe('number');
    expect((originalLink.data as { weight: number }).weight).toBe(1);
  });
});
