import type { Entity, Scene } from '@vectojs/core';

/**
 * Which geometry a {@link HighlightLayer} describes.
 *
 * The panel drew only `aabb`, which is why a rotated entity appeared as a
 * bounding box rather than its true edges, and why every other box an entity
 * carries was invisible. Those boxes diverging from each other is the bug class
 * the highlight exists to reveal: a control whose hit area has drifted from its
 * paint, text painted outside the box that clips it, an accessibility rectangle
 * that no longer covers what a sighted user sees.
 */
export type HighlightLayerKind =
  /** World-space axis-aligned bounding box of the layout quad. */
  | 'aabb'
  /** The `[0, 0, width, height]` layout box, transformed — true edges under rotation. */
  | 'layout'
  /** `getBounds()` transformed: what the entity claims it paints, which may exceed layout. */
  | 'render'
  /** The nearest ancestor with `clipChildren`, whose box bounds what stays visible. */
  | 'clip'
  /** Bounds of the projected content element, in scene coordinates. */
  | 'content'
  /** Bounds of the accessibility element, in scene coordinates. */
  | 'a11y'
  /** Sampled region where `isPointInside` answered true. Approximate; see {@link sampleHitRegion}. */
  | 'hit';

/** A closed polygon in scene coordinates. Four points for a quad, more for a sampled region. */
export interface HighlightPolygon {
  points: ReadonlyArray<{ x: number; y: number }>;
}

/**
 * One geometry layer to draw, plus why it is interesting.
 *
 * `divergesFrom` is the point of the whole feature: a layer that coincides with
 * the layout box tells you nothing, while one that does not is usually the bug.
 * Producing that verdict here rather than in the renderer keeps it assertable in
 * a unit test and available to a headless consumer.
 */
export interface HighlightLayer {
  kind: HighlightLayerKind;
  polygons: ReadonlyArray<HighlightPolygon>;
  /** Set when this layer's extent differs from the layout quad by more than a pixel. */
  divergesFromLayout?: boolean;
  /** Set when the geometry could not be derived, with the reason. */
  unavailable?: string;
}

export interface HighlightGeometryOptions {
  /** Layers to compute. Defaults to everything except `hit`. */
  layers?: ReadonlyArray<HighlightLayerKind>;
  /**
   * Grid step in scene units for the `hit` layer. Smaller resolves a shape more
   * finely at quadratic cost: an 8px step over a 200x100 entity is ~325 calls,
   * a 2px step over the same entity is ~5100.
   */
  hitSampleStep?: number;
  /** Cap on `isPointInside` calls per hit sample, so a huge entity cannot stall a frame. */
  hitSampleBudget?: number;
}

const DEFAULT_LAYERS: readonly HighlightLayerKind[] = [
  'aabb',
  'layout',
  'render',
  'clip',
  'content',
  'a11y',
];

const DEFAULT_HIT_STEP = 8;
const DEFAULT_HIT_BUDGET = 4096;
/** Below this, two boxes are the same box: sub-pixel noise is not a divergence. */
const DIVERGENCE_EPSILON = 1;
/**
 * Coverage below which a sampled hit region counts as not filling its box.
 *
 * Grid sampling quantises to `step`, so an exact 1.0 is not reachable for a
 * shape whose edges fall between probes; 0.9 clears that noise while still
 * catching a circle (~0.79) or any inset hit area.
 */
const HIT_COVERAGE_THRESHOLD = 0.9;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Transform a local box's four corners into scene space, preserving orientation.
 *
 * `getWorldBounds()` would collapse this to an AABB, which is exactly the
 * information the `layout` and `render` layers exist to keep.
 */
function quadOf(entity: Entity, box: Box): HighlightPolygon {
  const { a, b, c, d, e, f } = entity.getWorldTransform();
  const corners: Array<{ x: number; y: number }> = [];
  // Emitted in perimeter order (TL, TR, BR, BL) so the points form a drawable
  // closed path rather than a bowtie.
  const locals = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
  ] as const;
  for (const [lx, ly] of locals) {
    corners.push({ x: a * lx + c * ly + e, y: b * lx + d * ly + f });
  }
  return { points: corners };
}

function boundsOfPolygon(polygon: HighlightPolygon): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon.points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function boxToPolygon(box: Box): HighlightPolygon {
  return {
    points: [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
    ],
  };
}

function diverges(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) > DIVERGENCE_EPSILON ||
    Math.abs(a.y - b.y) > DIVERGENCE_EPSILON ||
    Math.abs(a.width - b.width) > DIVERGENCE_EPSILON ||
    Math.abs(a.height - b.height) > DIVERGENCE_EPSILON
  );
}

