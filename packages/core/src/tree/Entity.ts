import {
  TweenDriver,
  SpringDriver,
  isTweenConfig,
  type PropertyDriver,
  type MotionConfig,
  type TweenConfig,
  type SpringConfig,
} from '@vectojs/animation';
import type { PreparedContentGrid } from '@vectojs/text';

/** A numeric transform/visual property that participates in the animation system. */
export type AnimatableProp = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity';

const ANIMATABLE_PROPS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
]);

/**
 * A 2-D coordinate in canvas/world space.
 */
export interface Point {
  x: number;
  y: number;
}

/** Six-scalar 2D affine transform matching CanvasRenderingContext2D. */
export interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * An axis-aligned bounding box in an entity's local coordinate space.
 *
 * Returned from {@link Entity.getBounds} to enable viewport culling.
 */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Half-open child index range selected for the current render traversal. */
export interface RenderChildRange {
  /** Index of the first child to visit. */
  start: number;
  /** Index after the last child to visit. */
  end: number;
}

/**
 * Describes an entity that renders as a single filled circle at its local
 * origin, returned from {@link Entity.getBatchCircle} to opt into the renderer's
 * draw-call batching fast-path.
 */
export interface BatchCircle {
  /** Circle radius in the entity's local space. */
  radius: number;
  /** CSS fill color. */
  color: string;
}

/**
 * Describes an entity that renders as a single filled rectangle from its local
 * origin, returned from {@link Entity.getBatchRect} to opt into the GPU
 * instanced-rectangle fast-path (WebGL `pointBackend` only).
 */
export interface BatchRect {
  /** Rectangle width in the entity's local space. */
  width: number;
  /** Rectangle height in the entity's local space. */
  height: number;
  /** CSS fill color. */
  color: string;
}

/**
 * Static text an {@link Entity} exposes for DOM content projection, returned
 * from {@link Entity.getContentProjection}. The Scene mirrors it as a
 * transparent, position-synced DOM node so browser-native text machinery —
 * find-in-page, screen readers, SEO crawlers, translation, `#:~:text=`
 * fragments — operates on canvas-rendered text.
 */
export interface ContentProjectionRun {
  /** Text written with one CSS font inside a projected visual line. */
  text: string;
  /** CSS font shorthand matching the canvas run. */
  font?: string;
  /**
   * Absolute local x of this run within the entity. Set it (with {@link width})
   * for justified or otherwise non-naturally-spaced text: the Scene then places
   * each run as a positioned carrier (`inline-block` + relative `left`) at the
   * exact canvas x, so the DOM selection box overlaps the drawn glyphs instead
   * of drifting under the browser's own inter-word spacing. When omitted, runs
   * flow naturally (the default for left-aligned text).
   */
  x?: number;
  /**
   * Advance (width in px) the canvas used for this run, including any widened
   * trailing gap for justify. Used only alongside {@link x} to size the
   * positioned carrier so the next run starts flush at its own `x`.
   */
  width?: number;
}

export interface ContentProjectionLine {
  /** Text for browser find-in-page and native selection. */
  text: string;
  /**
   * Logical source content between this visual line and the next one. Use a
   * space for a consumed soft-wrap separator, `"\n"` for a hard break, or an
   * empty string for a space-less wrap. Omit to retain the legacy newline
   * fallback between non-final lines.
   */
  separatorAfter?: string;
  /** Local origin of the visual line inside the entity. */
  x: number;
  y: number;
  /** Canvas baseline relative to `y`. */
  baseline: number;
  /** CSS font used for the line when it has no styled runs. */
  font?: string;
  /** Explicit line height for this line. */
  lineHeight?: number;
  /** Styled text runs in visual order. */
  runs?: ContentProjectionRun[];
  /**
   * Emit one flow-relative carrier per grapheme cluster on this line instead
   * of a single text node. Used by natural-order (non-bidi, non-justified) text
   * to correct the residual ~0.3% per-character Gecko grid-fit drift that causes
   * selection highlight boxes to lag or lead painted glyphs.
   *
   * Only meaningful when `runs` is absent or empty. Setting it on a line that
   * already has positioned runs is a no-op — those lines use their own
   * flow-relative carriers already.
   *
   * Must NOT be set for bidi/RTL lines: per-glyph carriers break logical caret
   * hit-mapping when DOM order != visual order (PR #146 revert).
   */
  perGraphemeCarriers?: boolean;
  /**
   * The canvas painted this line's ink as ONE shaped `fillText(line.text)`, so
   * the ink includes the browser's kerning and ligatures. Per-grapheme
   * carriers must then be measured as shaped PREFIX DIFFERENCES of the whole
   * line — isolated grapheme advances would omit exactly the kerning/ligature
   * contraction the paint applied, widening the DOM line past the ink.
   *
   * Leave unset for per-glyph painters (glyphs placed at summed isolated
   * advances, e.g. RichText and TextEntity): there the ink is unkerned, and
   * shaped prefixes would drift the carriers ahead of it by the accumulated
   * kerning delta instead.
   *
   * Only meaningful alongside {@link perGraphemeCarriers}.
   */
  shapedPaint?: boolean;
}

/**
 * Advice from the {@link Scene} about which part of an entity is worth
 * describing in {@link Entity.getContentProjection}.
 *
 * **Purely an optimization, and ignoring it is always correct.** The Scene
 * windows the DOM itself, so an entity that returns its whole document still
 * behaves correctly — it just pays to build lines that get discarded. An entity
 * whose projection is O(glyphs) can use this to make that build O(visible)
 * instead, which is the difference between per-frame cost that scales with the
 * document and cost that scales with the viewport.
 *
 * Why a hint rather than a strict window: the entity owns the mapping from its
 * own text to visual lines, and only it knows things like where a wrapped
 * paragraph begins. Handing it a band and letting it round outward keeps that
 * knowledge in one place. An entity may return more than asked — never less
 * than it can, because text absent from the projection is invisible to
 * find-in-page, copy and, for static text, the screen reader.
 */
export interface ContentProjectionHint {
  /**
   * Inclusive band of entity-local y worth projecting, already expanded by the
   * scene's `contentProjectionMargin` and intersected with every clipping
   * ancestor. Absent when no useful bound exists (a rotated or skewed
   * transform, a boundless entity), in which case project everything.
   */
  minY?: number;
  maxY?: number;
  /**
   * When `true`, the caller only needs {@link ContentProjection.text} — no
   * `lines`, no `grid`. Entities receiving this should return the full source
   * text without building per-line or per-glyph structures, which avoids the
   * O(glyphs) layout walk that the coarse resident tier would discard anyway.
   *
   * Entities may ignore this hint and still return `lines`; the caller will
   * simply not use them. Returning fewer than all lines is **not** safe under
   * this hint: if `lines` is non-empty, Scene interprets it as the line
   * window, which must cover the whole text for correctness.
   */
  textOnly?: boolean;
}

/**
 * Whether a line at `y` of height `height` is worth projecting under `hint`.
 *
 * Shared so every consumer rounds the same way: a line is kept when its box
 * overlaps the band at all, which retains a line straddling the edge whole
 * rather than clipping it mid-glyph. Returns `true` when the hint carries no
 * band, so the default is always "project it".
 */
export function contentLineInHint(
  hint: ContentProjectionHint | undefined,
  y: number,
  height: number,
): boolean {
  if (hint?.minY === undefined || hint.maxY === undefined) return true;
  return y + height >= hint.minY && y <= hint.maxY;
}

export interface ContentProjection {
  /** The logical source text exposed to find, selection, copy, and assistive technology. */
  text: string;
  /** CSS font shorthand matching the drawn glyphs, e.g. `'24px sans-serif'`. */
  font?: string;
  /** Line height in px, when it differs from the font's default. */
  lineHeight?: number;
  /**
   * Allow native mouse selection on the projected text. Off by default so the
   * projection never intercepts pointer input meant for the canvas.
   */
  selectable?: boolean;
  /** Local x-origin of the rendered text inside the owning entity. */
  contentX?: number;
  /** Local y-origin of the rendered text inside the owning entity. */
  contentY?: number;
  /**
   * Canvas baseline relative to `contentY` for the first line. When supplied,
   * Scene aligns the DOM line box baseline instead of assuming both engines
   * interpret the entity top as a text baseline.
   */
  baseline?: number;
  /** Explicit visual lines for mixed-style or internally inset text. */
  lines?: ContentProjectionLine[];
  /**
   * Set to `'none'` for grid-drawn monospace content (code blocks, editors):
   * the Scene disables OpenType ligatures and kerning on the projected DOM
   * text so its selection geometry matches canvas text drawn cell-by-cell.
   * Firefox otherwise ligates sequences like `ffi` in the DOM copy and the
   * highlight drifts off the drawn glyphs.
   */
  ligatures?: 'normal' | 'none';
  /**
   * Retained source-aware grid geometry for code-like content. Canvas paint
   * and semantic projection share this plan so grapheme, tab, wide-character,
   * shaping, and bidi boundaries cannot drift between the two surfaces.
   */
  grid?: PreparedContentGrid;
  /**
   * Confine the projected text's paint to the projection element's own box.
   *
   * Opt in when the entity's `render()` clips its own drawing, so the two
   * surfaces agree on where the content ends. Without it the canvas clips and
   * the DOM copy does not, and a selection highlight over content wider than
   * the box paints past the entity onto whatever is drawn beside it — the
   * defect a horizontally scrollable code block exhibits.
   *
   * Off by default, because the projection element is deliberately unclipped:
   * `Scene` relies on that so selection can start in an entity's blank/padding
   * regions and extend beyond its bounds.
   */
  clipToBounds?: boolean;
}

