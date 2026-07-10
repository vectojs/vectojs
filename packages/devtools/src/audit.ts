import type { Bounds, Entity, Scene } from '@vectojs/core';
import { entityPath, textPreviewOf } from './inspect';

export type AuditKind = 'text-overflow' | 'clip-overflow' | 'overlap' | 'viewport-overflow';

export interface AuditFinding {
  kind: AuditKind;
  entityId: string;
  entityPath: string;
  worldBounds: Bounds;
  /** One-line human summary of the defect. */
  message: string;
  // Overflow kinds:
  containerId?: string;
  containerPath?: string;
  containerBounds?: Bounds;
  /** Pixels escaping past each container edge (≥0). */
  overflow?: { left: number; right: number; top: number; bottom: number };
  // Overlap kind:
  otherId?: string;
  otherPath?: string;
  otherBounds?: Bounds;
  intersection?: Bounds;
}

export interface AuditOptions {
  /** Escapes/overlaps of at most this many px are ignored. Default 0.5. */
  tolerance?: number;
  /**
   * Audit the overlay tree too. Default false — overlay content (modals,
   * dropdowns, selection highlights) is intentionally out-of-flow.
   */
  includeOverlay?: boolean;
  /**
   * Clipping ancestors whose constructor name is listed here scroll their
   * content: vertical escape past them is normal and not reported (horizontal
   * escape still is). Matches by `constructor.name`, so minified production
   * bundles need explicit names passed in. Default covers the @vectojs/ui set.
   */
  scrollableTypes?: string[];
  /** Prune whole subtrees from the audit. */
  ignore?: (entity: Entity) => boolean;
  /** Suppress a specific sibling-overlap pair (intentional stacking). */
  ignoreOverlap?: (a: Entity, b: Entity) => boolean;
}

const DEFAULT_SCROLLABLE = ['ScrollView', 'VirtualList', 'TreeView', 'Tree'];

const round2 = (n: number): number => Math.round(n * 100) / 100;

function roundBounds(b: Bounds): Bounds {
  return { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) };
}

/**
 * World-space AABB of an entity's own `[0,0,width,height]` box. Deliberately
 * NOT `getWorldBounds()`: that uses `getBounds()`, which components may
 * override to their *render* extents — for containment/clipping questions the
 * declared box is the contract.
 */
function worldBox(entity: Entity): Bounds {
  const { a, b, c, d, e, f } = entity.getWorldTransform();
  const xs = [
    e,
    a * entity.width + e,
    c * entity.height + e,
    a * entity.width + c * entity.height + e,
  ];
  const ys = [
    f,
    b * entity.width + f,
    d * entity.height + f,
    b * entity.width + d * entity.height + f,
  ];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

function escapes(
  inner: Bounds,
  outer: Bounds,
): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.max(0, outer.x - inner.x),
    right: Math.max(0, inner.x + inner.width - (outer.x + outer.width)),
    top: Math.max(0, outer.y - inner.y),
    bottom: Math.max(0, inner.y + inner.height - (outer.y + outer.height)),
  };
}

