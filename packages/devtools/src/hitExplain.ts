import type { Bounds, Entity, Scene } from '@vectojs/core';
import { entityPath } from './inspect';

/**
 * Explain a hit test.
 *
 * Picking returns the entity that received a pointer event but never why, and the
 * two failure modes that actually cost time — an invisible overlay swallowing
 * clicks, and a control clipped out of its scroll container — look identical from
 * the outside: the click lands somewhere unexpected, or nowhere.
 *
 * This walks the tree in the same order and applies the same gates as
 * `Scene.findHitRecursively`, recording a verdict per candidate instead of
 * returning on the first hit. The reasons mirror the engine's own rejection
 * conditions rather than approximating them, so an explanation that says "rejected
 * for opacity" is the reason the engine rejected it.
 */

/** Why one candidate was accepted or rejected. */
export type HitVerdict =
  /** Accepted: this is the entity the engine returns. */
  | 'accepted'
  /** `opacity <= 0`: not drawn, so not hittable, and its subtree is skipped too. */
  | 'invisible'
  /** Point is outside a `clipChildren` ancestor's world box. */
  | 'clipped'
  /** `disabled` or `pointerEvents: 'none'` in a11y attributes; children still walked. */
  | 'pointer-transparent'
  /** Point is outside the entity's own shape. */
  | 'outside-shape'
  /** Geometrically hit and eligible, but a sibling drawn later won first. */
  | 'occluded';

export interface HitCandidate {
  entityId: string;
  entityPath: string;
  /** Constructor name, for reading the chain at a glance. */
  type: string;
  verdict: HitVerdict;
  /** Human-readable one-liner naming the consequence, not the rule. */
  reason: string;
  /** Depth in the tree, so the chain can be rendered as an indented walk. */
  depth: number;
  /** World bounds, for cross-checking against the queried point. */
  worldBounds: Bounds;
  /** The clipping ancestor that excluded the point, for `clipped`. */
  clipperId?: string;
  clipperPath?: string;
}