/** Typography for a native input projected by the accessibility layer. */
export interface TextInputStyle {
  /** CSS font shorthand shared with the canvas mirror. */
  font: string;
  /** Explicit line advance in CSS pixels. */
  lineHeight: number;
  /** Inner text inset in CSS pixels. */
  padding: number;
}

/**
 * Semantic attributes an {@link Entity} can project into the accessibility /
 * automation shadow layer maintained by {@link Scene}.
 *
 * Returned from {@link Entity.getA11yAttributes}; consumed by `Scene.syncA11y`
 * to create and label the shadow DOM node (e.g. a real `<button>` or `<a href>`)
 * so the canvas stays accessible and clickable by automation/agents.
 */
/**
 * One value in a {@link DevtoolsDescriptor} group.
 *
 * JSON-safe by construction: DevTools serializes descriptors to render a panel,
 * to write a snapshot, and to cross a `postMessage` bridge, so a value that
 * cannot survive `structuredClone` is a bug rather than a limitation.
 */
export interface DevtoolsField {
  /** Field name as shown in the inspector, e.g. `'scrollTop'`. */
  label: string;
  /** Current value. Keep to primitives, or short arrays/records of primitives. */
  value:
    | string
    | number
    | boolean
    | null
    | ReadonlyArray<string | number>
    | Record<string, string | number | boolean>;
  /**
   * Optional one-line explanation, shown as a tooltip.
   *
   * Worth spending: a reader looking at `visibleRange: [12, 34]` cannot tell
   * whether the bounds are inclusive without being told.
   */
  hint?: string;
  /**
   * Mark a value that reflects derived or externally-owned state, so the panel
   * can show it as read-only rather than inviting an edit that will be silently
   * reverted. A `Stack`-laid-out child's `x` is the canonical example.
   */
  readOnly?: boolean;
}

/**
 * A component's self-description for DevTools.
 *
 * Without this, the inspector can only show generic `Entity` properties —
 * position, size, opacity — so everything that makes a component a component is
 * invisible: `Input.value`, `Slider.min`/`max`, `ScrollView.scrollTop`,
 * `VirtualList.visibleRange`, a `Markdown` block's token counts. The alternative
 * is DevTools carrying a table of component types, which inverts the dependency
 * (a debug tool would gate every new component) and breaks under minified builds
 * where `constructor.name` is unreliable.
 *
 * Implement {@link Entity.getDevtoolsDescriptor} to opt in. Cost is paid only
 * when a panel actually inspects the entity, so a descriptor may compute values
 * it would not compute per frame.
 *
 * @example
 * ```ts
 * public override getDevtoolsDescriptor(): DevtoolsDescriptor {
 *   return {
 *     kind: 'ScrollView',
 *     groups: [{
 *       label: 'Scroll',
 *       fields: [
 *         { label: 'scrollTop', value: this.scrollTop },
 *         { label: 'contentHeight', value: this.contentHeight, readOnly: true },
 *       ],
 *     }],
 *   };
 * }
 * ```
 */
export interface DevtoolsDescriptor {
  /**
   * Component kind for display, e.g. `'VirtualList'`.
   *
   * Provided explicitly rather than read from `constructor.name`, which minifies
   * to something meaningless in a production bundle.
   */
  kind: string;
  /** Grouped fields, rendered as sections in the order given. */
  groups: ReadonlyArray<{
    label: string;
    fields: ReadonlyArray<DevtoolsField>;
  }>;
  /**
   * Free-form notes: a caveat, a known-slow path, a link to a doc section.
   * Rendered under the groups.
   */
  notes?: ReadonlyArray<string>;
  /**
   * Stable identity for snapshot diffing, independent of tree position.
   *
   * Snapshot paths are structural indices (`root > Card[0] > Text[2]`), so
    * inserting at the head of a list renames every sibling, so the diff describes
 * different nodes than the ones that changed. A key that survives reordering — a
 * row id, a message id — keeps each entry attributed to the node it belongs to.
 * Most relevant to `VirtualList` and `Table`, where recycling moves entities
 * constantly.

   */
  devtoolsKey?: string;
}

/**
 * Entity properties a parent computes for its children.
 *
 * Editing one of these on a child is silently reverted by the next layout pass,
 * which looks like the editor being broken rather than the value being owned
 * elsewhere. A container declares what it controls so a tool can say so up front
 * instead of letting a user discover it by watching their change disappear.
 *
 * Declared by the parent rather than detected by the tool: only the container
 * knows whether it writes `x` unconditionally, and a table of container types
 * inside DevTools would gate every new layout component on a debug-tool change.
 */
export type LayoutControlledProperty =
  | 'x'
  | 'y'
  | 'width'
  | 'height'
  | 'scaleX'
  | 'scaleY'
  | 'rotation'
  | 'opacity';

export interface A11yAttributes {
  /** Shadow element tag to create. Defaults to `'div'`. */
  tag?: 'div' | 'a' | 'button' | 'img' | 'input' | 'textarea';
  /** ARIA role applied via the `role` attribute. */
  role?: string;
  /** Accessible name applied via `aria-label`. */
  label?: string;
  /** Explicit keyboard tab order for projected non-native interaction regions. */
  tabIndex?: number;
  /**
   * Whether the semantic shadow element participates in pointer hit testing.
   * Use `'none'` for structural containers whose selectable or interactive
   * descendants own the pointer surface. Defaults to `'auto'`.
   */
  pointerEvents?: 'auto' | 'none';
  /** Destination URL; only meaningful for `tag: 'a'`. */
  href?: string;
  /** Link target; only meaningful for `tag: 'a'`. Defaults to current window. */
  target?: string;
  /** Image source; only meaningful for `tag: 'img'`. */
  src?: string;
  /** Alternative text; only meaningful for `tag: 'img'`. */
  alt?: string;
  /** Input type (e.g. `'text'`, `'checkbox'`); only meaningful for `tag: 'input'`. */
  inputType?: string;
  /** Placeholder text; only meaningful for `tag: 'input'`. */
  placeholder?: string;
  /** Current value; refreshed each frame for `tag: 'input'` (text fields). */
  value?: string;
  /**
   * Checked state — sets `input.checked` for checkbox inputs and `aria-checked`
   * for `role: 'switch'`/`'checkbox'`. Refreshed each frame.
   */
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  haspopup?: string;
  selected?: boolean;
  activedescendant?: string;
  valuemin?: string;
  valuemax?: string;
  /**
   * ARIA live-region politeness (`aria-live`). Set on the container whose text
   * changes as content streams in (chat message, toast, async validation
   * summary) so a screen reader announces updates without moving focus.
   * `'polite'` waits for a pause; `'assertive'` interrupts. WCAG 4.1.3.
   */
  live?: 'off' | 'polite' | 'assertive';
  /** `aria-atomic`: announce the whole region on change, not just the diff. */
  atomic?: boolean;
  /** `aria-relevant`: which mutation types to announce (e.g. `'additions text'`). */
  relevant?: string;
  /** `aria-labelledby`: id(s) of the element(s) that label this one. */
  labelledby?: string;
  /** `aria-describedby`: id(s) of the element(s) that describe this one. */
  describedby?: string;
  /** `aria-required`: the field must be filled before submit. */
  required?: boolean;
  /** `aria-invalid`: the field's current value fails validation. */
  invalid?: boolean;
  /** `aria-level`: hierarchical level (headings, tree items, etc.). */
  /**
   * Position within a set, 1-based — projected as `aria-posinset`.
   *
   * Required whenever the DOM contains only part of the set, which is exactly
   * what virtualization produces: a list rendering rows 40-52 of 10,000 otherwise
   * announces "item 3 of 12", because that is all the accessibility tree can see.
   * Pair with {@link setSize}.
   */
  posInSet?: number;

  /**
   * Total size of the set the element belongs to — projected as `aria-setsize`.
   *
   * `-1` is the ARIA-defined value for "unknown but non-empty", appropriate for a
   * lazily loaded set whose total is not yet known.
   */
  setSize?: number;

  /**
   * Total row count of a grid whose DOM holds only the visible rows — projected
   * as `aria-rowcount`. Same rationale as {@link posInSet}: a virtualized table
   * needs to state the real total, not the rendered one.
   */
  rowCount?: number;

  /** 1-based row index within the full grid — projected as `aria-rowindex`. */
  rowIndex?: number;

  /**
   * Human-readable form of a range widget's current value — projected as
   * `aria-valuetext`.
   *
   * A bare `aria-valuenow` is announced as a number out of context: "40" rather
   * than "40 percent" or "Medium". Only set this when the number alone is
   * genuinely ambiguous; a redundant valuetext makes announcements longer for no
   * gain.
   */
  valueText?: string;

  /**
   * Orientation of a composite widget — projected as `aria-orientation`.
   *
   * Worth setting when it differs from the role's default (`slider` and
   * `separator` default horizontal; `listbox`, `menu`, `tree` default vertical),
   * because it tells assistive technology which arrow keys to expect.
   */
  orientation?: 'horizontal' | 'vertical';

