/**
 * Renderer abstraction consumed by every {@link Entity}.
 *
 * Implementations wrap a concrete drawing backend (Canvas 2D, WebGL, …) and
 * expose a path-based drawing API.  Entities must only depend on `IRenderer`
 * so they remain backend-agnostic.
 *
 * @example
 * // Inside an Entity.render() implementation:
 * render(r: IRenderer) {
 *   r.beginPath();
 *   r.fill('#38bdf8');
 * }
 */
interface IRenderer {
    /** Clear the entire drawing surface to transparent / background color. */
    clear(): void;
    /** Push the current transform + state onto the renderer's stack. */
    save(): void;
    /** Pop the last saved transform + state from the renderer's stack. */
    restore(): void;
    /**
     * Apply a translation to the current transform matrix.
     *
     * @param x - Horizontal offset in pixels.
     * @param y - Vertical offset in pixels.
     */
    translate(x: number, y: number): void;
    /**
     * Apply a scale to the current transform matrix.
     *
     * @param x - Horizontal scale factor.
     * @param y - Vertical scale factor.
     */
    scale(x: number, y: number): void;
    /**
     * Apply a clockwise rotation to the current transform matrix.
     *
     * @param angle - Rotation angle in radians.
     */
    rotate(angle: number): void;
    /**
     * Set the global opacity applied to all subsequent draw calls.
     *
     * @param alpha - Opacity in the range `[0, 1]`.
     */
    setGlobalAlpha(alpha: number): void;
    /** Begin a new sub-path, discarding the current path. */
    beginPath(): void;
    /**
     * Move the pen to the given point without drawing a line.
     *
     * @param x - Target X coordinate.
     * @param y - Target Y coordinate.
     */
    moveTo(x: number, y: number): void;
    /**
     * Add a straight line segment from the current pen position to the given point.
     *
     * @param x - Target X coordinate.
     * @param y - Target Y coordinate.
     */
    lineTo(x: number, y: number): void;
    /**
     * Add a cubic Bézier curve to the current path.
     *
     * @param cp1x - X of the first control point.
     * @param cp1y - Y of the first control point.
     * @param cp2x - X of the second control point.
     * @param cp2y - Y of the second control point.
     * @param x - X of the end point.
     * @param y - Y of the end point.
     */
    bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
    /** Close the current sub-path by drawing a line back to its starting point. */
    closePath(): void;
    /**
     * Add a circular arc to the current path.
     *
     * @param x - X of the arc center.
     * @param y - Y of the arc center.
     * @param radius - Arc radius in pixels.
     * @param startAngle - Start angle in radians (0 = 3 o'clock).
     * @param endAngle - End angle in radians.
     * @param counterclockwise - If `true`, draws the arc counter-clockwise.
     */
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
    /**
     * Add a rounded rectangle to the current path.
     *
     * @param x - Left edge.
     * @param y - Top edge.
     * @param width - Rectangle width.
     * @param height - Rectangle height.
     * @param radii - Corner radius (uniform) or per-corner array as accepted by `CanvasRenderingContext2D.roundRect()`.
     */
    roundRect(x: number, y: number, width: number, height: number, radii: number | number[]): void;
    /**
     * Draw an image or video frame into the canvas.
     *
     * @param source - The image source (HTMLImageElement, HTMLVideoElement, HTMLCanvasElement, etc.).
     * @param dx - Destination X.
     * @param dy - Destination Y.
     * @param dw - Destination width.
     * @param dh - Destination height.
     */
    drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
    /**
     * Fill the current path with the given color or gradient.
     *
     * @param colorOrGradient - CSS color string or a gradient object.
     */
    fill(colorOrGradient: string | any): void;
    /**
     * Stroke the current path with the given color or gradient.
     *
     * @param colorOrGradient - CSS color string or a gradient object.
     * @param lineWidth - Stroke width in pixels (default: `1`).
     */
    stroke(colorOrGradient: string | any, lineWidth?: number): void;
    /**
     * Render a text string at the given position.
     *
     * @param text - The string to draw.
     * @param x - Left edge of the text baseline.
     * @param y - Baseline Y coordinate.
     * @param font - CSS font shorthand, e.g. `'16px monospace'`.
     * @param color - CSS color string or gradient.
     */
    fillText(text: string, x: number, y: number, font: string, color: string | any): void;
    /**
     * Create a linear gradient between two points with the given color stops.
     *
     * @param x0 - X of the gradient start point.
     * @param y0 - Y of the gradient start point.
     * @param x1 - X of the gradient end point.
     * @param y1 - Y of the gradient end point.
     * @param colorStops - Array of `{ stop, color }` pairs where `stop` is in `[0, 1]`.
     * @returns An opaque gradient object suitable for {@link fill} or {@link stroke}.
     */
    createLinearGradient(x0: number, y0: number, x1: number, y1: number, colorStops: {
        stop: number;
        color: string;
    }[]): any;
}