/** The layout box an entity declares, with the same zero-size fallback the panel used. */
function layoutBox(entity: Entity): Box {
  return { x: 0, y: 0, width: entity.width || 8, height: entity.height || 8 };
}

/**
 * Convert a DOM rect into scene coordinates.
 *
 * The projected layers (a11y, content) live in a root the browser has scaled
 * by `cssWidth / scene.width`, so a raw client rect is not comparable to
 * scene-space geometry — `clientToScene` undoes that scale (and any DPR/zoom)
 * the same way `selectionAudit` normalizes its own rects.
 *
 * jsdom reports an all-zero rect for every element, which would otherwise be
 * published as a real divergence from the canvas; treat that as unavailable.
 * `a11yInspect.domBoundsOf` shares this helper, so the guard covers both.
 */
export function rectToSceneBox(scene: Scene, el: HTMLElement | undefined): Box | undefined {
  if (!el || typeof el.getBoundingClientRect !== 'function') return undefined;
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height && !rect.left && !rect.top) return undefined;
  const toScene = scene.clientToScene?.bind(scene);
  if (!toScene) return undefined;
  const topLeft = toScene(rect.left, rect.top);
  const bottomRight = toScene(rect.right, rect.bottom);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

/** Nearest ancestor that clips its children, or null when nothing clips this entity. */
function clippingAncestor(entity: Entity): Entity | null {
  let node = entity.parent;
  while (node) {
    if (node.clipChildren) return node;
    node = node.parent;
  }
  return null;
}

/**
 * Approximate the region where `isPointInside` answers true, as one polygon per
 * scanline run.
 *
 * `isPointInside(globalX, globalY)` is a predicate, not retrievable geometry —
 * there is no API that turns it into a path, and a component may implement any
 * shape it likes. Sampling a grid over the entity's world AABB is the only way
 * to see the answer it actually gives, which is what matters when a control's
 * clickable area has drifted from its paint.
 *
 * The result is an approximation bounded by `step`, and it is deliberately not
 * computed unless asked for: cost is quadratic in the entity's size.
 */
export function sampleHitRegion(
  entity: Entity,
  options: { step?: number; budget?: number } = {},
): HighlightLayer {
  const step = Math.max(1, options.step ?? DEFAULT_HIT_STEP);
  const budget = Math.max(1, options.budget ?? DEFAULT_HIT_BUDGET);
  const aabb = boundsOfPolygon(quadOf(entity, layoutBox(entity)));
  const cols = Math.max(1, Math.ceil(aabb.width / step));
  const rows = Math.max(1, Math.ceil(aabb.height / step));

  if (cols * rows > budget) {
    return {
      kind: 'hit',
      polygons: [],
      unavailable: `sampling ${cols}x${rows} exceeds the ${budget}-probe budget; raise hitSampleStep`,
    };
  }

  const polygons: HighlightPolygon[] = [];
  for (let row = 0; row < rows; row++) {
    const y = aabb.y + row * step;
    let runStart = -1;
    // One extra column so a run touching the right edge is still closed.
    for (let col = 0; col <= cols; col++) {
      const x = aabb.x + col * step;
      let inside = false;
      if (col < cols) {
        try {
          inside = entity.isPointInside(x + step / 2, y + step / 2) === true;
        } catch {
          inside = false;
        }
      }
      if (inside && runStart < 0) runStart = col;
      else if (!inside && runStart >= 0) {
        polygons.push(
          boxToPolygon({
            x: aabb.x + runStart * step,
            y,
            width: (col - runStart) * step,
            height: step,
          }),
        );
        runStart = -1;
      }
    }
  }

  if (!polygons.length) {
    return {
      kind: 'hit',
      polygons: [],
      unavailable: 'isPointInside answered false everywhere in the layout box',
    };
  }
  const layer: HighlightLayer = { kind: 'hit', polygons };
  // Compared by AREA COVERAGE, not extent. A circle inscribed in its box has
  // exactly the box's extent while accepting only ~79% of its points, so an
  // extent comparison reports the most common divergence — a round control in a
  // square box — as no divergence at all.
  const covered = polygons.reduce((sum, polygon) => {
    const box = boundsOfPolygon(polygon);
    return sum + box.width * box.height;
  }, 0);
  const boxArea = aabb.width * aabb.height;
  if (boxArea > 0 && covered / boxArea < HIT_COVERAGE_THRESHOLD) layer.divergesFromLayout = true;
  return layer;
}

/**
 * Compute the geometry layers for one entity, in scene coordinates.
 *
 * Every layer is attempted independently and a failure is reported as
 * `unavailable` rather than thrown: a component whose `getBounds()` throws must
 * still be inspectable, since being hard to inspect is usually why it is being
 * inspected.
 */
