import type { LinkData, NodeData, NodeDocument, PortDefinition } from './model';

export const NODE_EDITOR_SCHEMA_VERSION = 1 as const;

export interface PersistedNodeDocument {
  schemaVersion: typeof NODE_EDITOR_SCHEMA_VERSION;
  nodes: NodeData[];
  links: LinkData[];
}

export interface NodeEditorPersistence {
  exportDocument(document: NodeDocument): string;
  importDocument(serialized: string): NodeDocument;
  serializeDocument(document: NodeDocument): string;
  deserializeDocument(serialized: string): NodeDocument;
}

export class NodeEditorPersistenceError extends Error {
  override name = 'NodeEditorPersistenceError';
}

function fail(message: string): never {
  throw new NodeEditorPersistenceError(`Invalid node document: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.length === Object.keys(value).length &&
      value.every((item, index) => index in value && isJsonValue(item, seen))
    : Object.getOwnPropertySymbols(value).length === 0 &&
      Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be finite`);
  return value;
}

function validateData(value: unknown, name: string): void {
  if (value !== undefined && !isJsonValue(value)) fail(`${name} must contain JSON-safe values`);
}

function validatePort(port: unknown, name: string): asserts port is PortDefinition {
  if (!isRecord(port)) fail(`${name} must be an object`);
  requireString(port.id, `${name}.id`);
  if (port.label !== undefined) requireString(port.label, `${name}.label`);
  if (port.direction !== 'input' && port.direction !== 'output')
    fail(`${name}.direction must be input or output`);
  if (port.dataType !== undefined) requireString(port.dataType, `${name}.dataType`);
  if (port.maxConnections !== undefined) {
    const maxConnections = requireFiniteNumber(port.maxConnections, `${name}.maxConnections`);
    if (!Number.isInteger(maxConnections) || maxConnections < -1)
      fail(`${name}.maxConnections must be an integer greater than or equal to -1`);
  }
}

function validateDocument(value: unknown): asserts value is NodeDocument {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.links))
    fail('nodes and links must be arrays');

  const nodeIds = new Set<string>();
  const ports = new Map<string, PortDefinition>();
  for (const [index, node] of value.nodes.entries()) {
    const name = `nodes[${index}]`;
    if (!isRecord(node)) fail(`${name} must be an object`);
    const id = requireString(node.id, `${name}.id`);
    if (nodeIds.has(id)) fail(`duplicate node id ${id}`);
    nodeIds.add(id);
    requireString(node.type, `${name}.type`);
    requireString(node.title, `${name}.title`);
    if (!isRecord(node.position)) fail(`${name}.position must be an object`);
    requireFiniteNumber(node.position.x, `${name}.position.x`);
    requireFiniteNumber(node.position.y, `${name}.position.y`);
    if (node.width !== undefined) requireFiniteNumber(node.width, `${name}.width`);
    if (node.height !== undefined) requireFiniteNumber(node.height, `${name}.height`);
    validateData(node.data, `${name}.data`);
    if (node.ports !== undefined) {
      if (!Array.isArray(node.ports)) fail(`${name}.ports must be an array`);
      for (const [portIndex, port] of node.ports.entries()) {
        const portName = `${name}.ports[${portIndex}]`;
        validatePort(port, portName);
        const key = `${id}:${port.id}`;
        if (ports.has(key)) fail(`duplicate port id ${port.id} on node ${id}`);
        ports.set(key, port);
      }
    }
  }

  const linkIds = new Set<string>();
  for (const [index, link] of value.links.entries()) {
    const name = `links[${index}]`;
    if (!isRecord(link)) fail(`${name} must be an object`);
    const id = requireString(link.id, `${name}.id`);
    if (linkIds.has(id)) fail(`duplicate link id ${id}`);
    linkIds.add(id);
    const source = requireString(link.source, `${name}.source`);
    const target = requireString(link.target, `${name}.target`);
    if (!nodeIds.has(source)) fail(`${name}.source references missing node ${source}`);
    if (!nodeIds.has(target)) fail(`${name}.target references missing node ${target}`);
    if (link.sourcePort !== undefined) {
      const port = ports.get(`${source}:${requireString(link.sourcePort, `${name}.sourcePort`)}`);
      if (!port) fail(`${name}.sourcePort references missing port`);
      if (port.direction !== 'output') fail(`${name}.sourcePort must be an output port`);
    }
    if (link.targetPort !== undefined) {
      const port = ports.get(`${target}:${requireString(link.targetPort, `${name}.targetPort`)}`);
      if (!port) fail(`${name}.targetPort references missing port`);
      if (port.direction !== 'input') fail(`${name}.targetPort must be an input port`);
    }
    const sourcePort =
      link.sourcePort === undefined ? undefined : ports.get(`${source}:${link.sourcePort}`);
    const targetPort =
      link.targetPort === undefined ? undefined : ports.get(`${target}:${link.targetPort}`);
    if (sourcePort?.dataType && targetPort?.dataType && sourcePort.dataType !== targetPort.dataType)
      fail(`${name} connects incompatible port types`);
    validateData(link.data, `${name}.data`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function exportDocument(document: NodeDocument): string {
  validateDocument(document);
  const persisted: PersistedNodeDocument = {
    schemaVersion: NODE_EDITOR_SCHEMA_VERSION,
    nodes: cloneJson(document.nodes),
    links: cloneJson(document.links),
  };
  return JSON.stringify(persisted);
}

export function importDocument(serialized: string): NodeDocument {
  if (typeof serialized !== 'string') fail('serialized document must be a string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail('serialized document must be valid JSON');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== NODE_EDITOR_SCHEMA_VERSION)
    fail(`unsupported schema version, expected ${NODE_EDITOR_SCHEMA_VERSION}`);
  validateDocument(parsed);
  return cloneJson({ nodes: parsed.nodes, links: parsed.links });
}

/** @deprecated Use exportDocument instead. */
export const serializeDocument = exportDocument;

/** @deprecated Use importDocument instead. */
export const deserializeDocument = importDocument;

export const nodeEditorPersistence: NodeEditorPersistence = {
  exportDocument,
  importDocument,
  serializeDocument,
  deserializeDocument,
};