export interface HitExplanation {
  /** Queried point, in world/scene coordinates. */
  x: number;
  y: number;
  /** The entity the engine would return, or `null`. */
  hitId: string | null;
  hitPath?: string;
  /**
   * Every candidate considered, in visit order: children before parents, and later
   * siblings before earlier ones, matching the engine's reverse walk.
   */
  candidates: HitCandidate[];
  /**
   * Which root won. The overlay tree is tested first, so a stray overlay
   * intercepting input is the single most common surprise this explains.
   */
  root: 'overlay' | 'main' | 'none';
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

function intersectBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function pointInBounds(b: Bounds, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

/** Mirrors `Scene.isPointerTransparent`. */
function isPointerTransparent(entity: Entity): boolean {
  try {
    const attrs = entity.getA11yAttributes();
    return attrs.disabled === true || attrs.pointerEvents === 'none';
  } catch {
    return false;
  }
}

/**
 * Whether the point is inside the entity's own shape.
 *
 * `isPointInside` is the engine's authority. The bounds fallback exists because
 * DevTools must also explain entities that do not implement it — the engine's own
 * hit path requires it, so an entity without it can never be hit, and saying so is
 * more useful than silently omitting the candidate.
 */
function pointInShape(
  entity: Entity,
  x: number,
  y: number,
): { inside: boolean; hasShape: boolean } {
  if (typeof entity.isPointInside === 'function') {
    try {
      return { inside: entity.isPointInside(x, y), hasShape: true };
    } catch {
      return { inside: false, hasShape: true };
    }
  }
  return { inside: false, hasShape: false };
}

/**
 * Explain what the engine's hit test finds at a world point, and why.
 *
 * @param scene - Scene to query.
 * @param x - World x.
 * @param y - World y.
 * @returns The winning entity plus every candidate considered with its verdict.
 */
export function explainHitTest(scene: Scene, x: number, y: number): HitExplanation {
  const candidates: HitCandidate[] = [];
  let hit: Entity | null = null;
  let winningRoot: 'overlay' | 'main' | 'none' = 'none';

  const walk = (
    node: Entity,
    depth: number,
    clip: Bounds | null,
    clipper: Entity | null,
  ): Entity | null => {
    const bounds = roundBounds(node.getWorldBounds());

    // Opacity gates the whole subtree, matching the engine: opacity accumulates
    // down the tree, so an invisible parent makes every descendant unhittable.
    if (node.opacity <= 0) {
      candidates.push({
        entityId: node.id,
        entityPath: entityPath(node),
        type: node.constructor.name,
        verdict: 'invisible',
        reason: `opacity ${round2(node.opacity)}: not drawn, so neither it nor its ${node.children.length} descendant(s) can be hit`,
        depth,
        worldBounds: bounds,
      });
      return null;
    }

    let childClip = clip;
    let childClipper = clipper;
    if (node.clipChildren) {
      const box = node.getWorldBounds();
      childClip = clip ? intersectBounds(clip, box) : box;
      childClipper = node;
    }

    // Reverse order: last drawn is topmost, matching the engine.
    //
    // Deliberate divergence: the engine RETURNS on the first hit, so entities
    // underneath the winner are never visited. This keeps walking to enumerate
    // them, because "why did my button not get this click?" is answered by seeing
    // that the button was eligible and something above it won. Only the FIRST hit
    // in visit order is reported as the winner, so the verdict still matches the
    // engine; the extra work is explanation-only and costs a full subtree walk,
    // which is why this is a diagnostic and not something to call per frame.
    let firstHit: Entity | null = null;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (!child) continue;
      const childHit = walk(child, depth + 1, childClip, childClipper);
      if (childHit && !firstHit) firstHit = childHit;
    }
    if (firstHit) return firstHit;

    const { inside, hasShape } = pointInShape(node, x, y);
    if (!hasShape) {
      candidates.push({
        entityId: node.id,
        entityPath: entityPath(node),
        type: node.constructor.name,
        verdict: 'outside-shape',
        reason: 'no isPointInside(): the engine cannot hit this entity at all',
        depth,
        worldBounds: bounds,
      });
      return null;
    }
    if (!inside) {
      candidates.push({
        entityId: node.id,
        entityPath: entityPath(node),
        type: node.constructor.name,
        verdict: 'outside-shape',
        reason: `point (${round2(x)}, ${round2(y)}) is outside its shape`,
        depth,
        worldBounds: bounds,
      });
      return null;
    }

    // Inside its own shape from here on, so the remaining rejections are the
    // interesting ones — these are the cases that look like "the click vanished".
    if (clip && !pointInBounds(clip, x, y)) {
      candidates.push({
        entityId: node.id,
        entityPath: entityPath(node),
        type: node.constructor.name,
        verdict: 'clipped',
        reason: `inside its own shape but outside the clip box of ${clipper?.constructor.name ?? 'an ancestor'}`,
        depth,
        worldBounds: bounds,
        clipperId: clipper?.id,
        clipperPath: clipper ? entityPath(clipper) : undefined,
      });
      return null;
    }

    if (isPointerTransparent(node)) {
      const attrs = node.getA11yAttributes();
      candidates.push({
        entityId: node.id,
        entityPath: entityPath(node),
        type: node.constructor.name,
        verdict: 'pointer-transparent',
        reason:
          attrs.disabled === true
            ? 'disabled: input passes through to whatever is behind it'
            : "pointerEvents: 'none': input passes through to whatever is behind it",
        depth,
        worldBounds: bounds,
      });
      return null;
    }

    candidates.push({
      entityId: node.id,
      entityPath: entityPath(node),
      type: node.constructor.name,
      verdict: 'accepted',
      reason: 'inside its shape, unclipped, and accepts pointer input',
      depth,
      worldBounds: bounds,
    });
    return node;
  };

  // Overlay first, matching the engine. A stray overlay swallowing clicks is the
  // most common thing this function exists to reveal.
  hit = walk(scene.overlayRootEntity, 0, null, null);
  if (hit) winningRoot = 'overlay';
  else {
    hit = walk(scene.rootEntity, 0, null, null);
    if (hit) winningRoot = 'main';
  }

  // Anything that was geometrically eligible but visited after the winner lost to
  // it. Marking those `occluded` rather than leaving them unexplained answers the
  // actual question: "why did my button not get this click?"
  if (hit) {
    const winnerIndex = candidates.findIndex((c) => c.entityId === hit!.id);
    for (let i = winnerIndex + 1; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (candidate.verdict === 'accepted') {
        candidate.verdict = 'occluded';
        candidate.reason = `would have been hit, but ${hit!.constructor.name} is drawn on top`;
      }
    }
  }

  return {
    x: round2(x),
    y: round2(y),
    hitId: hit?.id ?? null,
    hitPath: hit ? entityPath(hit) : undefined,
    candidates,
    root: winningRoot,
  };
}

/** Render an explanation as indented lines for a panel or a log. */
export function formatHitExplanation(explanation: HitExplanation): string[] {
  const lines = [
    `hit test (${explanation.x}, ${explanation.y}) → ${
      explanation.hitId ? `${explanation.hitPath} [${explanation.root}]` : 'nothing'
    }`,
  ];
  for (const candidate of explanation.candidates) {
    const glyph =
      candidate.verdict === 'accepted' ? '✓' : candidate.verdict === 'occluded' ? '·' : '✗';
    lines.push(
      `${'  '.repeat(Math.min(candidate.depth, 6))}${glyph} ${candidate.type} — ${candidate.reason}`,
    );
  }
  return lines;
}
