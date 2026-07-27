import type { DevtoolsDescriptor, DevtoolsField } from '@vectojs/core';
import type { Entity, Scene } from '@vectojs/core';
/** Framework-neutral tree shape used by inspectors and serialized tooling. */
export interface DevtoolsTreeNode {
  id: string;
  label: string;
  children?: DevtoolsTreeNode[];
}

/**
 * Build an inspector tree for a scene graph and an id→entity index for
 * resolving selections back to live entities. Labels carry the entity's type
 * and geometry so most questions are answered without selecting anything.
 */
export function buildTreeModel(root: Entity): {
  nodes: DevtoolsTreeNode[];
  index: Map<string, Entity>;
} {
  const index = new Map<string, Entity>();
  const toNode = (entity: Entity): DevtoolsTreeNode => {
    index.set(entity.id, entity);
    const type = entity.constructor.name;
    const size =
      entity.width > 0 || entity.height > 0
        ? ` ${Math.round(entity.width)}×${Math.round(entity.height)}`
        : '';
    const badges = `${entity.interactive ? ' ⚡' : ''}${entity.hasPendingAnimations() ? ' ▶' : ''}`;
    return {
      id: entity.id,
      label: `${type} (${Math.round(entity.x)},${Math.round(entity.y)})${size}${badges}`,
      children: entity.children.length > 0 ? entity.children.map(toNode) : undefined,
    };
  };
  return { nodes: root.children.map(toNode), index };
}

/**
 * Deepest-first hit test in scene coordinates — the same walk order the Scene
 * uses for input, so the inspector picks exactly what a click would hit.
 * Falls back to the world-AABB when the entity's own `isPointInside` declines,
 * so non-interactive (decorative) entities are still pickable.
 */
export function findEntityAt(root: Entity, x: number, y: number): Entity | null {
  for (let i = root.children.length - 1; i >= 0; i--) {
    const hit = findEntityAt(root.children[i], x, y);
    if (hit) return hit;
  }
  if (root.isPointInside && root.isPointInside(x, y)) return root;
  if (root.width > 0 && root.height > 0) {
    const local = root.worldToLocal(x, y);
    if (local && local.x >= 0 && local.x <= root.width && local.y >= 0 && local.y <= root.height) {
      return root;
    }
  }
  return null;
}

/** Human-readable state lines for the detail readout. */
/** Compact one-line rendering of a descriptor field value. */
function formatFieldValue(value: DevtoolsField['value']): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
  }
  if (typeof value === 'string') {
    // Values land in a fixed-width panel row, so a long string has to be cut
    // somewhere; cutting here beats letting it push the layout around.
    return value.length > 32 ? `${value.slice(0, 32)}…` : value;
  }
  return String(value);
}

/** How many panel rows a descriptor may occupy. */
const DESCRIPTOR_LINE_BUDGET = 12;

export function describeEntity(entity: Entity): string[] {
  const { a, b, c, d, e, f } = entity.getWorldTransform();
  const r = (n: number) => Math.round(n * 100) / 100;
  const lines = [
    `${entity.constructor.name} #${entity.id}`,
    `x ${r(entity.x)}  y ${r(entity.y)}  w ${r(entity.width)}  h ${r(entity.height)}`,
    `scale ${r(entity.scaleX)},${r(entity.scaleY)}  rot ${r(entity.rotation)}  op ${r(entity.opacity)}`,
    `world [${r(a)} ${r(b)} ${r(c)} ${r(d)} ${r(e)} ${r(f)}]`,
    `interactive ${entity.interactive}  animating ${entity.hasPendingAnimations()}`,
    `children ${entity.children.length}`,
  ];

  // Append the entity's own description of its debug surface, when it has one.
  // Everything above is a generic Entity property, so this is the only part that
  // can say anything about what the component actually is.
  //
  // Wrapped because the descriptor is app-supplied: a component with a throwing
  // getter must not break the inspector for the entity you are debugging.
  let descriptor: DevtoolsDescriptor | null = null;
  try {
    descriptor = entity.getDevtoolsDescriptor?.() ?? null;
  } catch {
    lines.push('— descriptor threw —');
  }
  if (descriptor) {
    let budget = DESCRIPTOR_LINE_BUDGET;
    lines.push(`— ${descriptor.kind} —`);
    for (const group of descriptor.groups) {
      if (budget <= 0) break;
      lines.push(`${group.label}:`);
      budget--;
      for (const field of group.fields) {
        if (budget <= 0) break;
        // A read-only marker is worth a character: it tells the reader an edit
        // here will be reverted rather than leaving them to discover it.
        const lock = field.readOnly ? ' \u00b7' : ' ';
        lines.push(`  ${field.label}${lock} ${formatFieldValue(field.value)}`);
        budget--;
      }
    }
    for (const note of descriptor.notes ?? []) {
      if (budget <= 0) break;
      lines.push(`! ${note.length > 60 ? `${note.slice(0, 60)}…` : note}`);
      budget--;
    }
  }
  return lines;
}

/** Resolve which scene root (main or overlay) owns the picked point first. */
export function pickInScene(scene: Scene, sceneX: number, sceneY: number): Entity | null {
  return (
    findEntityAt(scene.overlayRootEntity, sceneX, sceneY) ??
    findEntityAt(scene.rootEntity, sceneX, sceneY)
  );
}
