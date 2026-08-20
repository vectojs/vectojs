import type { NodeDocument } from './model';

export interface AutoLayoutOptions {
  originX?: number;
  originY?: number;
  horizontalGap?: number;
  verticalGap?: number;
}

const DEFAULT_HORIZONTAL_GAP = 260;
const DEFAULT_VERTICAL_GAP = 120;

/** Lay out nodes in deterministic source-to-target layers without mutating the document. */
export function layoutDocument(
  document: NodeDocument,
  options: AutoLayoutOptions = {},
): NodeDocument {
  const nodes = [...document.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const link of document.links) {
    if (nodeIds.has(link.source) && nodeIds.has(link.target)) {
      adjacency.get(link.source)?.push(link.target);
    }
  }
  for (const targets of adjacency.values()) targets.sort((a, b) => a.localeCompare(b));

  const components = stronglyConnectedComponents(
    nodes.map((node) => node.id),
    adjacency,
  );
  const componentOf = new Map<string, number>();
  components.forEach((component, index) => {
    for (const id of component) componentOf.set(id, index);
  });
  const componentEdges = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  for (const [source, targets] of adjacency) {
    const sourceComponent = componentOf.get(source)!;
    for (const target of targets) {
      const targetComponent = componentOf.get(target)!;
      if (
        sourceComponent === targetComponent ||
        componentEdges[sourceComponent].has(targetComponent)
      ) {
        continue;
      }
      componentEdges[sourceComponent].add(targetComponent);
      indegree[targetComponent]++;
    }
  }

  const ranks = components.map(() => 0);
  const queue = components
    .map((component, index) => ({ id: component[0], index }))
    .filter(({ index }) => indegree[index] === 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor].index;
    const targets = [...componentEdges[current]].sort((a, b) =>
      components[a][0].localeCompare(components[b][0]),
    );
    for (const target of targets) {
      ranks[target] = Math.max(ranks[target], ranks[current] + 1);
      indegree[target]--;
      if (indegree[target] === 0) queue.push({ id: components[target][0], index: target });
    }
  }

  const layers = new Map<number, string[]>();
  for (const node of nodes) {
    const rank = ranks[componentOf.get(node.id)!];
    const layer = layers.get(rank) ?? [];
    layer.push(node.id);
    layers.set(rank, layer);
  }
  const horizontalGap = options.horizontalGap ?? DEFAULT_HORIZONTAL_GAP;
  const verticalGap = options.verticalGap ?? DEFAULT_VERTICAL_GAP;
  const originX = options.originX ?? 0;
  const originY = options.originY ?? 0;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [rank, ids] of [...layers.entries()].sort(([a], [b]) => a - b)) {
    ids.sort((a, b) => a.localeCompare(b));
    ids.forEach((id, index) => {
      positions.set(id, { x: originX + rank * horizontalGap, y: originY + index * verticalGap });
    });
  }

  return {
    nodes: document.nodes.map((node) => ({ ...node, position: positions.get(node.id)! })),
    links: document.links,
  };
}

function stronglyConnectedComponents(ids: string[], adjacency: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];

  const visit = (id: string): void => {
    indices.set(id, index);
    lowLinks.set(id, index++);
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    component.sort((a, b) => a.localeCompare(b));
    result.push(component);
  };

  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) if (!indices.has(id)) visit(id);
  result.sort((a, b) => a[0].localeCompare(b[0]));
  return result;
}