  level?: number;
  /** `aria-modal`: marks a `role="dialog"` as modal so assistive tech confines
   *  reading to it. Set on a modal dialog's shell. */
  ariaModal?: 'true' | 'false';
  /** Explicit native editor typography; ignored for non-input elements. */
  textInputStyle?: TextInputStyle;
}

/**
 * Union of all pointer/interaction events that can be emitted by an {@link Entity}.
 */
export type VectoEvent =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'pointerdown'
  | 'pointerup'
  | 'pointercancel'
  | 'pointermove'
  | 'pointerleave'
  // Emitted from a form-control shadow node (`<input>`) when its value/checked
  // changes; payload `{ value, checked, selectionStart, selectionEnd, composition }`
  // where `composition` is `{ start, length } | null` for the active IME pre-edit.
  | 'change'
  // Emitted when the shadow `<input>` gains/loses focus (caret blink, etc.).
  | 'focus'
  | 'blur'
  // Mouse-wheel / trackpad scroll over the entity's shadow node; payload is the
  // native `WheelEvent` (call `preventDefault()` to stop the page scrolling).
  | 'wheel'
  // The entity's shadow node scrolled itself — a wheel gesture, a drag on its
  // scrollbar, or the browser scrolling a caret back into view. Payload is a
  // {@link ScrollEventPayload}. This is the only way an entity can observe the
  // scroll offset the browser chose for its mirror, which a canvas mirroring a
  // native editor must follow or its drawn text drifts from the offsets the
  // element reports for a click.
  | 'scroll'
  | 'keydown'
  | 'keyup';

/**
 * Payload of the {@link VectoEvent} `'scroll'`: the scroll geometry of an
 * entity's accessibility/automation shadow node, in CSS pixels.
 *
 * An entity that paints its own view of scrollable content (a text editor, a
 * list) should treat these as authoritative while the mirror exists — the
 * browser resolved them against the same content, and any offset the element
 * reports (`selectionStart` from a click) is relative to them.
 */
export interface ScrollEventPayload {
  /** The mirror's vertical scroll offset. */
  scrollTop: number;
  /** The mirror's horizontal scroll offset. */
  scrollLeft: number;
  /** Full scrollable content height, including the part out of view. */
  scrollHeight: number;
  /** Full scrollable content width, including the part out of view. */
  scrollWidth: number;
  /** Visible height inside the mirror's padding box (excludes any scrollbar). */
  clientHeight: number;
  /** Visible width inside the mirror's padding box (excludes any scrollbar). */
  clientWidth: number;
}

/** Options for {@link Entity.on} / {@link Entity.off}. */
export interface ListenerOptions {
  /** Register the listener for the capture phase (root→target) instead of bubble. */
  capture?: boolean;
}

/**
 * A propagating event dispatched through the entity tree by
 * {@link Entity.dispatchEvent} (DOM-like capture + bubble).
 *
 * It wraps the originating browser event (`nativeEvent`) and adds tree-aware
 * fields: `target` (where it originated), `currentTarget` (the node currently
 * handling it), and `stopPropagation()`. Common native fields (`deltaY`,
 * `clientX`, `key`, …) and `preventDefault()` pass through to `nativeEvent`, so
 * handlers written against the raw DOM event keep working.
 */
export class VectoJSEvent<N = unknown> {
  /** The event name. */
  readonly type: VectoEvent;
  /** The entity the event originated on. */
  readonly target: Entity;
  /** The entity whose listeners are currently running (updated per node). */
  currentTarget: Entity;
  /** The wrapped browser event, if any. */
  readonly nativeEvent: N | undefined;
  /** Whether the event bubbles past its target (capture always runs). */
  readonly bubbles: boolean;
  private readonly explicitScenePoint: Point | undefined;
  private stopped = false;
  private stoppedImmediate = false;

  constructor(
    type: VectoEvent,
    target: Entity,
    nativeEvent?: N,
    bubbles: boolean = true,
    scenePoint?: Point,
  ) {
    this.type = type;
    this.target = target;
    this.currentTarget = target;
    this.nativeEvent = nativeEvent;
    this.bubbles = bubbles;
    this.explicitScenePoint = scenePoint;
  }

  /** Stop the event from reaching the next node in the propagation path. */
  stopPropagation(): void {
    this.stopped = true;
  }

  /** Stop propagation AND skip any remaining listeners on the current node. */
  stopImmediatePropagation(): void {
    this.stopped = true;
    this.stoppedImmediate = true;
  }

  /** Forward to the native event's `preventDefault` (e.g. stop page scroll). */
  preventDefault(): void {
    (this.nativeEvent as { preventDefault?: () => void })?.preventDefault?.();
  }

  /** Whether {@link stopPropagation} has been called. */
  get propagationStopped(): boolean {
    return this.stopped;
  }

  /** Whether {@link stopImmediatePropagation} has been called. */
  get immediatePropagationStopped(): boolean {
    return this.stoppedImmediate;
  }

  /** Whether the native event's default action was prevented. */
  get defaultPrevented(): boolean {
    return !!(this.nativeEvent as { defaultPrevented?: boolean })?.defaultPrevented;
  }

  /** Native horizontal wheel delta, if this wraps a `WheelEvent`. */
  get deltaX(): number | undefined {
    return (this.nativeEvent as { deltaX?: number })?.deltaX;
  }

  /** Native vertical wheel delta, if this wraps a `WheelEvent`. */
  get deltaY(): number | undefined {
    return (this.nativeEvent as { deltaY?: number })?.deltaY;
  }

  /** Native wheel delta mode (0=pixels, 1=lines, 2=pages), if this wraps a `WheelEvent`. */
  get deltaMode(): number | undefined {
    return (this.nativeEvent as { deltaMode?: number })?.deltaMode;
  }

  /** Native pointer X, if this wraps a pointer/mouse event. */
  get clientX(): number | undefined {
    return (this.nativeEvent as { clientX?: number })?.clientX;
  }

  /** Native pointer Y, if this wraps a pointer/mouse event. */
  get clientY(): number | undefined {
    return (this.nativeEvent as { clientY?: number })?.clientY;
  }

  private get resolvedScenePoint(): Point | undefined {
    if (this.explicitScenePoint) return this.explicitScenePoint;
    const native = this.nativeEvent as
      | {
          clientX?: number;
          clientY?: number;
          vectoSceneX?: number;
          vectoSceneY?: number;
        }
      | undefined;
    if (native?.vectoSceneX !== undefined && native.vectoSceneY !== undefined) {
      return { x: native.vectoSceneX, y: native.vectoSceneY };
    }
    if (native?.clientX === undefined || native.clientY === undefined) return undefined;
    const scene = this.target.scene as {
      clientToScene?: (clientX: number, clientY: number) => Point;
    } | null;
    return (
      scene?.clientToScene?.(native.clientX, native.clientY) ?? {
        x: native.clientX,
        y: native.clientY,
      }
    );
  }

  /** Pointer X in the Scene's logical coordinate space. */
  get sceneX(): number | undefined {
    return this.resolvedScenePoint?.x;
  }

  /** Pointer Y in the Scene's logical coordinate space. */
  get sceneY(): number | undefined {
    return this.resolvedScenePoint?.y;
  }

  /** Pointer X local to the entity whose listener is currently running. */
  get localX(): number | undefined {
    const point = this.resolvedScenePoint;
    if (!point) return undefined;
    return this.currentTarget.worldToLocal(point.x, point.y)?.x;
  }

  /** Pointer Y local to the entity whose listener is currently running. */
  get localY(): number | undefined {
    const point = this.resolvedScenePoint;
    if (!point) return undefined;
    return this.currentTarget.worldToLocal(point.x, point.y)?.y;
  }

  get shiftKey(): boolean {
    return !!(this.nativeEvent as { shiftKey?: boolean })?.shiftKey;
  }

  get ctrlKey(): boolean {
    return !!(this.nativeEvent as { ctrlKey?: boolean })?.ctrlKey;
  }

  get altKey(): boolean {
    return !!(this.nativeEvent as { altKey?: boolean })?.altKey;
  }

  get metaKey(): boolean {
    return !!(this.nativeEvent as { metaKey?: boolean })?.metaKey;
  }

  /** Native key, if this wraps a keyboard event. */
  get key(): string | undefined {
    return (this.nativeEvent as { key?: string })?.key;
  }
}

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
export abstract class Entity {
  /**
   * Whether Scene may ask {@link getRenderChildRange} to prune this entity's
   * visual child traversal. Off by default so ordinary containers pay no
   * viewport-inversion cost.
   */
  public viewportCullChildren = false;
  public id: string;
  public children: Entity[] = [];
  public parent: Entity | null = null;

  /**
   * Walk up the parent chain to find the scene this entity is currently attached to.
   */
  public get scene(): any {
    if ((this as any)._scene) return (this as any)._scene;
    return this.parent ? this.parent.scene : null;
  }

  private _x = 0;
  private _y = 0;
  private _scaleX = 1;
  private _scaleY = 1;
  private _rotation = 0;
  private _opacity = 1;