/**
 * Canvas 2D implementation of {@link IRenderer}.
 *
 * Wraps a `CanvasRenderingContext2D`, applies HiDPI (`devicePixelRatio`)
 * scaling on construction, and delegates every path/fill/stroke call to the
 * native 2D API.  Used internally by {@link Scene}; obtain a reference via
 * `scene.getRenderer()` when direct access is needed.
 *
 * @example
 * const renderer = new CanvasRenderer(document.querySelector('canvas')!);
 * renderer.clear();
 * renderer.beginPath();
 * renderer.fill('#38bdf8');
 */
declare class CanvasRenderer implements IRenderer {
    private ctx;
    private width;
    private height;
    constructor(canvas: HTMLCanvasElement);
    /**
     * Expose the underlying `CanvasRenderingContext2D` for operations not
     * covered by the {@link IRenderer} interface.
     *
     * @returns The raw 2D rendering context.
     */
    getContext(): CanvasRenderingContext2D;
    /**
     * Resize the backing canvas buffer and re-apply DPR scaling.
     *
     * Called automatically by {@link Scene} on `window.resize` events.
     *
     * @param width - New logical width in CSS pixels.
     * @param height - New logical height in CSS pixels.
     */
    resize(width: number, height: number): void;
    /** @inheritdoc */
    clear(): void;
    /** @inheritdoc */
    save(): void;
    /** @inheritdoc */
    restore(): void;
    /** @inheritdoc */
    translate(x: number, y: number): void;
    /** @inheritdoc */
    scale(x: number, y: number): void;
    /** @inheritdoc */
    rotate(angle: number): void;
    /** @inheritdoc */
    setGlobalAlpha(alpha: number): void;
    /** @inheritdoc */
    beginPath(): void;
    /** @inheritdoc */
    moveTo(x: number, y: number): void;
    /** @inheritdoc */
    lineTo(x: number, y: number): void;
    /** @inheritdoc */
    bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
    /** @inheritdoc */
    closePath(): void;
    /** @inheritdoc */
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
    /** @inheritdoc */
    roundRect(x: number, y: number, width: number, height: number, radii: number | number[]): void;
    /** @inheritdoc */
    drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
    /** @inheritdoc */
    fill(color: string | any): void;
    /** @inheritdoc */
    stroke(color: string | any, lineWidth?: number): void;
    /** @inheritdoc */
    fillText(text: string, x: number, y: number, font: string, color: string | any): void;
    /** @inheritdoc */
    createLinearGradient(x0: number, y0: number, x1: number, y1: number, colorStops: {
        stop: number;
        color: string;
    }[]): any;
}

/**
 * A 2-D coordinate in canvas/world space.
 */
interface Point {
    x: number;
    y: number;
}
/**
 * Union of all pointer/interaction events that can be emitted by an {@link Entity}.
 */
type VectoEvent = 'click' | 'hover' | 'pointerdown' | 'pointerup' | 'pointermove' | 'pointerleave';
/**
 * Base class for every node in the Virtual Math Tree (VMT).
 *
 * Subclass `Entity` and implement {@link isPointInside} and {@link render} to
 * create custom drawable objects.  Entities form a scene-graph: each node may
 * own child entities, inheriting the parent's transform.
 *
 * @example
 * class CircleEntity extends Entity {
 *   isPointInside(x: number, y: number) {
 *     return Math.hypot(x - this.x, y - this.y) < 50;
 *   }
 *   render(r: IRenderer) {
 *     r.beginPath();
 *     r.fill('#38bdf8');
 *   }
 * }
 */
