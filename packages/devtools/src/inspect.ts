import type { Bounds, DevtoolsDescriptor, Entity, LayoutControlledProperty } from '@vectojs/core';

/** Structured, JSON-safe entity report — the machine-readable sibling of `describeEntity`. */
export interface EntityInfo {
  id: string;
  type: string;
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  worldTransform: { a: number; b: number; c: number; d: number; e: number; f: number };
  worldBounds: Bounds;
  interactive: boolean;
  animating: boolean;
  clipChildren: boolean;
  childCount: number;
  /** Content preview (≤80 chars) for text-bearing entities (Text, RichText, Input…). */
  text?: string;
  /** Present only when the entity projects a semantic shadow node. */
  a11y?: { tag?: string; role?: string; label?: string };
  /**
   * The entity's own description of its debug surface, when it provides one.
   *
   * Everything above is a generic `Entity` property, so without this the
   * inspector cannot show what distinguishes one component from another —
   * `Input.value`, `ScrollView.scrollTop`, `VirtualList.visibleRange`. Entities
   * describe themselves so DevTools needs no table of component types, which
   * would gate every new component on a debug-tool change and would break under
   * minified builds where `constructor.name` is unreliable.
   */
  descriptor?: DevtoolsDescriptor;
  /**
   * Properties this entity's parent recomputes during layout.
   *
   * Editing one of these is silently reverted on the next layout pass, which looks
   * like the editor being broken rather than the value being owned elsewhere. The
   * parent declares them (`Entity.getLayoutControlledProperties`), so DevTools
   * needs no table of container types.
   */
  layoutControlled?: ReadonlyArray<LayoutControlledProperty>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const TEXT_PREVIEW_MAX = 80;

/**
 * Duck-typed text extraction: `.text` covers Text/RichText-likes, `.value`
 * covers Input/TextArea-likes. Constructor-name checks would break under
 * minified production bundles, so shape is the contract here.
 */
export function textPreviewOf(entity: Entity): string | undefined {
  const candidate =
    typeof (entity as unknown as { text?: unknown }).text === 'string'
      ? (entity as unknown as { text: string }).text
      : typeof (entity as unknown as { value?: unknown }).value === 'string'
        ? (entity as unknown as { value: string }).value
        : undefined;
  if (candidate === undefined) return undefined;
  return candidate.length > TEXT_PREVIEW_MAX
    ? `${candidate.slice(0, TEXT_PREVIEW_MAX)}…`
    : candidate;
}

/**
 * Human-readable ancestor chain, e.g. `Scene > Card#a1b2 > Text#c3d4`.
 * The tree top (parent === null) is the scene root container, shown as `Scene`.
 */
export function entityPath(entity: Entity): string {
  const segments: string[] = [];
  let node: Entity | null = entity;
  while (node) {
    segments.unshift(
      node.parent === null ? 'Scene' : `${node.constructor.name}#${node.id.slice(0, 8)}`,
    );
    node = node.parent;
  }
  return segments.join(' > ');
}

function roundBounds(b: Bounds): Bounds {
  return { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) };
}

/** Full structured report for one entity. All numbers rounded to 2 decimals. */
export function inspectEntity(entity: Entity): EntityInfo {
  const { a, b, c, d, e, f } = entity.getWorldTransform();
  const info: EntityInfo = {
    id: entity.id,
    type: entity.constructor.name,
    path: entityPath(entity),
    x: round2(entity.x),
    y: round2(entity.y),
    width: round2(entity.width),
    height: round2(entity.height),
    scaleX: round2(entity.scaleX),
    scaleY: round2(entity.scaleY),
    rotation: round2(entity.rotation),
    opacity: round2(entity.opacity),
    worldTransform: {
      a: round2(a),
      b: round2(b),
      c: round2(c),
      d: round2(d),
      e: round2(e),
      f: round2(f),
    },
    worldBounds: roundBounds(entity.getWorldBounds()),
    interactive: entity.interactive,
    animating: entity.hasPendingAnimations(),
    clipChildren: entity.clipChildren,
    childCount: entity.children.length,
  };
  const text = textPreviewOf(entity);
  if (text !== undefined) info.text = text;
  const a11y = entity.getA11yAttributes();
  if (a11y && (a11y.tag || a11y.role || a11y.label)) {
    info.a11y = { tag: a11y.tag, role: a11y.role, label: a11y.label };
  }
  // A descriptor is optional and app-supplied, so a throwing implementation must
  // not take the whole inspector down with it — a debug tool that crashes on the
  // entity you are trying to debug is worse than one missing a field.
  try {
    const descriptor = entity.getDevtoolsDescriptor?.();
    if (descriptor) info.descriptor = descriptor;
  } catch {
    /* ignore a broken descriptor */
  }
  const controlled = layoutControlledProperties(entity);
  if (controlled.length > 0) info.layoutControlled = controlled;
  return info;
}

/**
 * Which of `entity`'s own properties its parent recomputes during layout.
 *
 * Asks the parent, because only a container knows whether it writes `x`
 * unconditionally — and answering per child lets a container distinguish cases,
 * as `ScrollView` does between its internal content wrapper and the children a
 * caller adds inside it.
 *
 * Returns an empty array for a root entity or a parent that positions nothing.
 */
export function layoutControlledProperties(
  entity: Entity,
): ReadonlyArray<LayoutControlledProperty> {
  const parent = entity.parent;
  if (!parent) return [];
  try {
    return parent.getLayoutControlledProperties?.(entity) ?? [];
  } catch {
    // An app-supplied container must not break the inspector.
    return [];
  }
}