  // Fast-path flag: false for the overwhelming majority of entities (incl. the
  // Danmaku hot loop), so a bare `entity.x = v` is one boolean check + field write.
  private _hasTransitions = false;
  private _transitions: Map<AnimatableProp, MotionConfig> | null = null;
  // Lazily allocated: null until first use. A scene of many passive entities
  // (particles, data points) never touches these, so paying an empty-Map/array
  // allocation per entity in the constructor is pure waste at scale.
  private _drivers: Map<AnimatableProp, PropertyDriver> | null = null;
  private _mounted = false;
  private _destroyed = false;

  // Frame this entity's active drivers were last advanced by Scene's batched
  // WASM animation pass (see Scene._tickBatchedDrivers), or -1 if never. When
  // it equals the current frame, tickDrivers() must skip its own tick loop —
  // otherwise a driver already advanced by the batch pass would be ticked a
  // second time by the normal per-entity update() walk in the same frame.
  // Irrelevant (and harmless) for entities never touched by WASM batching.
  public _driversTickedFrame = -1;

  // Cached cos/sin, recomputed only when rotation actually changes. renderNode
  // and getWorldTransform() both read this instead of calling Math.cos/sin per
  // entity per frame (V8's are ~2.5x slower than other engines).
  private readonly _trig = { cos: 1, sin: 0 };
  private _trigRotation = Number.NaN; // NaN !== any rotation -> first read computes

  // Per-frame world-matrix cache. Written by Scene during the render walk;
  // getWorldTransform() returns it only while `_worldFrame === scene.currentFrame`
  // and otherwise falls back to the full ancestor walk, so it can never return a
  // stale/wrong transform — only sometimes miss the fast path.
  private _wa = 1;
  private _wb = 0;
  private _wc = 0;
  private _wd = 1;
  private _we = 0;
  private _wf = 0;
  private _worldFrame = -1;

  // Slot in the Scene's resident WASM transform store, or -1 when this entity is
  // not in that store (JS transform path, overlay/detached, or before the first
  // structural rebuild). Assigned by Scene on a structural rebuild; the Scene
  // validates it against its slot table before trusting it, so a stale value can
  // only cost a JS-path fallback, never a wrong read.
  public _storeSlot = -1;

  public get x(): number {
    return this._x;
  }
  public set x(v: number) {
    if (this._hasTransitions) this._animateProp('x', v);
    else this._x = v;
  }
  public get y(): number {
    return this._y;
  }
  public set y(v: number) {
    if (this._hasTransitions) this._animateProp('y', v);
    else this._y = v;
  }
  public get scaleX(): number {
    return this._scaleX;
  }
  public set scaleX(v: number) {
    if (this._hasTransitions) this._animateProp('scaleX', v);
    else this._scaleX = v;
  }
  public get scaleY(): number {
    return this._scaleY;
  }
  public set scaleY(v: number) {
    if (this._hasTransitions) this._animateProp('scaleY', v);
    else this._scaleY = v;
  }
  public get rotation(): number {
    return this._rotation;
  }
  public set rotation(v: number) {
    if (this._hasTransitions) this._animateProp('rotation', v);
    else this._rotation = v;
  }
  public get opacity(): number {
    return this._opacity;
  }
  public set opacity(v: number) {
    if (this._hasTransitions) this._animateProp('opacity', v);
    else this._opacity = v;
  }
  public isDOMPortal: boolean = false;
  private _interactive: boolean = false;
  public get interactive(): boolean {
    return this._interactive;
  }
  public set interactive(val: boolean) {
    if (this._interactive !== val) {
      this._interactive = val;
      const s = this.scene;
      if (s) {
        s.a11yNeedsReorder = true;
        s.markDirty({ entity: this.id, reason: 'a11y-reorder' });
      }
    }
  }
  public width: number = 0;
  public height: number = 0;
  public a11yOffsetX: number = 0;
  public a11yOffsetY: number = 0;
  /**
   * Opt in to a viewport-filling accessibility/automation shadow node even when
   * this entity has no intrinsic box (`width`/`height` of `0`). Use for
   * full-screen, boundless interaction surfaces (e.g. an infinite-canvas graph)
   * that need global pointer events. The node is mounted behind all other shadow
   * nodes, so on-top components stay clickable.
   */
  public a11yFullViewport: boolean = false;

  /**
   * When this entity's a11y shadow node is materialized.
   *
   * `'eager'` (the default) keeps today's behaviour: a shadow node exists for as
   * long as the entity is `interactive` with a box. That is right for a button or
   * a link, and wrong for thousands of ephemeral, individually-meaningless
   * entities — particles, danmaku, graph nodes — where it produces one DOM node
   * per entity every frame.
   *
   * Measured on 5,000 moving interactive entities (`benchmarks/lazy-a11y/`):
   * eager costs **72.2 ms/frame on Chrome and 114.3 ms on Firefox**, missing even
   * 60 Hz, against **1.55/1.63 ms** for the same scene with one node projected —
   * within noise of the 1.26/1.65 ms floor of projecting nothing at all.
   *
   * `'onDemand'` projects a node only while {@link Scene} considers the entity
   * *engaged*: it is focused, it is the current pointer target, or it has been
   * explicitly requested via {@link Scene.requestA11yProjection}. Crucially the
   * trigger is not hover alone — a keyboard or assistive-technology user
   * generates no hover, so a hover-only gate would remove exactly those users'
   * access. Engagement therefore includes focus and an explicit request, and the
   * entity stays hit-testable on canvas throughout, so a click still reaches it
   * and promotes it.
   *
   * `'never'` suppresses the node entirely. Prefer `interactive = false` unless
   * the entity genuinely needs to stay hit-testable without any semantic
   * presence — this exists so a purely decorative interactive surface can opt
   * out of the a11y tree.
   *
   * **Pointer input is routed through the projected mirror.** The engine binds
   * `pointerdown`/`pointermove`/`pointerup`/`click`/`dblclick` to each shadow
   * element (the canvas itself only tracks `mouseX`/`mouseY`), so an entity
   * with no materialized node receives **no pointer events at all** — neither
   * in `'never'` mode nor in `'onDemand'` before it is engaged (focused,
   * pointer target, or `requestA11yProjection`). Canvas hit-testing exists
   * (`Scene.findEntityAt`) but is a query API, not a dispatch path. For a
   * pointer-reactive region with no role (e.g. a desktop click-catcher), use
   * `'eager'` + `a11yFullViewport` + `tabIndex: -1` with a role-less
   * `getA11yAttributes()`: the mirror is AT-invisible but pointer-visible.
   *
   * **This does not replace an aggregate description.** A thousand `'onDemand'`
   * danmaku are individually reachable but say nothing collectively. The proven
   * pattern is one aggregate live region (`role: 'status'`, `a11yFullViewport`)
   * plus a small pool of persistent hotspots for the current selection — see
   * `vectojs-native/danmaku`. Use `'onDemand'` to stop paying per entity, not as
   * the whole accessibility story.
   */
  public a11yProjection: 'eager' | 'onDemand' | 'never' = 'eager';

  /**
   * Hide this entity AND its whole subtree from the accessibility/automation
   * projection, regardless of each node's own `interactive` flag.
   *
   * For a container that is logically closed while still mounted — an `Overlay`
   * after `hide()`, a collapsed panel kept in the tree for its transition. Setting
   * `interactive = false` on the container alone is not enough: the projection walk
   * still descends, and any still-interactive child is re-created on the next
   * frame. Measured before this existed: after `Popover.hide()` the popover's own
   * element was gone while its button stayed projected with `tabIndex: 0` and a
   * live box, so a keyboard user could Tab into a hidden popover.
   *
   * Deliberately NOT inferred from `opacity`: `Overlay.hide()` springs opacity
   * toward 0, so mid-transition it reads nonzero (~0.26 when measured) and an
   * `=== 0` test never fires; a threshold would instead silently un-project a
   * faint-but-live control.
   */
  public a11yHidden: boolean = false;
  /**
   * Clip this node's children to its local box (`[0,0]–[width,height]`) while
   * rendering. Combined with translating a content child, this is how
   * scroll/overflow containers (e.g. `ScrollView`) keep their content inside a
   * fixed viewport. Off by default (children render unclipped). Canvas2D only.
   */
  public clipChildren: boolean = false;

  /**
   * Group this subtree's projected text into its own accessibility **region**,
   * without clipping anything.
   *
   * The projection sorts every mirror into visual reading order, and it bands
   * them into rows per region so that side-by-side columns stay contiguous runs
   * in the DOM. That matters beyond reading order: a native `Selection` covers
   * everything between its anchor and focus in DOM order, so two columns banded
   * together let a vertical drag through one of them swallow the other.
   *
   * {@link clipChildren} also establishes a region, because a clipper is
   * usually the column boundary you want. Reach for this flag when the two
   * needs come apart — a sidebar, a card deck or any column that must not be
   * absorbed by its neighbour's drag, but that draws nothing and has no reason
   * to clip. Measured in a real app before this existed: a table-of-contents
   * sidebar had to switch `clipChildren` on purely to escape the body column's
   * bands, buying a per-frame `save`/`clip`/`restore` for an entity that paints
   * nothing.
   *
   * Unlike `clipChildren`, this is honoured regardless of the node's box. The
   * zero-area exemption on the clipping path exists because a zero-area clipper
   * clips nothing; grouping is a declaration of intent that never consults
   * geometry, and a pure grouping container often leaves `width`/`height` at 0.
   *
   * Off by default. Regions nest: the nearest enclosing region wins.
   */
  public a11yRegion: boolean = false;