declare abstract class Entity {
    id: string;
    children: Entity[];
    parent: Entity | null;
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
    opacity: number;
    interactive: boolean;
    width: number;
    height: number;
    a11yOffsetX: number;
    a11yOffsetY: number;
    protected listeners: Map<VectoEvent, Array<(e: any) => void>>;
    private animations;
    constructor(id?: string);
    /**
     * Append a child entity to this node's children array.
     *
     * @param child - The entity to add as a child.
     * @returns `this` for method chaining.
     */
    add(child: Entity): this;
    /**
     * Remove a child entity from this node.
     *
     * @param child - The entity to remove.
     * @returns `this` for method chaining.
     */
    remove(child: Entity): this;
    /**
     * Set the local position of this entity.
     *
     * @param x - Horizontal position in local space.
     * @param y - Vertical position in local space.
     * @returns `this` for method chaining.
     * @example entity.setPosition(100, 200);
     */
    setPosition(x: number, y: number): this;
    /**
     * Queue a tween animation toward the specified target property values.
     *
     * Multiple calls chain animations sequentially.  Only numeric properties
     * are interpolated; non-numeric values are ignored.
     *
     * @param targetProps - Partial set of numeric properties to tween to.
     * @param durationMs - Duration of the tween in milliseconds.
     * @returns `this` for method chaining.
     * @example entity.animate({ x: 400, opacity: 0 }, 500);
     */
    animate(targetProps: Partial<this>, durationMs: number): this;
    /**
     * Advance the entity's internal state for one frame.
     *
     * Called automatically by the {@link Scene} render loop — override in
     * subclasses to implement custom per-frame logic.
     *
     * @param dt - Elapsed time since the last frame in milliseconds.
     * @param time - Absolute timestamp from `performance.now()`.
     */
    update(_dt: number, time: number): void;
    /**
     * Register a listener for a {@link VectoEvent}.
     *
     * @param event - The event name to listen for.
     * @param callback - Handler invoked when the event is emitted.
     * @returns `this` for method chaining.
     * @example entity.on('click', (e) => console.log('clicked', e));
     */
    on(event: VectoEvent, callback: (e: any) => void): this;
    /**
     * Remove a previously registered event listener.
     *
     * @param event - The event name to stop listening to.
     * @param callback - The exact handler reference passed to {@link on}.
     * @returns `this` for method chaining.
     */
    off(event: VectoEvent, callback: (e: any) => void): this;
    /**
     * Tear down this entity: clear all animations, event listeners, and detach
     * from parent. Call before discarding an entity to prevent memory leaks.
     */
    destroy(): void;
    /**
     * Dispatch a {@link VectoEvent} to all registered listeners on this entity.
     *
     * @param event - The event name to dispatch.
     * @param payload - Arbitrary data forwarded to each listener.
     */
    emit(event: VectoEvent, payload: any): void;
    /**
     * Compute the entity's position in world/canvas space by accumulating
     * local offsets up the scene-graph hierarchy using affine transformations (scale and rotation).
     *
     * @returns World-space {@link Point} for this entity.
     */
    getGlobalPosition(): Point;
    /**
     * Return `true` when the given world-space point lies within this entity's
     * interactive hit area.
     *
     * @param globalX - World-space X coordinate.
     * @param globalY - World-space Y coordinate.
     * @returns Whether the point is inside this entity.
     */
    abstract isPointInside(globalX: number, globalY: number): boolean;
    /**
     * Draw this entity using the provided renderer.
     *
     * Called each frame after the entity's transform has been pushed onto the
     * renderer's matrix stack.
     *
     * @param renderer - The active renderer instance.
     */
    abstract render(renderer: any): void;
}

/**
 * Top-level orchestrator that owns the entity tree, drive the render loop,
 * and maintains the accessibility/automation shadow layer.
 *
 * Create one `Scene` per `<canvas>` element.  Add {@link Entity} objects via
 * {@link add}, then call {@link start} to begin the 60-FPS render loop.
 *
 * @example
 * const scene = new Scene(document.querySelector('canvas')!);
 * scene.add(new CircleEntity().setPosition(100, 100));
 * scene.start();
 */
