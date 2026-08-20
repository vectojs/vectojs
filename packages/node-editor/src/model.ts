export interface NodePosition {
  x: number;
  y: number;
}

export type PortDirection = 'input' | 'output';

export interface PortDefinition {
  id: string;
  label?: string;
  direction: PortDirection;
  dataType?: string;
  maxConnections?: number;
}

export interface NodeData {
  id: string;
  type: string;
  title: string;
  position: NodePosition;
  width?: number;
  height?: number;
  ports?: readonly PortDefinition[];
  data?: Readonly<Record<string, unknown>>;
}

export interface LinkData {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
  data?: Readonly<Record<string, unknown>>;
}

export type LinkValidationError =
  | 'missing-source-node'
  | 'missing-target-node'
  | 'missing-source-port'
  | 'missing-target-port'
  | 'source-port-direction'
  | 'target-port-direction'
  | 'same-node'
  | 'incompatible-types'
  | 'duplicate-link'
  | 'target-port-occupied';

export interface LinkValidation {
  valid: boolean;
  error?: LinkValidationError;
}

export interface NodeDocument {
  nodes: readonly NodeData[];
  links: readonly LinkData[];
}

export function createDocument(document: NodeDocument = { nodes: [], links: [] }): NodeDocument {
  return cloneDocument(document);
}

export function cloneDocument(document: NodeDocument): NodeDocument {
  return {
    nodes: document.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      ports: node.ports?.map((port) => ({ ...port })),
      data: node.data ? { ...node.data } : undefined,
    })),
    links: document.links.map((link) => ({
      ...link,
      data: link.data ? { ...link.data } : undefined,
    })),
  };
}

export function updateNodePosition(
  document: NodeDocument,
  id: string,
  position: NodePosition,
): NodeDocument {
  return {
    nodes: document.nodes.map((node) =>
      node.id === id ? { ...node, position: { ...position } } : node,
    ),
    links: document.links,
  };
}

export function getNode(document: NodeDocument, id: string): NodeData | undefined {
  return document.nodes.find((node) => node.id === id);
}

export function getPort(
  node: NodeData | undefined,
  id: string | undefined,
): PortDefinition | undefined {
  return id ? node?.ports?.find((port) => port.id === id) : undefined;
}

export function validateLink(document: NodeDocument, link: LinkData): LinkValidation {
  const source = getNode(document, link.source);
  const target = getNode(document, link.target);
  if (!source) return { valid: false, error: 'missing-source-node' };
  if (!target) return { valid: false, error: 'missing-target-node' };
  if (source.id === target.id) return { valid: false, error: 'same-node' };
  const sourcePort = getPort(source, link.sourcePort);
  const targetPort = getPort(target, link.targetPort);
  if (!sourcePort) return { valid: false, error: 'missing-source-port' };
  if (!targetPort) return { valid: false, error: 'missing-target-port' };
  if (sourcePort.direction !== 'output') return { valid: false, error: 'source-port-direction' };
  if (targetPort.direction !== 'input') return { valid: false, error: 'target-port-direction' };
  if (sourcePort.dataType && targetPort.dataType && sourcePort.dataType !== targetPort.dataType)
    return { valid: false, error: 'incompatible-types' };
  if (
    document.links.some(
      (existing) =>
        existing.source === link.source &&
        existing.sourcePort === link.sourcePort &&
        existing.target === link.target &&
        existing.targetPort === link.targetPort,
    )
  )
    return { valid: false, error: 'duplicate-link' };
  const maxConnections = targetPort.maxConnections ?? 1;
  if (
    maxConnections >= 0 &&
    document.links.filter(
      (existing) => existing.target === link.target && existing.targetPort === link.targetPort,
    ).length >= maxConnections
  )
    return { valid: false, error: 'target-port-occupied' };
  return { valid: true };
}

export function addLink(document: NodeDocument, link: LinkData): NodeDocument {
  const validation = validateLink(document, link);
  if (!validation.valid) throw new Error(`Invalid link: ${validation.error}`);
  return { nodes: document.nodes, links: [...document.links, { ...link }] };
}

export function removeLink(document: NodeDocument, id: string): NodeDocument {
  return { nodes: document.nodes, links: document.links.filter((link) => link.id !== id) };
}
