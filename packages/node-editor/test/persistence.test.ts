import { describe, expect, it } from 'vitest';
import {
  deserializeDocument,
  NODE_EDITOR_SCHEMA_VERSION,
  serializeDocument,
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
    const serialized = serializeDocument(document);
    expect(JSON.parse(serialized).schemaVersion).toBe(NODE_EDITOR_SCHEMA_VERSION);
    expect(deserializeDocument(serialized)).toEqual(document);
  });

  it('rejects malformed JSON, versions, data, and references', () => {
    expect(() => deserializeDocument('{')).toThrow();
    expect(() => deserializeDocument(JSON.stringify({ ...document, schemaVersion: 2 }))).toThrow();
    expect(() =>
      deserializeDocument(
        JSON.stringify({
          ...document,
          links: [{ ...document.links[0], targetPort: 'missing' }],
        }),
      ),
    ).toThrow();
  });

  it('deep clones nested data on both sides of the round trip', () => {
    const serialized = serializeDocument(document);
    const restored = deserializeDocument(serialized);
    const sourceData = document.nodes[0].data as { config: { value: number } };
    const restoredData = restored.nodes[0].data as { config: { value: number } };
    sourceData.config.value = 7;
    restoredData.config.value = 8;
    expect(sourceData.config.value).toBe(7);
    expect(restoredData.config.value).toBe(8);
    expect(JSON.parse(serialized).nodes[0].data.config.value).toBe(42);
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
});