declare class Scene {
    private root;
    private renderer;
    private isRunning;
    private lastTime;
    canvas: HTMLCanvasElement;
    private a11yRoot;
    private a11yElements;
    private resizeHandler;
    constructor(canvas: HTMLCanvasElement);
    /**
     * Expose the underlying {@link IRenderer} for advanced direct-draw operations.
     *
     * @returns The active renderer instance.
     */
    getRenderer(): IRenderer;
    /**
     * Add a top-level entity to the scene graph.
     *
     * @param entity - The entity to attach to the scene root.
     * @returns `this` for method chaining.
     * @example scene.add(new CircleEntity());
     */
    add(entity: Entity): this;
    private removeA11yRecursively;
    /**
     * Remove a top-level entity from the scene graph and clean up its
     * accessibility shadow elements recursively.
     *
     * @param entity - The entity to detach from the scene root.
     * @returns `this` for method chaining.
     */
    remove(entity: Entity): this;
    /**
     * Tear down the Scene, halt the loop, and clean up event listeners and DOM elements.
     */
    destroy(): void;
    private setupEvents;
    /**
     * Begin the `requestAnimationFrame` render loop.
     *
     * Idempotent — calling `start()` on an already-running scene is a no-op.
     */
    start(): void;
    /**
     * Halt the render loop after the current frame completes.
     *
     * Call {@link start} again to resume rendering.
     */
    stop(): void;
    private syncA11y;
    private loop;
}

declare class TextEntity extends Entity {
    text: string;
    private atlas;
    private layout;
    private nodes;
    fontSize: number;
    fillStyle: string | any;
    strokeStyle: string | any;
    hoveredFillStyle: string | any;
    lineWidth: number;
    private isHovered;
    constructor(text: string, atlas: any, maxWidth: number, fontSize?: number);
    private updateLayout;
    isPointInside(globalX: number, globalY: number): boolean;
    render(renderer: IRenderer): void;
}

declare class GridTextEntity extends Entity {
    fontSize: number;
    fillStyle: string;
    grid: string[];
    cols: number;
    rows: number;
    charWidth: number;
    charHeight: number;
    constructor(_atlas: any, fontSize?: number);
    updateGrid(ascii: string[]): void;
    isPointInside(_globalX: number, _globalY: number): boolean;
    render(renderer: IRenderer): void;
}

/**
 * Map from a single grapheme character to its pre-measured glyph metrics.
 *
 * Each entry provides the glyph's pixel `width` at `baseSize`, and an `ast`
 * property holding the raw vector path data used by the renderer.
 */
interface GlyphAtlas {
    [char: string]: {
        width: number;
        baseSize: number;
        ast: any;
    };
}
/**
 * A single positioned glyph produced by {@link LayoutEngine.layoutText}.
 */
interface LayoutNode {
    char: string;
    x: number;
    y: number;
    width: number;
    height: number;
}
/**
 * The complete output of a text layout pass — an ordered list of positioned
 * glyphs and the total bounding-box dimensions.
 */
interface LayoutResult {
    nodes: LayoutNode[];
    totalWidth: number;
    totalHeight: number;
}
/**
 * VectoUI Global Layout Engine (Intl.Segmenter)
 * Advanced Typography Engine supporting CJK, Emoji, and Western Graphemes
 */