function intersect(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

const isTextLike = (entity: Entity): boolean => textPreviewOf(entity) !== undefined;

interface Ancestor {
  entity: Entity;
  box: Bounds;
  clips: boolean;
  scrollable: boolean;
  sized: boolean;
  textLike: boolean;
}

/**
 * Audit one entity tree. Exported for tests and partial audits; most callers
 * want {@link auditScene}.
 */
export function auditTree(
  root: Entity,
  sceneBounds: Bounds | null,
  opts: AuditOptions = {},
): AuditFinding[] {
  const tolerance = opts.tolerance ?? 0.5;
  const scrollable = new Set(opts.scrollableTypes ?? DEFAULT_SCROLLABLE);
  const findings: AuditFinding[] = [];

  const overflowFinding = (
    kind: AuditKind,
    entity: Entity,
    bounds: Bounds,
    container: Ancestor | null,
    over: { left: number; right: number; top: number; bottom: number },
  ): void => {
    const sides = (['left', 'right', 'top', 'bottom'] as const)
      .filter((s) => over[s] > tolerance)
      .map((s) => `${s} ${round2(over[s])}px`)
      .join(', ');
    findings.push({
      kind,
      entityId: entity.id,
      entityPath: entityPath(entity),
      worldBounds: roundBounds(bounds),
      message: `${entity.constructor.name} escapes ${
        container ? container.entity.constructor.name : 'scene viewport'
      } by ${sides}`,
      ...(container
        ? {
            containerId: container.entity.id,
            containerPath: entityPath(container.entity),
            containerBounds: roundBounds(container.box),
          }
        : {}),
      overflow: {
        left: round2(over.left),
        right: round2(over.right),
        top: round2(over.top),
        bottom: round2(over.bottom),
      },
    });
  };

  const beyond = (over: { left: number; right: number; top: number; bottom: number }): boolean =>
    over.left > tolerance ||
    over.right > tolerance ||
    over.top > tolerance ||
    over.bottom > tolerance;

  // overlap: pairwise among sized, visible siblings — parent-child
  // containment is normal, cross-branch stacking belongs to the overlay.
  const checkSiblingOverlaps = (kids: Entity[]): void => {
    for (let i = 0; i < kids.length; i++) {
      const a = kids[i];
      if (a.opacity <= 0 || a.width <= 0 || a.height <= 0 || opts.ignore?.(a)) continue;
      const boxA = worldBox(a);
      for (let j = i + 1; j < kids.length; j++) {
        const b = kids[j];
        if (b.opacity <= 0 || b.width <= 0 || b.height <= 0 || opts.ignore?.(b)) continue;
        if (opts.ignoreOverlap?.(a, b)) continue;
        const inter = intersect(boxA, worldBox(b));
        if (inter && inter.width > tolerance && inter.height > tolerance) {
          findings.push({
            kind: 'overlap',
            entityId: a.id,
            entityPath: entityPath(a),
            worldBounds: roundBounds(boxA),
            otherId: b.id,
            otherPath: entityPath(b),
            otherBounds: roundBounds(worldBox(b)),
            intersection: roundBounds(inter),
            message: `${a.constructor.name} overlaps sibling ${b.constructor.name} by ${round2(inter.width)}×${round2(inter.height)}px`,
          });
        }
      }
    }
  };

  const walk = (entity: Entity, ancestors: Ancestor[]): void => {
    if (opts.ignore?.(entity)) return;
    if (entity.opacity <= 0) return;

    const bounds = entity.getWorldBounds();
    const hasSize = entity.width > 0 && entity.height > 0;

    if (hasSize) {
      // text-overflow: measured text box vs nearest sized, non-text ancestor.
      // ui Text writes its measured content size into width/height, so its own
      // box IS the content extent — escaping the intended container is exactly
      // "the text doesn't fit".
      if (isTextLike(entity)) {
        const container = [...ancestors].reverse().find((an) => an.sized && !an.textLike);
        if (container) {
          const over = escapes(bounds, container.box);
          if (container.scrollable) over.top = over.bottom = 0;
          if (beyond(over)) overflowFinding('text-overflow', entity, bounds, container, over);
        }
      }

      // clip-overflow: escaping the nearest clipping ancestor means pixels are
      // being visually cut off (scrollables exempt the scroll axis).
      const clipper = [...ancestors].reverse().find((an) => an.clips);
      if (clipper) {
        const over = escapes(bounds, clipper.box);
        if (clipper.scrollable) over.top = over.bottom = 0;
        if (beyond(over)) overflowFinding('clip-overflow', entity, bounds, clipper, over);
      } else if (sceneBounds && ancestors.every((an) => !an.sized)) {
        // viewport-overflow: nothing sized between this entity and the scene
        // root, so the canvas itself is the container.
        const over = escapes(bounds, sceneBounds);
        if (beyond(over)) overflowFinding('viewport-overflow', entity, bounds, null, over);
      }
    }

    checkSiblingOverlaps(entity.children);

    const self: Ancestor = {
      entity,
      box: worldBox(entity),
      clips: entity.clipChildren,
      scrollable: entity.clipChildren && scrollable.has(entity.constructor.name),
      sized: hasSize,
      textLike: isTextLike(entity),
    };
    ancestors.push(self);
    for (const child of entity.children) walk(child, ancestors);
    ancestors.pop();
  };

  checkSiblingOverlaps(root.children);
  for (const child of root.children) walk(child, []);

  findings.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind.localeCompare(b.kind)
      : a.entityPath !== b.entityPath
        ? a.entityPath.localeCompare(b.entityPath)
        : (a.otherPath ?? '').localeCompare(b.otherPath ?? ''),
  );
  return findings;
}

/**
 * Run the layout audit over a scene: text overflowing its container, content
 * escaping a clipping box, unexpected sibling overlap, and drawing outside
 * the canvas. Returns structured, JSON-safe, deterministically-sorted
 * findings — an empty array is the "audit clean" signal for CI gates.
 */
export function auditScene(scene: Scene, opts: AuditOptions = {}): AuditFinding[] {
  const sceneBounds: Bounds = { x: 0, y: 0, width: scene.width, height: scene.height };
  const findings = auditTree(scene.rootEntity, sceneBounds, opts);
  if (opts.includeOverlay) {
    findings.push(...auditTree(scene.overlayRootEntity, sceneBounds, opts));
  }
  return findings;
}