export function highlightGeometry(
  scene: Scene,
  entity: Entity,
  options: HighlightGeometryOptions = {},
): HighlightLayer[] {
  const wanted = new Set(options.layers ?? DEFAULT_LAYERS);
  const layers: HighlightLayer[] = [];
  const layoutQuad = quadOf(entity, layoutBox(entity));
  const layoutExtent = boundsOfPolygon(layoutQuad);

  if (wanted.has('aabb')) {
    layers.push({ kind: 'aabb', polygons: [boxToPolygon(layoutExtent)] });
  }

  if (wanted.has('layout')) {
    // Flagged as diverging when the transform rotates or skews, since that is
    // precisely when the AABB everyone was looking at is not the real edges.
    layers.push({
      kind: 'layout',
      polygons: [layoutQuad],
      divergesFromLayout: isRotated(entity) || undefined,
    });
  }

  if (wanted.has('render')) {
    let bounds: Box | null = null;
    let failure: string | undefined;
    try {
      bounds = entity.getBounds();
    } catch (error) {
      failure = `getBounds() threw: ${describeError(error)}`;
    }
    if (failure) layers.push({ kind: 'render', polygons: [], unavailable: failure });
    else if (!bounds) {
      layers.push({
        kind: 'render',
        polygons: [],
        unavailable: 'getBounds() returned null, so the layout box is the render box',
      });
    } else {
      const quad = quadOf(entity, bounds);
      layers.push({
        kind: 'render',
        polygons: [quad],
        divergesFromLayout: diverges(boundsOfPolygon(quad), layoutExtent) || undefined,
      });
    }
  }

  if (wanted.has('clip')) {
    const clipper = clippingAncestor(entity);
    if (!clipper) {
      layers.push({
        kind: 'clip',
        polygons: [],
        unavailable: 'no ancestor clips this entity',
      });
    } else {
      const quad = quadOf(clipper, layoutBox(clipper));
      layers.push({ kind: 'clip', polygons: [quad], divergesFromLayout: true });
    }
  }

  if (wanted.has('content')) {
    const box = rectToSceneBox(scene, scene.getContentElement?.(entity.id));
    layers.push(
      box
        ? {
            kind: 'content',
            polygons: [boxToPolygon(box)],
            divergesFromLayout: diverges(box, layoutExtent) || undefined,
          }
        : {
            kind: 'content',
            polygons: [],
            unavailable: 'no projected content element with measurable bounds',
          },
    );
  }

  if (wanted.has('a11y')) {
    const box = rectToSceneBox(scene, scene.getA11yElement?.(entity.id));
    layers.push(
      box
        ? {
            kind: 'a11y',
            polygons: [boxToPolygon(box)],
            divergesFromLayout: diverges(box, layoutExtent) || undefined,
          }
        : {
            kind: 'a11y',
            polygons: [],
            unavailable: 'no accessibility element with measurable bounds',
          },
    );
  }

  if (wanted.has('hit')) {
    layers.push(
      sampleHitRegion(entity, {
        step: options.hitSampleStep,
        budget: options.hitSampleBudget,
      }),
    );
  }

  return layers;
}

/** True when the world transform has any rotation or skew, so the AABB is misleading. */
function isRotated(entity: Entity): boolean {
  const { b, c } = entity.getWorldTransform();
  return Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Render the layers as text, for a headless consumer or an agent.
 *
 * Layers that coincide with the layout box are listed too: knowing a box did
 * *not* drift is a finding, and omitting it would read as "not computed".
 */
export function formatHighlightGeometry(layers: ReadonlyArray<HighlightLayer>): string[] {
  return layers.map((layer) => {
    if (layer.unavailable) return `${layer.kind}: — ${layer.unavailable}`;
    const box = layer.polygons.length
      ? layer.polygons.reduce<Box | null>((acc, polygon) => {
          const b = boundsOfPolygon(polygon);
          if (!acc) return b;
          const minX = Math.min(acc.x, b.x);
          const minY = Math.min(acc.y, b.y);
          const maxX = Math.max(acc.x + acc.width, b.x + b.width);
          const maxY = Math.max(acc.y + acc.height, b.y + b.height);
          return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        }, null)
      : null;
    const extent = box
      ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`
      : 'empty';
    const parts = [`${layer.kind}: ${extent}`];
    if (layer.polygons.length > 1) parts.push(`${layer.polygons.length} spans`);
    if (layer.divergesFromLayout) parts.push('diverges');
    return parts.join('  ');
  });
}
