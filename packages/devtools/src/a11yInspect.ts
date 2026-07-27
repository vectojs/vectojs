import type { Bounds, Entity, Scene } from '@vectojs/core';
import { entityPath, textPreviewOf } from './inspect';

/**
 * Accessibility inspector and audits.
 *
 * `inspectEntity()` exposes only `tag`/`role`/`label`, which is not enough to
 * answer the questions that matter about a zero-DOM UI: what name will a screen
 * reader announce, where does this land in reading order, and does the projected
 * DOM node agree with what is painted on the canvas. Divergence between those two
 * is the failure mode unique to this architecture — the canvas can look perfect
 * while the accessibility tree is wrong, and nothing in a normal browser DevTools
 * will show it.
 *
 * The audits target failure classes already observed in this codebase rather than
 * a generic checklist. Every one of them has been a real defect found by review or
 * by the e2e conformance suite (#212, #221, #229, #235, #237), which is why they
 * are worth running continuously.
 */

/** A11y audit categories. */
export type A11yAuditKind =
  /** Focusable and announced, but with no accessible name — the defect #212 found. */
  | 'no-accessible-name'
  /** `role` contradicts the projected `tag`, e.g. a `<button>` with `role="heading"`. */
  | 'role-tag-conflict'
  /** Painted as disabled but not projected as disabled, or the reverse. */
  | 'disabled-divergence'
  /** Reachable by keyboard while clipped out of view by an ancestor. */
  | 'focusable-but-clipped'
  /** Two focusable nodes announcing the same name, with nothing to tell them apart. */
  | 'duplicate-label';

export interface A11yFinding {
  kind: A11yAuditKind;
  entityId: string;
  entityPath: string;
  /** One-line human summary, phrased as the consequence rather than the rule. */
  message: string;
  /** The other node, for `duplicate-label`. */
  otherId?: string;
  otherPath?: string;
  /** The clipping ancestor, for `focusable-but-clipped`. */
  containerId?: string;
  containerPath?: string;
}

/** Full a11y readout for one entity. */
export interface A11yInfo {
  entityId: string;
  entityPath: string;
  /** Whether this entity projects a semantic node at all. */
  projected: boolean;
  tag?: string;
  role?: string;
  /**
   * The accessible name a screen reader would announce.
   *
   * Resolved in the same precedence the projection uses — explicit label, then
   * text content — so this is the announced string, not a guess at it.
   */
  accessibleName?: string;
  /** Where the name came from, so a missing name can be fixed at the right layer. */
  nameSource?: 'label' | 'text' | 'none';
  tabIndex?: number;
  disabled?: boolean;
  focused?: boolean;
  /**
   * Position in the flat reading order, 1-based, or `undefined` when not projected.
   *
   * The a11y projection is flat — every node is a sibling under the root and order
   * comes from sorting — so this is the only place reading order is observable.
   */
  readingOrder?: number;
  /** World-space bounds of the canvas-painted entity. */
  canvasBounds: Bounds;
  /**
   * Client-space bounds of the projected DOM node, when it is in the document.
   *
   * Present so it can be compared against `canvasBounds`: an assistive
   * technology's idea of where a control is comes from the DOM node, and if the
   * two disagree the focus ring lands somewhere the user is not looking.
   */
  domBounds?: Bounds;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function roundBounds(b: Bounds): Bounds {
  return {
    x: round2(b.x),
    y: round2(b.y),
    width: round2(b.width),
    height: round2(b.height),
  };
}

/**
 * Tags whose implicit role must not be contradicted by an explicit `role`.
 *
 * A `<button role="heading">` is announced as a heading and loses its activation
 * semantics, which is almost never the intent — it usually means a component set
 * `role` for styling reasons and did not realise the tag already carried one.
 */
const IMPLICIT_ROLES: Record<string, string> = {
  button: 'button',
  a: 'link',
  input: 'textbox',
  textarea: 'textbox',
  select: 'combobox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
};

/** Roles that are announced and therefore require a name to be usable. */
const NAME_REQUIRED_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
  'textbox',
  'combobox',
  'slider',
  'spinbutton',
]);