  // Lazily allocated (see _drivers above). Most entities never register a
  // listener or an imperative animate() tween.
  protected listeners: Map<VectoEvent, Array<(e: any) => void>> | null = null;
  /** Capture-phase listeners (fired root→target before bubble). */
  protected captureListeners: Map<VectoEvent, Array<(e: any) => void>> | null = null;
  private animations: Array<any> | null = null;

  constructor(id?: string) {
    this.id = id || `entity_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Append a child entity to this node's children array.
   *
   * If `child` already has a parent (including `this`), it's detached from it
   * first — otherwise re-adding an already-added child duplicates it in
   * `children[]` (one `remove()` call only strips the first occurrence,
   * leaving a stale entry that keeps rendering/updating despite
   * `child.parent` reporting `null`), and re-parenting to a different entity
   * without an explicit `remove()` first leaves the old parent holding a
   * stale reference whose own `.parent` disagrees with where it now lives.
   * `child.parent` is only ever `null` or `this`'s ultimate owner, so this
   * check is O(1) for the overwhelming common case (a brand-new entity).
   *
   * Accepts multiple children in one call (`parent.add(a, b, c)`); each is
   * attached in argument order with the same detach-then-attach semantics.
   *
   * @param children - One or more entities to add as children.
   * @returns `this` for method chaining.
   */
  public add(...children: Entity[]): this {
    for (const child of children) this._addOne(child);
    return this;
  }

  /** Attach a single child (the O(1) common path). See {@link add}. */
  private _addOne(child: Entity): void {
    // Cycle guard: re-parenting one of this entity's own ancestors (or itself)
    // under it would close a loop that overflows the pre-order update/render
    // walks on the next frame. The DOM throws HierarchyRequestError for the
    // same operation; a plain Error keeps core DOM-free. O(depth) — add is
    // rare next to per-frame work.
    if (child === this) {
      throw new Error(`Entity.add(): cannot add entity "${child.id}" under itself.`);
    }
    let ancestor: Entity | null = this.parent;
    while (ancestor) {
      if (ancestor === child) {
        throw new Error(
          `Entity.add(): cannot add entity "${child.id}" under "${this.id}" — ` +
            'an entity cannot be added under its own descendant.',
        );
      }
      ancestor = ancestor.parent;
    }
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
    const s = this.scene;
    if (s) {
      s.a11yNeedsReorder = true;
      s.markStructureChanged?.(); // WASM transform store layout must be rebuilt
      s.markDirty({ entity: this.id, reason: 'child-added' });
      child._notifyMounted(); // fire onMounted for the newly-live subtree
      // Resume batched drivers the subtree had in flight when it was detached —
      // the mirror of the unregister in remove(), so re-attaching a subtree
      // removed mid-animation keeps its motion on the batch path. Optional like
      // markStructureChanged: a minimal scene stand-in (tests) may omit it.
      s._registerActiveDriverSubtree?.(child);
    }
  }

  /** Called once when this entity becomes attached to a live Scene. Override to react. */
  protected onMounted(): void {}

  /** Fire onMounted for this node and its descendants, guarded against double-fire. */
  private _notifyMounted(): void {
    if (this._mounted) return;
    this._mounted = true;
    this.onMounted();
    for (const c of this.children) c._notifyMounted();
  }

  /**
   * Remove a child entity from this node.
   *
   * @param child - The entity to remove.
   * @returns `this` for method chaining.
   */
  public remove(child: Entity): this {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parent = null;
      const s = this.scene;
      if (s) {
        s.detachA11y(child);
        s.a11yNeedsReorder = true;
        s.markStructureChanged?.(); // WASM transform store layout must be rebuilt
        s.markDirty({ entity: this.id, reason: 'child-removed' });
        // Drop the off-tree subtree from the batched-driver candidate set, or
        // its drivers keep ticking every frame until they complete (and pin the
        // entities in the Set meanwhile). The mirror call in _addOne resumes
        // them if the subtree is re-attached before its drivers settle.
        s._unregisterActiveDriverSubtree?.(child);
      }
    }
    return this;
  }

  /**
   * Assign several own properties in one call, each through its normal setter
   * (so a property with a configured {@link setTransition} still animates, and
   * `interactive` still flags the scene for a11y reorder). A construction-time
   * ergonomic only — it is a plain `for…in` over the given object and touches
   * no per-frame path.
   *
   * @param props - Partial set of this entity's own properties to assign.
   * @returns `this` for method chaining.
   * @example rect.set({ x: 40, y: 40, width: 120, fill: '#38bdf8' });
   */
  public set(props: Partial<this>): this {
    for (const key in props) {
      const value = props[key as keyof this];
      if (value !== undefined) this[key as keyof this] = value as this[keyof this];
    }
    return this;
  }

  /**
   * Set the local position of this entity.
   *
   * @param x - Horizontal position in local space.
   * @param y - Vertical position in local space.
   * @returns `this` for method chaining.
   * @example entity.setPosition(100, 200);
   */
  public setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

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
  public animate(targetProps: Partial<this>, durationMs: number): this {
    // A zero, negative, or non-finite duration cannot interpolate: the first
    // update would compute progress = 0/duration as NaN or a negative value,
    // writing NaN into animated properties and never satisfying the
    // `progress >= 1` dequeue guard (permanently jamming the queue). Treat
    // degenerate durations as an immediate terminal write of the targets.
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      for (const key in targetProps) {
        const end = targetProps[key];
        if (typeof end !== 'number') continue;
        if (ANIMATABLE_PROPS.has(key as AnimatableProp)) {
          this._applyAnimated(key as AnimatableProp, end);
        } else {
          (this as any)[key] = end;
        }
      }
      this.scene?.markDirty({ entity: this.id, reason: 'animation-start' });
      return this;
    }
    (this.animations ??= []).push({
      target: targetProps,
      duration: durationMs,
      startTime: -1,
      startProps: {},
    });
    // Wake an idle scene: the loop's animation flags are collected during the
    // render walk, so a sleeping onDemand scene needs the dirty signal.
    this.scene?.markDirty({ entity: this.id, reason: 'animation-start' });
    return this;
  }

  /** Write a driver-computed value to a backing field without re-triggering the setter. */
  private _applyAnimated(prop: AnimatableProp, v: number): void {
    switch (prop) {
      case 'x':
        this._x = v;
        break;
      case 'y':
        this._y = v;
        break;
      case 'scaleX':
        this._scaleX = v;
        break;
      case 'scaleY':
        this._scaleY = v;
        break;
      case 'rotation':
        this._rotation = v;
        break;
      case 'opacity':
        this._opacity = v;
        break;
    }
  }

  private _currentOf(prop: AnimatableProp): number {
    switch (prop) {
      case 'x':
        return this._x;
      case 'y':
        return this._y;
      case 'scaleX':
        return this._scaleX;
      case 'scaleY':
        return this._scaleY;
      case 'rotation':
        return this._rotation;
      case 'opacity':
        return this._opacity;
    }
  }

  /**
   * Write a value immediately, bypassing any configured transition. For subclasses
   * that need to seed a starting state (e.g. the presence helper's enter `from`).
   */
  protected setImmediate(prop: AnimatableProp, v: number): void {
    const existing = this._drivers?.get(prop);
    if (existing) this._settleDriver(existing);
    this._drivers?.delete(prop);
    this._applyAnimated(prop, v);
  }

  private _settleDriver(driver: PropertyDriver): void {
    const active = driver as PropertyDriver & { onDone?: () => void };
    const onDone = active.onDone;
    active.onDone = undefined;
    onDone?.();
  }

  private _spawnDriver(prop: AnimatableProp, to: number, cfg: MotionConfig): void {
    // Reduced motion: suppress movement (transforms), keep opacity fades. Snap instantly.
    if (prop !== 'opacity' && this.scene?.prefersReducedMotion) {
      const existing = this._drivers?.get(prop);
      if (existing) this._settleDriver(existing);
      this._drivers?.delete(prop);
      this._applyAnimated(prop, to);
      return;
    }
    const existing = this._drivers?.get(prop);
    if (existing) {
      // Retargeting an in-flight driver: resolve the previous Promise so callers
      // awaiting the original `animateTo`/`springTo` don't leak. The new drive
      // will get a fresh `onDone` assigned by `_driveTo`.
      this._settleDriver(existing);
      existing.retarget(to);
      return;
    }
    const from = this._currentOf(prop);
    const driver: PropertyDriver = isTweenConfig(cfg)
      ? new TweenDriver(from, to, cfg)
      : new SpringDriver(from, to, cfg === 'spring' ? {} : (cfg as SpringConfig));
    (this._drivers ??= new Map()).set(prop, driver);
    // Mid-walk catch-up: when the batched WASM pass already claimed this
    // entity earlier this frame, it stamped `_driversTickedFrame`, and this
    // entity's own `tickDrivers()` will skip its WHOLE driver map for the rest
    // of the frame — including this brand-new driver — so on the batched path
    // it would wait until next frame while the pure-JS path (never stamped)
    // ticks it same-frame. Advance it once here with the walking frame's dt so
    // both paths agree. Outside the update walk (`_updateWalkDt === null`)
    // nothing has been claimed-and-pending yet, and an unstamped entity's
    // `tickDrivers()` picks the new driver up normally.
    const s = this.scene;
    if (s && this._driversTickedFrame === s.currentFrame && s._updateWalkDt !== null) {
      driver.tick(s._updateWalkDt);
      this._applyDriverTick(prop, driver); // mirror completion/apply/settle logic
    }
    this.scene?.markDirty({ entity: this.id, reason: 'driver-added' });
    // Register with Scene's batched-driver candidate set (cheap, self-pruning
    // O(1) add — see Scene._registerActiveDriverEntity) so the WASM batch pass
    // can find active drivers without walking the whole tree every frame.
    this.scene?._registerActiveDriverEntity(this);
  }

  /** Assignment path when a declarative transition is configured for `prop`. */
  private _animateProp(prop: AnimatableProp, to: number): void {
    const cfg = this._transitions?.get(prop);
    if (!cfg) {
      this._applyAnimated(prop, to);
      return;
    }
    this._spawnDriver(prop, to, cfg);
  }

  /** Declare which properties animate, and how. Subsequent assignment animates them. */
  public setTransition(config: Partial<Record<AnimatableProp, MotionConfig>>): this {
    this._transitions ??= new Map();
    for (const [k, v] of Object.entries(config))
      this._transitions.set(k as AnimatableProp, v as MotionConfig);
    this._hasTransitions = this._transitions.size > 0;
    return this;
  }

  /** Imperative tween toward targets; resolves when all reach their end. */
  public animateTo(
    props: Partial<Record<AnimatableProp, number>>,
    cfg: TweenConfig,
  ): Promise<void> {
    return this._driveTo(props, cfg);
  }

  /** Imperative spring toward targets; resolves when all reach rest. */
  public springTo(
    props: Partial<Record<AnimatableProp, number>>,
    cfg: SpringConfig = {},
  ): Promise<void> {
    return this._driveTo(props, cfg);
  }

  private _driveTo(
    props: Partial<Record<AnimatableProp, number>>,
    cfg: MotionConfig,
  ): Promise<void> {
    const entries = Object.entries(props) as [AnimatableProp, number][];
    return Promise.all(
      entries.map(
        (e) =>
          new Promise<void>((resolve) => {
            this._spawnDriver(e[0], e[1], cfg);
            const d = this._drivers?.get(e[0]) as
              | (PropertyDriver & { onDone?: () => void })
              | undefined;
            if (!d)
              resolve(); // spawn resolved instantly (e.g. reduced motion) -> no driver
            else d.onDone = resolve;
          }),
      ),
    ).then(() => undefined);
  }

  /** Advance active property drivers one frame. Call from update(). */
  protected tickDrivers(dt: number): void {
    if (!this._drivers || this._drivers.size === 0) return;
    // Scene's batched WASM animation pass (if enabled and its driver-count gate
    // is open) already advanced every driver on this entity earlier this same
    // frame — ticking again here would double-advance them. See
    // _driversTickedFrame's own comment for why this can never mask a real
    // frame drop: the stamp only ever matches the CURRENT frame.
    if (this.scene && this._driversTickedFrame === this.scene.currentFrame) return;
    for (const [prop, driver] of this._drivers) {
      driver.tick(dt);
      if (driver.isDone()) {
        this._applyAnimated(prop, driver.target); // snap exactly to target on completion
        this._settleDriver(driver);
        this._drivers.delete(prop);
      } else {
        this._applyAnimated(prop, driver.value);
      }
    }
    // The per-frame driver tick: this is the single most common reason an
    // `onDemand` scene never sleeps, so it is worth attributing precisely.
    this.scene?.markDirty({ entity: this.id, reason: 'driver-tick' });
  }

  /**
   * Internal: this entity's active-driver map (read-only view), or `null` if
   * it has none. Called only by Scene's batched WASM animation pass, never
   * application code. Returns the Map directly (not a callback iteration) so
   * a caller can `for...of` it with zero per-entity closure allocation — the
   * integrated benchmark (benchmarks/anim-wasm-scene) found a fresh callback
   * per entity per frame was a real cost, not a negligible one.
   */
  public _driverEntries(): ReadonlyMap<AnimatableProp, PropertyDriver> | null {
    return this._drivers;
  }

  /**
   * Internal: finalize one driver that was ALREADY advanced externally this
   * frame (e.g. by Scene's batched WASM tick via `driver.syncExternal`, or a
   * direct `driver.tick()` call for a driver the batch can't offload) —
   * exactly mirrors tickDrivers()'s own per-driver completion logic, so a
   * driver behaves identically regardless of which path ticked it. Called
   * only by Scene, never application code.
   */
  public _applyDriverTick(prop: AnimatableProp, driver: PropertyDriver): void {
    if (driver.isDone()) {
      this._applyAnimated(prop, driver.target);
      this._settleDriver(driver);
      this._drivers?.delete(prop);
    } else {
      this._applyAnimated(prop, driver.value);
    }
  }

  /**
   * Advance the entity's internal state for one frame.
   *
   * Called automatically by the {@link Scene} render loop — override in
   * subclasses to implement custom per-frame logic.
   *
   * @param dt - Elapsed time since the last frame in milliseconds.
   * @param time - Absolute timestamp from `performance.now()`.
   */
  public update(dt: number, time: number): void {
    this.tickDrivers(dt);
    if (this.animations && this.animations.length > 0) {
      const anim = this.animations[0];
      if (anim.startTime === -1) {
        anim.startTime = time;
        for (const key in anim.target) {
          anim.startProps[key] = (this as any)[key];
        }
      }

      const progress = Math.min((time - anim.startTime) / anim.duration, 1);

      for (const key in anim.target) {
        const start = anim.startProps[key];
        const end = anim.target[key];
        if (typeof start === 'number' && typeof end === 'number') {
          const easeOut = progress * (2 - progress);
          const value = start + (end - start) * easeOut;
          // Write transform props past the public setter: with a declarative
          // transition configured, the setter would spawn/retarget a driver
          // every frame and the two animation systems would fight.
          if (ANIMATABLE_PROPS.has(key as AnimatableProp)) {
            this._applyAnimated(key as AnimatableProp, value);
          } else {
            (this as any)[key] = value;
          }
        }
      }

      if (progress >= 1) {
        this.animations.shift();
      }
    }
  }

  /**
   * Register a listener for a {@link VectoEvent}.
   *
   * Listeners run in the bubble phase by default; pass `{ capture: true }` for the
   * capture phase (root→target). Bubble listeners also fire for the legacy
   * {@link emit} (direct, self-only) path.
   *
   * @param event - The event name to listen for.
   * @param callback - Handler invoked when the event fires.
   * @param options - `{ capture }` to register for the capture phase.
   * @returns `this` for method chaining.
   * @example entity.on('click', (e) => console.log('clicked', e));
   */
  public on(event: VectoEvent, callback: (e: any) => void, options?: ListenerOptions): this {
    const map = options?.capture
      ? (this.captureListeners ??= new Map())
      : (this.listeners ??= new Map());
    if (!map.has(event)) {
      map.set(event, []);
    }
    map.get(event)!.push(callback);
    return this;
  }

  /**
   * Remove a previously registered event listener.
   *
   * @param event - The event name to stop listening to.
   * @param callback - The exact handler reference passed to {@link on}.
   * @param options - Must match the phase the listener was registered with.
   * @returns `this` for method chaining.
   */
  public off(event: VectoEvent, callback: (e: any) => void, options?: ListenerOptions): this {
    const handlers = (options?.capture ? this.captureListeners : this.listeners)?.get(event);
    if (handlers) {
      const idx = handlers.indexOf(callback);
      if (idx !== -1) handlers.splice(idx, 1);
    }
    return this;
  }

  /**
   * Tear down this entity **and its entire subtree**: recursively destroy every
   * descendant (leaf-first), clear all animations, event listeners, and property
   * drivers, then detach from the parent. Call before discarding an entity to
   * prevent memory leaks.
   *
   * Recursing here is what frees a subtree's GPU buffers, layout workers, and DOM
   * observers when an app does `entity.destroy()` or `scene.remove(subtree)` on a
   * route change — without it, only the root's own state was released and every
   * descendant (and its subclass resources) was stranded. Subclasses that own
   * external resources override `destroy()`, free their resource, then call
   * `super.destroy()`; because children don't depend on a parent's resource, the
   * order (parent resource first, then descendants) is safe.
   *
   * Idempotent and re-entrancy safe: a second call is a no-op, and because each
   * child is detached as it is destroyed, destroying a subtree never double-frees.
   */
  public destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    // Leaf-first: tear down descendants before releasing our own state. Destroy
    // from the end so each child's self-detach (`parent.remove(this)`) mutates
    // the tail of the array we're not iterating past — no snapshot needed and no
    // index skew.
    while (this.children.length > 0) {
      this.children.at(-1)!.destroy();
    }
    this.animations = null;
    // Settle in-flight property drivers so promises returned by
    // animateTo/springTo resolve instead of hanging forever.
    if (this._drivers) {
      for (const driver of this._drivers.values()) {
        this._settleDriver(driver);
      }
      this._drivers.clear();
    }
    this.listeners?.clear();
    this.captureListeners?.clear();
    if (this.parent) {
      this.parent.remove(this);
    }
  }

  /**
   * Dispatch a {@link VectoEvent} directly to this entity's bubble-phase listeners
   * only — no tree propagation. Kept for component-internal/self events (e.g. a
   * form control emitting its own `change`); use {@link dispatchEvent} for the
   * capture/bubble path.
   *
   * @param event - The event name to dispatch.
   * @param payload - Arbitrary data forwarded to each listener.
   */
  public emit(event: VectoEvent, payload: any): void {
    const handlers = this.listeners?.get(event);
    if (handlers) {
      handlers.forEach((h) => h(payload));
    }
  }

  /**
   * Programmatically focus the entity's projected a11y shadow element, if one
   * exists. After `scene.add(entity)` the shadow element is typically created
   * on the next a11y sync (within one animation frame), so this method retries
   * once on the next rAF if the element isn't immediately available — matching
   * the timing pattern the prior workaround described in findings.md achieved
   * with `requestAnimationFrame(() => document.getElementById(id)?.focus())`.
   */
  public focus(): void {
    const el = this.scene?.getA11yElement(this.id);
    if (el) {
      el.focus();
      return;
    }
    // Element not yet projected — retry once after the next frame (by which
    // time Scene.syncA11y should have processed this entity).
    requestAnimationFrame(() => {
      const retry = this.scene?.getA11yElement(this.id);
      if (retry) retry.focus();
    });
  }

  /** Run one node's listeners for the event, honoring stopImmediatePropagation. */
  private fireListeners(
    node: Entity,
    map: Map<VectoEvent, Array<(e: any) => void>> | null,
    event: VectoJSEvent,
  ): void {
    const handlers = map?.get(event.type);
    if (!handlers) return;
    event.currentTarget = node;
    // Snapshot so a handler that adds/removes listeners doesn't disturb this pass.
    for (const h of handlers.slice()) {
      h(event);
      if (event.immediatePropagationStopped) return;
    }
  }

  /**
   * Dispatch a {@link VectoJSEvent} through the entity tree, DOM-style: a capture
   * phase from the root down to `event.target`, then a bubble phase back up to the
   * root. `event.stopPropagation()` halts the walk; `stopImmediatePropagation()`
   * also skips the remaining listeners on the current node. A non-bubbling event
   * only fires its target in the bubble phase (capture still runs).
   *
   * @param event - The event to propagate (its `target` defines the path).
   */
  public dispatchEvent(event: VectoJSEvent): void {
    // Build the path target → root.
    const path: Entity[] = [];
    for (let n: Entity | null = event.target; n; n = n.parent) path.push(n);

    // Capture: root → target.
    for (let i = path.length - 1; i >= 0; i--) {
      if (event.propagationStopped) return;
      this.fireListeners(path[i], path[i].captureListeners, event);
    }
    // Bubble: target → root.
    for (let i = 0; i < path.length; i++) {
      if (event.propagationStopped) return;
      this.fireListeners(path[i], path[i].listeners, event);
      if (!event.bubbles) return; // non-bubbling: only the target gets the bubble phase
    }
  }

  /**
   * Compute the entity's position in world/canvas space by accumulating
   * local offsets up the scene-graph hierarchy using affine transformations (scale and rotation).
   *
   * @returns World-space {@link Point} for this entity.
   */
  public getGlobalPosition(): Point {
    return this.localToWorld(0, 0);
  }

  /**
   * Internal: read this entity's cached world matrix into `out` — the SAME
   * cache {@link getWorldTransform} reads — without allocating a wrapper
   * object. Returns `false` (leaving `out` untouched) when the cache isn't
   * valid for `frame` (typically the caller's `scene.currentFrame`), exactly
   * mirroring {@link getWorldTransform}'s own validity check; the caller
   * falls back to {@link getWorldTransform}'s full walk in that case. Exists
   * so a per-entity gather that runs every entity through this (e.g. G3's
   * `gatherHitAABBs`) pays for six scalar reads instead of one object
   * allocation per entity per call — the exact class of per-frame garbage
   * the G2 integrated benchmark found dominating its own gather cost.
   */
  public _readWorldCache(frame: number, out: AffineTransform): boolean {
    if (this._worldFrame < 0 || this._worldFrame !== frame) return false;
    out.a = this._wa;
    out.b = this._wb;
    out.c = this._wc;
    out.d = this._wd;
    out.e = this._we;
    out.f = this._wf;
    return true;
  }

  /**
   * Return the exact accumulated Canvas `T * S * R` transform for this entity.
   */
  public getWorldTransform(): AffineTransform {
    // Fast path: Scene wrote this entity's world matrix during the current
    // frame's render walk, so return it instead of re-walking the ancestor
    // chain. Gated on the exact frame counter — a stale cache (entity not
    // rendered this frame, or queried between frames) fails the check and
    // falls through to the authoritative walk below, so this can only ever
    // skip work, never return a wrong transform.
    if (this._worldFrame >= 0) {
      const s = this.scene;
      if (s && this._worldFrame === s.currentFrame) {
        return {
          a: this._wa,
          b: this._wb,
          c: this._wc,
          d: this._wd,
          e: this._we,
          f: this._wf,
        };
      }
    }

    // Walk all the way to the true top of the tree (Scene.root/overlayRoot,
    // whichever `.parent` is null) rather than stopping at an ancestor whose
    // `id` happens to equal the string 'root' — Scene's own root entity is
    // literally named that internally, but `id` is a plain user-settable
    // string with no reservation, so any entity a caller names "root" (an
    // entirely ordinary choice for a top-level container) would collide and
    // silently truncate the transform chain there. Including the tree's
    // actual top entity is harmless: it's always left at the identity
    // transform (Scene never gives root/overlayRoot a non-default x/y/scale).
    const path: Entity[] = [this];
    let ancestor = this.parent;
    while (ancestor) {
      path.push(ancestor);
      ancestor = ancestor.parent;
    }

    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    let e = 0;
    let f = 0;

    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      const trig = node._getTrig();
      const cos = trig.cos;
      const sin = trig.sin;
      const la = node.scaleX * cos;
      const lb = node.scaleY * sin;
      const lc = -node.scaleX * sin;
      const ld = node.scaleY * cos;
      const le = node.x;
      const lf = node.y;

      const nextA = a * la + c * lb;
      const nextB = b * la + d * lb;
      const nextC = a * lc + c * ld;
      const nextD = b * lc + d * ld;
      const nextE = a * le + c * lf + e;
      const nextF = b * le + d * lf + f;
      a = nextA;
      b = nextB;
      c = nextC;
      d = nextD;
      e = nextE;
      f = nextF;
    }

    return { a, b, c, d, e, f };
  }

  /**
   * Return this entity's cached `{ cos, sin }` of its current rotation,
   * recomputing only when `rotation` has actually changed since the last call.
   * The same object identity is returned across calls with an unchanged
   * rotation, so callers must treat it as read-only. Used by the render walk
   * and {@link getWorldTransform} to avoid V8's comparatively slow Math.cos/sin
   * (a software libm call, ~2.5x slower than other engines) per entity/frame.
   */
  public _getTrig(): Readonly<{ cos: number; sin: number }> {
    if (this._trigRotation !== this._rotation) {
      this._trig.cos = Math.cos(this._rotation);
      this._trig.sin = Math.sin(this._rotation);
      this._trigRotation = this._rotation;
    }
    return this._trig;
  }

  /**
   * Store the world matrix Scene computed for this entity during the render
   * walk, stamped with the frame it belongs to. {@link getWorldTransform}
   * returns it verbatim while `frame === scene.currentFrame`. Internal: called
   * only by Scene's renderer, never by application code.
   */
  public _setWorldCache(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    frame: number,
  ): void {
    this._wa = a;
    this._wb = b;
    this._wc = c;
    this._wd = d;
    this._we = e;
    this._wf = f;
    this._worldFrame = frame;
  }

  /** Convert a point from this entity's local space to Scene/world space. */
  public localToWorld(localX: number, localY: number): Point {
    const { a, b, c, d, e, f } = this.getWorldTransform();
    return {
      x: a * localX + c * localY + e,
      y: b * localX + d * localY + f,
    };
  }

  /**
   * Convert a Scene/world point into this entity's local space.
   * Returns `null` when the accumulated transform is singular.
   */
  public worldToLocal(worldX: number, worldY: number): Point | null {
    const { a, b, c, d, e, f } = this.getWorldTransform();
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
    const x = worldX - e;
    const y = worldY - f;
    return {
      x: (d * x - c * y) / determinant,
      y: (-b * x + a * y) / determinant,
    };
  }

  /**
   * Return the entity's local bounds transformed into a world-space AABB.
   * Falls back to the entity's `[0, 0, width, height]` box when `getBounds()`
   * does not provide a render-specific box.
   */
  public getWorldBounds(): Bounds {
    const bounds = this.getBounds() ?? {
      x: 0,
      y: 0,
      width: this.width,
      height: this.height,
    };
    const { a, b, c, d, e, f } = this.getWorldTransform();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < 4; i++) {
      const localX = i & 1 ? bounds.x + bounds.width : bounds.x;
      const localY = i & 2 ? bounds.y + bounds.height : bounds.y;
      const worldX = a * localX + c * localY + e;
      const worldY = b * localX + d * localY + f;
      minX = Math.min(minX, worldX);
      minY = Math.min(minY, worldY);
      maxX = Math.max(maxX, worldX);
      maxY = Math.max(maxY, worldY);
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Accumulated world scale factors: this entity's own `scaleX`/`scaleY` times
   * those of every ancestor. Useful for mapping a world-space point back into
   * local space for hit-testing.
   *
   * @returns The world scale `{ x, y }`.
   */
  public getWorldScale(): { x: number; y: number } {
    let sx = this.scaleX;
    let sy = this.scaleY;
    let curr = this.parent;
    // See getWorldTransform()'s comment: walk to the true top (`.parent ===
    // null`), not to an ancestor whose `id` happens to be the string 'root'.
    while (curr) {
      sx *= curr.scaleX;
      sy *= curr.scaleY;
      curr = curr.parent;
    }
    return { x: sx, y: sy };
  }

