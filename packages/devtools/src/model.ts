import type { DevtoolsDescriptor, DevtoolsField, LayoutControlledProperty } from '@vectojs/core';
import type { Entity, Scene } from '@vectojs/core';
import { layoutControlledProperties } from './inspect';
/** Framework-neutral tree shape used by inspectors and serialized tooling. */
export interface DevtoolsTreeNode {
  id: string;
  label: string;
  children?: DevtoolsTreeNode[];
}

/**
 * The geometry-bearing label for an entity: `Type (x,y) WxH ⚡▶`. Shared by
 * {@link buildTreeModel}, which bakes it in at build time, and
 * {@link refreshTreeLabels}, which rewrites it in place per tick.
 */
function geometryLabel(entity: Entity): string {
  const type = entity.constructor.name;
  const size =
    entity.width > 0 || entity.height > 0
      ? ` ${Math.round(entity.width)}×${Math.round(entity.height)}`
      : '';
  const badges = `${entity.interactive ? ' ⚡' : ''}${entity.hasPendingAnimations() ? ' ▶' : ''}`;
  return `${type} (${Math.round(entity.x)},${Math.round(entity.y)})${size}${badges}`;
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
    return {
      id: entity.id,
      label: geometryLabel(entity),
      children: entity.children.length > 0 ? entity.children.map(toNode) : undefined,
    };
  };
  return { nodes: root.children.map(toNode), index };
}

/**
 * Rewrite the geometry baked into an existing tree model's labels, in place —
 * no node or index churn. `buildTreeModel` embeds `(x,y) WxH` precisely so
 * geometry is readable without selecting, but transforms never bump the
 * scene's structure version, so a purely version-gated refresh showed the
 * coordinates of the last structural change until the periodic forced
 * reconcile (#706). Returns true when at least one label changed, so callers
 * can skip redraw work when nothing moved.
 */
export function refreshTreeLabels(nodes: DevtoolsTreeNode[], index: Map<string, Entity>): boolean {
  let changed = false;
  const walk = (node: DevtoolsTreeNode): void => {
    const entity = index.get(node.id);
    if (entity) {
      const label = geometryLabel(entity);
      if (label !== node.label) {
        node.label = label;
        changed = true;
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of nodes) walk(node);
  return changed;
}

/**
 * Deepest-first hit test in scene coordinates — the same walk order AND the
 * same acceptance predicate the Scene uses for input (`HitTester.findHitRecursively`),
 * so the inspector picks exactly what a click would hit. An entity is a hit
 * target only when its own `isPointInside` accepts the point: there is
 * deliberately no world-AABB fallback, which used to report false owners for
 * particles (`pointerEvents: false`) and any shape declining a point inside
 * its box while `explainHitTest` correctly reported "outside shape" (#671).
 */
export function findEntityAt(root: Entity, x: number, y: number): Entity | null {
  // The engine's visibility gate (HitTester.findHitRecursively): an invisible
  // subtree is not drawn, so nothing in it is hittable — opacity accumulates
  // down the tree, so checking it here on entry covers every ancestor too.
  if (root.opacity <= 0) return null;
  for (let i = root.children.length - 1; i >= 0; i--) {
    const hit = findEntityAt(root.children[i], x, y);
    if (hit) return hit;
  }
  if (isPointerTransparent(root)) return null;
  if (!insideClipAncestors(root, x, y)) return null;
  // An entity without `isPointInside` is not a hit target in production either
  // (`node.isPointInside && …`); its children are still walked above.
  if (root.isPointInside && root.isPointInside(x, y)) return root;
  return null;
}

/**
 * Whether the entity opts out of being a pointer hit target: a disabled control
 * or an explicit `pointerEvents: 'none'` in its a11y attributes. Mirrors
 * `HitTester.isPointerTransparent`, whose children are still walked (a
 * transparent container can hold hittable descendants).
 */
function isPointerTransparent(entity: Entity): boolean {
  const attrs = entity.getA11yAttributes();
  return attrs.disabled === true || attrs.pointerEvents === 'none';
}

/**
 * Whether the point lies inside every `clipChildren` ancestor's world box, the
 * same ancestor check the engine's `HitTester.isHitEligible` applies, so a
 * scrolled-out or clipped-away node is not pickable.
 */
function insideClipAncestors(entity: Entity, x: number, y: number): boolean {
  for (let ancestor = entity.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.clipChildren && ancestor.width > 0 && ancestor.height > 0) {
      const local = ancestor.worldToLocal(x, y);
      if (
        !local ||
        local.x < 0 ||
        local.y < 0 ||
        local.x > ancestor.width ||
        local.y > ancestor.height
      ) {
        return false;
      }
    }
  }
  return true;
}

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
  // Mark parent-owned geometry inline. Without this, editing `x` on a
  // Stack-laid-out child looks like the editor silently failing rather than the
  // value being computed elsewhere.
  const controlled = layoutControlledProperties(entity);
  const owner = entity.parent?.constructor.name;
  const mark = (prop: LayoutControlledProperty): string => (controlled.includes(prop) ? '*' : '');

  const lines = [
    `${entity.constructor.name} #${entity.id}`,
    `x${mark('x')} ${r(entity.x)}  y${mark('y')} ${r(entity.y)}  w${mark('width')} ${r(entity.width)}  h${mark('height')} ${r(entity.height)}`,
    `scale ${r(entity.scaleX)},${r(entity.scaleY)}  rot ${r(entity.rotation)}  op ${r(entity.opacity)}`,
    `world [${r(a)} ${r(b)} ${r(c)} ${r(d)} ${r(e)} ${r(f)}]`,
    `interactive ${entity.interactive}  animating ${entity.hasPendingAnimations()}`,
    `children ${entity.children.length}`,
  ];

  if (controlled.length > 0) {
    lines.push(`* ${controlled.join('/')} set by ${owner ?? 'parent'} layout — edits revert`);
  }

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