declare class LayoutEngine {
    maxWidth: number;
    maxHeight: number;
    private wordSegmenter;
    private charSegmenter;
    private wordCache;
    private graphemeCache;
    constructor(maxWidth: number, maxHeight: number);
    private getWordSegments;
    private getGraphemes;
    /**
     * Lay out a Unicode string into a list of positioned {@link LayoutNode} glyphs.
     *
     * Uses `Intl.Segmenter` to correctly handle CJK, emoji, and Western word
     * boundaries.  An optional `exclusionMask` callback allows glyphs to flow
     * around arbitrary shapes (e.g. physics bodies or video regions).
     *
     * @param text - The raw text string to lay out (newlines force paragraph breaks).
     * @param fontAtlas - Pre-measured glyph metrics keyed by grapheme character.
     * @param fontSize - Target font size in pixels (default: `32`).
     * @param exclusionMask - Optional callback returning `true` when a candidate
     *   glyph bounding box overlaps a forbidden region; the engine skips that
     *   position and advances horizontally.
     * @returns A {@link LayoutResult} with all positioned glyph nodes and total dimensions.
     * @example
     * const result = engine.layoutText('Hello 世界', atlas, 24);
     * result.nodes.forEach(n => console.log(n.char, n.x, n.y));
     */
    layoutText(text: string, fontAtlas: GlyphAtlas, fontSize?: number, exclusionMask?: (x: number, y: number, w: number, h: number) => boolean): LayoutResult;
    /**
     * Lay out a Unicode string directly into a pre-allocated {@link LayoutResultBuffer}.
     *
     * Avoids GC allocations by writing results directly to flat typed arrays in the buffer.
     *
     * @param text - The raw text string to lay out.
     * @param fontAtlas - Pre-measured glyph metrics keyed by grapheme character.
     * @param fontSize - Target font size in pixels.
     * @param buffer - The pre-allocated buffer to write layout results into.
     * @param exclusionMask - Optional collision-detection callback.
     */
    layoutTextIntoBuffer(text: string, fontAtlas: GlyphAtlas, fontSize: number, buffer: LayoutResultBuffer, exclusionMask?: (x: number, y: number, w: number, h: number) => boolean): void;
}
/**
 * Pre-allocated buffer for zero-GC layout results.
 * Reuse a single instance across frames by calling reset() before each layout pass.
 */
declare class LayoutResultBuffer {
    static readonly CAPACITY = 16384;
    /** X positions of each glyph. */
    xs: Float32Array;
    /** Y positions of each glyph. */
    ys: Float32Array;
    /** Widths of each glyph. */
    ws: Float32Array;
    /** Heights of each glyph. */
    hs: Float32Array;
    /** Character for each glyph slot. */
    chars: string[];
    /** Number of valid glyphs written in this buffer. */
    count: number;
    /** Reset the buffer for reuse. Does NOT free memory. */
    reset(): void;
    /** Convert to the standard LayoutResult format (allocates — use sparingly). */
    toLayoutResult(): LayoutResult;
}

/**
 * Fixed-cell Spatial Hash Grid for O(1) average-case AABB neighbor queries.
 * Insert entities each frame, then query by AABB to find nearby entity IDs.
 */
declare class SpatialHashGrid {
    private cellSize;
    private grid;
    private entityCells;
    constructor(cellSize?: number);
    private hash;
    private cellsForAABB;
    /**
     * Insert or update an entity's axis-aligned bounding box in the grid.
     *
     * If the entity is already registered its old cell memberships are removed
     * before the new ones are computed, so this method is safe to call every
     * frame.
     *
     * @param id - Unique string identifier for the entity.
     * @param x - Left edge of the AABB in world space.
     * @param y - Top edge of the AABB in world space.
     * @param w - Width of the AABB.
     * @param h - Height of the AABB.
     */
    insert(id: string, x: number, y: number, w: number, h: number): void;
    /**
     * Remove an entity from all grid cells it currently occupies.
     *
     * Silently does nothing if the entity is not registered.
     *
     * @param id - Unique string identifier of the entity to remove.
     */
    remove(id: string): void;
    /**
     * Return all entity IDs whose grid cells overlap the given AABB.
     *
     * Time complexity: O(k) where k is the number of cells the query AABB spans
     * plus the number of results — O(1) average for small, similarly-sized entities.
     *
     * @param x - Left edge of the query AABB.
     * @param y - Top edge of the query AABB.
     * @param w - Width of the query AABB.
     * @param h - Height of the query AABB.
     * @returns A `Set` of entity ID strings whose cells intersect the query region.
     */
    query(x: number, y: number, w: number, h: number): Set<string>;
    /**
     * Clear all cells and entity registrations, resetting the grid to an empty state.
     *
     * Call once per frame before re-inserting all dynamic entities.
     */
    clear(): void;
}

export { CanvasRenderer, Entity, type GlyphAtlas, GridTextEntity, type IRenderer, LayoutEngine, type LayoutNode, type LayoutResult, LayoutResultBuffer, type Point, Scene, SpatialHashGrid, TextEntity, type VectoEvent };