  /**
   * Accumulated world rotation: this entity's own `rotation` plus
   * that of every ancestor.
   *
   * Valid only under positive scales: the sum models the composed matrix
   * `T*S*R` correctly while every ancestor's `scaleX`/`scaleY` is positive,
   * but a mirrored (negative-scale) ancestor flips handedness, which an
   * additive sum cannot represent — the result is then off by the mirror.
   * For mirror-safe rotation, derive the angle from
   * {@link getWorldTransform}'s matrix (e.g. `atan2(b, a)`), as SVGEntity's
   * signed-scale handling already does.
   *
   * @returns The accumulated world rotation in radians.
   */
  public getWorldRotation(): number {
    let rot = this.rotation;
    let curr = this.parent;
    // See getWorldTransform()'s comment: walk to the true top (`.parent ===
    // null`), not to an ancestor whose `id` happens to be the string 'root'.
    while (curr) {
      rot += curr.rotation;
      curr = curr.parent;
    }
    return rot;
  }

  /**
   * Return `true` when the given world-space point lies within this entity's
   * interactive hit area.
   *
   * @param globalX - World-space X coordinate.
   * @param globalY - World-space Y coordinate.
   * @returns Whether the point is inside this entity.
   */
  /**
   * Describe this entity's semantics for the accessibility / automation shadow
   * layer. Override in components to project a real `<button>`, `<a href>`, etc.
   *
   * The default returns `{}`, which `Scene.syncA11y` maps to a plain `div`
   * (preserving the historical behavior of interactive entities).
   *
   * @returns The {@link A11yAttributes} for this entity's shadow node.
   */
  /**
   * Describe this entity's own debug surface for DevTools.
   *
   * Returns `null` by default, meaning "nothing beyond the generic `Entity`
   * fields the inspector already shows". Override in a component to expose the
   * state that makes it inspectable — see {@link DevtoolsDescriptor}.
   *
   * Called only while a panel is inspecting this entity, never per frame, so it
   * may compute values that would be too expensive to track continuously.
   *
   * @returns A descriptor, or `null` to opt out.
   */
  public getDevtoolsDescriptor(): DevtoolsDescriptor | null {
    return null;
  }