function domBoundsOf(scene: Scene, entity: Entity): Bounds | undefined {
  const el = scene.getA11yElement?.(entity.id);
  if (!el || typeof el.getBoundingClientRect !== 'function') return undefined;
  const rect = el.getBoundingClientRect();
  // jsdom returns an all-zero rect for everything, which would otherwise be
  // reported as a real divergence from the canvas.
  if (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0) return undefined;
  return roundBounds({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

/**
 * Resolve what a screen reader would announce for this entity.
 *
 * Mirrors the projection's own precedence rather than inventing one, so a reported
 * name is the announced name.
 */
function resolveName(entity: Entity): {
  name?: string;
  source: 'label' | 'text' | 'none';
} {
  const attrs = entity.getA11yAttributes();
  // Guard the type rather than trusting it. `A11yAttributes.label` is typed
  // `string`, but a component that forwards its whole options object by mistake
  // puts an object here, and the audit would then compare objects for duplicate
  // names and format one into a panel row. Found while writing these tests.
  if (typeof attrs?.label === 'string' && attrs.label.length > 0) {
    return { name: attrs.label, source: 'label' };
  }
  const text = textPreviewOf(entity);
  if (text) return { name: text, source: 'text' };
  return { source: 'none' };
}

/** Full accessibility readout for one entity. */
export function inspectA11y(scene: Scene, entity: Entity): A11yInfo {
  const attrs = entity.getA11yAttributes();
  const projected = !!(attrs && (attrs.tag || attrs.role || attrs.label || entity.interactive));
  const { name, source } = resolveName(entity);
  const el = scene.getA11yElement?.(entity.id);

  const info: A11yInfo = {
    entityId: entity.id,
    entityPath: entityPath(entity),
    projected,
    canvasBounds: roundBounds(entity.getWorldBounds()),
  };
  if (attrs?.tag) info.tag = attrs.tag;
  if (attrs?.role) info.role = attrs.role;
  if (name !== undefined) info.accessibleName = name;
  info.nameSource = source;
  if (attrs?.tabIndex !== undefined) info.tabIndex = attrs.tabIndex;
  if (attrs?.disabled !== undefined) info.disabled = attrs.disabled;
  if (el) {
    info.focused = el.ownerDocument?.activeElement === el;
    const dom = domBoundsOf(scene, entity);
    if (dom) info.domBounds = dom;
    // Reading order comes from the node's index among its siblings, because the
    // projection is flat and ordering is done by sorting rather than nesting.
    const parent = el.parentElement;
    if (parent) {
      const index = [...parent.children].indexOf(el);
      if (index >= 0) info.readingOrder = index + 1;
    }
  }
  return info;
}

/** Whether an entity is reachable by keyboard. */
function isFocusable(entity: Entity): boolean {
  const attrs = entity.getA11yAttributes();
  if (attrs?.disabled) return false;
  if (attrs?.tabIndex !== undefined) return attrs.tabIndex >= 0;
  return entity.interactive;
}

function intersects(a: Bounds, b: Bounds, tolerance: number): boolean {
  return !(
    a.x + a.width <= b.x + tolerance ||
    b.x + b.width <= a.x + tolerance ||
    a.y + a.height <= b.y + tolerance ||
    b.y + b.height <= a.y + tolerance
  );
}

export interface A11yAuditOptions {
  /** Include the overlay tree. Default true — modals own focus and must be audited. */
  includeOverlay?: boolean;
  /** Pixel slack for the clipped check. Default 0.5. */
  tolerance?: number;
  /** Audit kinds to skip. */
  skip?: ReadonlyArray<A11yAuditKind>;
}

/**
 * Run the accessibility audits over a scene.
 *
 * Cheap enough to call per interaction in a dev build: one tree walk plus a map of
 * names for the duplicate check.
 */
export function auditA11y(scene: Scene, opts: A11yAuditOptions = {}): A11yFinding[] {
  const tolerance = opts.tolerance ?? 0.5;
  const skip = new Set(opts.skip ?? []);
  const findings: A11yFinding[] = [];
  /** Focusable nodes by accessible name, for the duplicate check. */
  const byName = new Map<string, Entity[]>();

  const walk = (entity: Entity, clippers: Entity[]): void => {
    // A hidden subtree does not project, so auditing it would report defects a
    // user can never encounter.
    if (entity.a11yHidden) return;

    const attrs = entity.getA11yAttributes();
    const focusable = isFocusable(entity);
    const { name } = resolveName(entity);
    const role = attrs?.role ?? (attrs?.tag ? IMPLICIT_ROLES[attrs.tag.toLowerCase()] : undefined);

    if (!skip.has('no-accessible-name') && focusable && !name) {
      const announced = role && NAME_REQUIRED_ROLES.has(role);
      // Interactive with no name is reported even without a name-requiring role:
      // a screen reader announces the role alone ("button") and the user has no
      // way to know what it does.
      if (announced || entity.interactive) {
        findings.push({
          kind: 'no-accessible-name',
          entityId: entity.id,
          entityPath: entityPath(entity),
          message: `Focusable ${role ?? 'element'} has no accessible name; a screen reader announces only its role.`,
        });
      }
    }

    if (!skip.has('role-tag-conflict') && attrs?.tag && attrs.role) {
      const implicit = IMPLICIT_ROLES[attrs.tag.toLowerCase()];
      if (implicit && implicit !== attrs.role) {
        findings.push({
          kind: 'role-tag-conflict',
          entityId: entity.id,
          entityPath: entityPath(entity),
          message: `<${attrs.tag}> already means role="${implicit}", but role="${attrs.role}" overrides it; the element loses its ${implicit} semantics.`,
        });
      }
    }

    if (!skip.has('disabled-divergence')) {
      // Visual disabled state is conventionally expressed by dimming. If an
      // entity is painted dim but still projects as enabled, a screen-reader user
      // is invited to activate a control a sighted user can see is unavailable.
      const looksDisabled = entity.opacity > 0 && entity.opacity <= 0.6;
      const saysDisabled = attrs?.disabled === true;
      if (looksDisabled && !saysDisabled && focusable) {
        findings.push({
          kind: 'disabled-divergence',
          entityId: entity.id,
          entityPath: entityPath(entity),
          message: `Painted at opacity ${round2(entity.opacity)} (reads as disabled) but projected as enabled, so assistive tech offers a control that looks unavailable.`,
        });
      } else if (saysDisabled && entity.opacity > 0.9) {
        findings.push({
          kind: 'disabled-divergence',
          entityId: entity.id,
          entityPath: entityPath(entity),
          message: `Projected as disabled but painted fully opaque, so a sighted user sees an available control that assistive tech reports as unavailable.`,
        });
      }
    }

    if (!skip.has('focusable-but-clipped') && focusable && clippers.length > 0) {
      const own = entity.getWorldBounds();
      for (const clipper of clippers) {
        if (!intersects(own, clipper.getWorldBounds(), tolerance)) {
          findings.push({
            kind: 'focusable-but-clipped',
            entityId: entity.id,
            entityPath: entityPath(entity),
            containerId: clipper.id,
            containerPath: entityPath(clipper),
            message: `Keyboard-reachable but clipped entirely out of view by ${clipper.constructor.name}; Tab moves focus somewhere invisible.`,
          });
          break;
        }
      }
    }

    if (!skip.has('duplicate-label') && focusable && name) {
      const bucket = byName.get(name);
      if (bucket) bucket.push(entity);
      else byName.set(name, [entity]);
    }

    const nextClippers = entity.clipChildren ? [...clippers, entity] : clippers;
    for (const child of entity.children) walk(child, nextClippers);
  };

  walk(scene.rootEntity, []);
  if (opts.includeOverlay !== false) walk(scene.overlayRootEntity, []);

  if (!skip.has('duplicate-label')) {
    for (const [name, entities] of byName) {
      if (entities.length < 2) continue;
      // Report against the second onward: the first is the one to keep, and
      // flagging all N would make an N-row list produce N findings.
      for (let i = 1; i < entities.length; i++) {
        findings.push({
          kind: 'duplicate-label',
          entityId: entities[i]!.id,
          entityPath: entityPath(entities[i]!),
          otherId: entities[0]!.id,
          otherPath: entityPath(entities[0]!),
          message: `Accessible name "${name}" is shared with ${entities.length - 1} other focusable node(s); a screen-reader user cannot tell them apart.`,
        });
      }
    }
  }

  return findings;
}

/** Reading order as a flat list, in the order assistive tech traverses it. */
export function a11yReadingOrder(scene: Scene): A11yInfo[] {
  const infos: A11yInfo[] = [];
  const walk = (entity: Entity): void => {
    if (entity.a11yHidden) return;
    const info = inspectA11y(scene, entity);
    if (info.projected) infos.push(info);
    for (const child of entity.children) walk(child);
  };
  walk(scene.rootEntity);
  walk(scene.overlayRootEntity);
  // Sort by the projection's own order where known; unprojected-but-interactive
  // entities have no index and keep tree order at the end.
  return infos.sort((a, b) => (a.readingOrder ?? 1e9) - (b.readingOrder ?? 1e9));
}
