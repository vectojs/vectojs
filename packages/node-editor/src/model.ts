export interface NodePosition {
  x: number;
  y: number;
}

export interface NodeData {
  id: string;
  type: string;
  title: string;
  position: NodePosition;
  width?: number;
  height?: number;
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