  /**
   * Which of a child's properties this entity computes during layout.
   *
   * Returns an empty array by default, meaning "this entity does not position its
   * children". A container that lays out children — `Stack`, `Table`, `Tabs` —
   * overrides it so tooling can mark those values as parent-owned: editing `x` on
   * a `Stack` child is reverted by the next layout, and knowing that in advance is
   * the difference between a confusing tool and a correct one.
   *
   * @param child - The child being asked about. Containers whose control depends
   *   on the child (a `Table` cell versus its header) can answer per child.
   * @returns Property names this entity overwrites on that child.
   */
  public getLayoutControlledProperties(child: Entity): ReadonlyArray<LayoutControlledProperty> {
    void child;
    return [];
  }

  public getA11yAttributes(): A11yAttributes {
    return {};
  }

  /**
   * Local-space axis-aligned bounding box of what this entity's {@link render}
   * draws, used by {@link Scene} for viewport culling.
   *
   * Returns `null` by default, meaning "unknown bounds" — the entity is then
   * never culled (always rendered). Override to return a {@link Bounds} so the
   * scene can skip rendering it when it lies outside the viewport.
   *
   * @returns The local bounds, or `null` to opt out of culling.
   */
  public getBounds(): Bounds | null {
    return null;
  }

  /**
   * Select a contiguous subset of direct children for visual rendering.
   *
   * Return `null` (the default) to visit every child. Containers may override
   * this only when child order and geometry prove that every skipped child's
   * entire painted subtree lies outside `localViewport`. The Scene still keeps
   * all children resident, and hit testing, accessibility, and content
   * projection continue to see the complete tree. Skipped subtrees do not run
   * `update()` or `render()` in the visual pass, so opt in only for children that
   * are static while offscreen or whose state advances outside those methods.
   *
   * The returned range is half-open and is clamped to `children.length`.
   * `localViewport` is a conservative axis-aligned box obtained by mapping the
   * Scene viewport into this entity's local coordinate space.
   */
  public getRenderChildRange(localViewport: Bounds): RenderChildRange | null {
    void localViewport;
    return null;
  }

  /**
   * Opt into the renderer's draw-call batching fast-path for point-cloud /
   * particle entities that draw as a single filled circle at their local origin.
   *
   * When a leaf entity returns a {@link BatchCircle} and its accumulated
   * transform is representable by the selected batch backend, the {@link Scene}
   * skips its per-entity `save`/`translate`/`scale`/`rotate`/`restore` and
   * {@link render}. Canvas mode or an unsupported affine transform uses the
   * normal render path, so implementations must keep {@link render} correct.
   * Returns `null` by default. Read each frame, so animated color/radius works.
   *
   * @returns The circle to batch, or `null` to use the normal {@link render} path.
   */
  public getBatchCircle(): BatchCircle | null {
    return null;
  }

  /**
   * Opt into the GPU instanced-rectangle fast-path for a leaf entity that draws
   * as a single filled rectangle from its local origin. Only used when the
   * {@link Scene} runs a WebGL `pointBackend`; otherwise the entity renders
   * normally via {@link render}. Returns `null` by default. Read each frame.
   *
   * @returns The rectangle to batch, or `null` for the normal render path.
   */
  public getBatchRect(): BatchRect | null {
    return null;
  }

  /**
   * Opt into DOM content projection for entities that render static text.
   * The {@link Scene} mirrors the returned text as a transparent DOM node
   * positioned over the drawn glyphs, making canvas text findable (Ctrl+F),
   * readable by screen readers and crawlers, translatable, and — when
   * `selectable` is set — natively selectable. Returns `null` by default.
   * Read on the a11y sync cadence, so text changes propagate automatically.
   *
   * @param hint - Optional advice about which part of the entity is worth
   *   describing. Purely an optimization: ignoring it is always correct, which
   *   is why it is a parameter rather than a required contract change. See
   *   {@link ContentProjectionHint}.
   * @returns The projection descriptor, or `null` to project nothing.
   */
  public getContentProjection(hint?: ContentProjectionHint): ContentProjection | null {
    void hint;
    return null;
  }

  /**
   * A cheap, monotonically-increasing stamp of this entity's projected content.
   *
   * Purely an optimization, and opt-in: returning `null` (the default) means
   * "I cannot cheaply tell whether my content changed", and the {@link Scene}
   * then rebuilds the projection every synced frame exactly as before. An
   * implementation must bump the value whenever anything
   * {@link getContentProjection} would report changes — text, fonts, line
   * geometry, `selectable`, grid revision.
   *
   * When two consecutive syncs report the same epoch AND the entity's geometry
   * is unchanged, `Scene` skips the block *before* calling
   * {@link getContentProjection}. That matters because the projection call is
   * O(glyphs-in-block) and the DOM diff around it costs about the same again:
   * measured on a 1500-resident-block document, a sync in which the projected
   * text was byte-identical before and after still cost 17.875 ms, and skipping
   * unchanged blocks took that to 0.475 ms (carryctx CTX-0199, vectojs#343).
   *
   * Correctness is entirely on the implementer: a stale epoch means stale DOM,
   * so bump it in the same place the content is invalidated rather than trying
   * to enumerate mutation sites afterwards. Any monotonic counter works; the
   * value is only ever compared for equality with the previous sync's.
   *
   * @returns The current content epoch, or `null` to disable skipping.
   */
  public getContentEpoch(): number | null {
    return null;
  }

  /**
   * Whether this entity still has a queued/running tween animation, or an
   * active {@link setTransition}/{@link animateTo}/{@link springTo} property
   * driver.
   *
   * Used by {@link Scene} to keep rendering continuously while an animation
   * is in flight — both in `onDemand` render mode, and to hold off the
   * `always`-mode idle auto-throttle. Without checking `_drivers` here, a
   * property driver becomes invisible to that throttle: `markDirty()` called
   * from inside `update()`/`tickDrivers()` is wiped by the loop's own
   * `dirty = false` at the end of that same tick, so once the throttle
   * engages an in-flight spring/tween only advances one animation-frame per
   * external `markDirty()` trigger instead of every render frame.
   *
   * @returns `true` if at least one animation or property driver remains.
   */
  public hasPendingAnimations(): boolean {
    return (this.animations?.length ?? 0) > 0 || (this._drivers?.size ?? 0) > 0;
  }

  public abstract isPointInside(globalX: number, globalY: number): boolean;

  /**
   * Draw this entity using the provided renderer.
   *
   * Called each frame after the entity's transform has been pushed onto the
   * renderer's matrix stack.
   *
   * @param renderer - The active renderer instance.
   */
  public abstract render(renderer: any): void;
}
