/**
 * Per-node visual projection policy (RFC4 §2, CTX-0601).
 *
 * This is the RFC's `projection` field under its in-tree name: the per-node
 * knob lives on {@link Entity.domPolicy} (named before the RFC), so
 * `ProjectionPolicy` is the value vocabulary and `Entity.domPolicy` is where
 * it is stored. `a11yProjection` keeps governing the _semantic/AT_ mirror
 * independently — the two knobs compose, neither silently overrides the other
 * (RFC4 §2).
 *
 * - `'canvas'` — always canvas pixels through the scene's `IRenderer`. The
 *   default: existing scenes behave byte-for-byte as today.
 * - `'dom'` — always materialize through the DOM projection backend. Requires
 *   a DOM backend and a supported node kind; otherwise falls back per §3 and
 *   reports the fallback, never silently.
 * - `'auto'` — the engine decides per node per frame from the Capability
 *   Matrix below: native-interaction value vs materialization cost vs backend
 *   availability. The only mode the engine may flip frame to frame.
 */
export type ProjectionPolicy = 'canvas' | 'dom' | 'auto';

/** Where the negotiation landed, and why it landed anywhere but the request. */
export type ProjectionFallbackReason =
  | 'no-dom-backend'
  | 'unsupported-kind'
  | 'prohibitive-cost'
  | 'bulk-budget'
  | 'active-gesture'
  | 'focus-pinned'
  | 'hysteresis';

/** Native-interaction value of materializing this kind in the DOM (§4). */
export type ProjectionNativeValue = 'none' | 'low' | 'medium' | 'high';

/** Materialization cost in one backend (§4). */
export type ProjectionCost = 'low' | 'medium' | 'high' | 'prohibitive' | 'unsupported' | 'n/a';

/**
 * One Capability Matrix row (RFC4 §4): the negotiation inputs for a `domKind`.
 *
 * Values are **[opinions-to-measure]** starting positions from research §§8–10
 * and the measured mirror costs — P1 must replace them with numbers. The only
 * cell that overrides an explicit `'dom'` request besides `unsupported-kind`
 * is `domCost: 'prohibitive'`, and even then it reports rather than refusing
 * silently (§3 rule 2).
 */
export interface ProjectionCapabilityRow {
  /** `false` means the kind has no DOM representation at all. */
  readonly domSupported: boolean;
  /** What native interaction (selection, IME, focus, form semantics) DOM buys. */
  readonly nativeValue: ProjectionNativeValue;
  /** Cost of one live element for this kind. */
  readonly domCost: ProjectionCost;
  /** Cost of (re-)implementing this kind in canvas pixels. */
  readonly canvasCost: ProjectionCost;
  /**
   * The table's last column verbatim: where `'auto'` rests when no rule fires.
   * Unknown kinds (absent from the matrix) default to `'canvas'`.
   */
  readonly autoDefault: 'canvas' | 'dom';
}

/**
 * Capability Matrix (RFC4 §4) keyed by `Entity.domKind`.
 *
 * The matrix is keyed by backend creation hint, not entity class: `domKind`
 * is the tag/content mapping the DOM backend consumes, so the row travels
 * with the representation, and custom kinds start at the unknown-kind default
 * (`unsupported-kind` → canvas) until a scene registers a row via
 * {@link Scene.registerProjectionCapability | Scene.registerProjectionCapability}.
 */
export const DEFAULT_PROJECTION_CAPABILITIES: Readonly<Record<string, ProjectionCapabilityRow>> = {
  /** Static text (short): findability already covered by content projection. */
  text: {
    domSupported: true,
    nativeValue: 'medium',
    domCost: 'low',
    canvasCost: 'low',
    autoDefault: 'canvas',
  },
  /** Long/selectable text, Markdown blocks: selection, Ctrl+F, translation. */
  prose: {
    domSupported: true,
    nativeValue: 'high',
    domCost: 'medium',
    canvasCost: 'high',
    autoDefault: 'dom',
  },
  /** Code blocks: selectable source, but canvas carriers already serve selection — rests canvas until measured (RFC4 §6 hybrid mapping). */
  code: {
    domSupported: true,
    nativeValue: 'medium',
    domCost: 'medium',
    canvasCost: 'high',
    autoDefault: 'canvas',
  },
  /** Text input / editable: IME, caret, clipboard, BiDi come free in DOM. */
  input: {
    domSupported: true,
    nativeValue: 'high',
    domCost: 'low',
    canvasCost: 'prohibitive',
    autoDefault: 'dom',
  },
  /** Button / Link: cheap either way, native wins on focus + AT clicks. */
  button: {
    domSupported: true,
    nativeValue: 'medium',
    domCost: 'low',
    canvasCost: 'low',
    autoDefault: 'dom',
  },
  link: {
    domSupported: true,
    nativeValue: 'medium',
    domCost: 'low',
    canvasCost: 'low',
    autoDefault: 'dom',
  },
  /** Select / Dropdown / Checkbox / Radio: popup, keyboard, form semantics. */
  select: {
    domSupported: true,
    nativeValue: 'high',
    domCost: 'low',
    canvasCost: 'high',
    autoDefault: 'dom',
  },
  /** Container / layout group: no direct representation, children negotiate. */
  container: {
    domSupported: true,
    nativeValue: 'none',
    domCost: 'n/a',
    canvasCost: 'low',
    autoDefault: 'canvas',
  },
  /** Transform / camera rig: owns space, not pixels — never materialized. */
  transform: {
    domSupported: true,
    nativeValue: 'none',
    domCost: 'n/a',
    canvasCost: 'n/a',
    autoDefault: 'canvas',
  },
  /** Image / video frame: blit is cheap, one element per item is not. */
  image: {
    domSupported: true,
    nativeValue: 'low',
    domCost: 'medium',
    canvasCost: 'low',
    autoDefault: 'canvas',
  },
  /** Particles / danmaku / chart glyphs: bulk stays canvas, unconditionally. */
  particles: {
    domSupported: true,
    nativeValue: 'none',
    domCost: 'prohibitive',
    canvasCost: 'low',
    autoDefault: 'canvas',
  },
  /** Graph nodes/edges (interactive, moderate count): canvas until measured. */
  graph: {
    domSupported: true,
    nativeValue: 'low',
    domCost: 'medium',
    canvasCost: 'medium',
    autoDefault: 'canvas',
  },
  /** Custom shader / GPU particles: no DOM representation exists. */
  shader: {
    domSupported: false,
    nativeValue: 'none',
    domCost: 'unsupported',
    canvasCost: 'low',
    autoDefault: 'canvas',
  },
};

/** Fallback row for `domKind`s absent from the matrix: canvas, reported. */
export const UNKNOWN_PROJECTION_CAPABILITY: ProjectionCapabilityRow = {
  domSupported: false,
  nativeValue: 'none',
  domCost: 'unsupported',
  canvasCost: 'low',
  autoDefault: 'canvas',
};

/**
 * Consecutive syncs an `'auto'` node must keep voting for the other backend
 * before the sticky resolution flips (RFC4 §3 rule 3).
 *
 * Documented tunable: scenes override per scene via the
 * `projectionHysteresisFrames` option. Each flip pays `unmount` + `mount`
 * plus, for text, layout handoff — the count is P1 measurement work, not dogma.
 */
export const PROJECTION_AUTO_HYSTERESIS_FRAMES = 3;

/**
 * Maximum `'auto'`-resolved DOM residents per scene per frame (RFC4 §4
 * particle-row backstop: bulk-count nodes stay canvas).
 *
 * Explicit `'dom'` requests are the author's choice and bypass the budget;
 * only the engine's own `'auto'` placements count. Documented tunable: scenes
 * override per scene via the `projectionAutoDomBudget` option.
 */
export const PROJECTION_AUTO_DOM_BUDGET = 500;

/** Inputs to {@link resolveProjection} beyond the node's own policy. */
export interface ProjectionNegotiationContext {
  /** A `'dom'`-kind backend is registered on the scene. */
  readonly domBackendMounted: boolean;
  /** `false` under SSR/Node — negotiation short-circuits before the matrix. */
  readonly hasDOM: boolean;
}

/** Output of {@link resolveProjection}: where, and why if not as requested. */
export interface ProjectionOutcome {
  readonly resolved: 'canvas' | 'dom';
  /** `null` when the resolution honors the request (or _is_ the default). */
  readonly reason: ProjectionFallbackReason | null;
}

/**
 * Capability negotiation (RFC4 §3): resolve one node's policy to a backend.
 *
 * Pure: hysteresis, gesture/focus pins, and the bulk budget live scene-side
 * (they need cross-frame and cross-node state); this function is the
 * per-node-per-sync rule set, so it stays unit-testable without a `Scene`.
 *
 * Rules:
 *
 * 1. Explicit beats automatic; possible beats explicit. `'canvas'` and a
 *    satisfiable `'dom'` are never second-guessed.
 * 2. Fallbacks are reported, not silent — every non-honored request carries
 *    its reason for the per-scene queryable surface.
 * 3. No-DOM environments always resolve `'canvas'` before touching the matrix.
 */
export function resolveProjection(
  want: ProjectionPolicy,
  cap: ProjectionCapabilityRow,
  ctx: ProjectionNegotiationContext,
): ProjectionOutcome {
  if (want === 'canvas') return { resolved: 'canvas', reason: null };
  if (!ctx.hasDOM || !ctx.domBackendMounted) {
    return { resolved: 'canvas', reason: 'no-dom-backend' };
  }
  if (!cap.domSupported) return { resolved: 'canvas', reason: 'unsupported-kind' };
  if (want === 'dom') {
    // Explicit request: honour unless impossible; cost is the author's choice.
    // The only capability cell that overrides it is prohibitive DOM cost.
    if (cap.domCost === 'prohibitive') return { resolved: 'canvas', reason: 'prohibitive-cost' };
    return { resolved: 'dom', reason: null };
  }
  // 'auto': the engine weighs interaction value against cost.
  if (cap.nativeValue === 'high' && cap.domCost !== 'prohibitive') {
    return { resolved: 'dom', reason: null };
  }
  if (cap.canvasCost === 'prohibitive' && cap.domSupported) {
    return { resolved: 'dom', reason: null };
  }
  if (cap.autoDefault === 'dom') return { resolved: 'dom', reason: null };
  return { resolved: 'canvas', reason: null };
}

/**
 * One node's last negotiation, for the per-scene queryable surface (RFC4 §3
 * rule 2 — precedent shape: the proposed `scene.inputCapabilities` in
 * input-dispatch-contract-v2 §4). Plain data only: resolution data never
 * carries an `HTMLElement`, materialization stays in `@vectojs/dom`.
 */
export interface ProjectionResolution {
  readonly nodeId: string;
  readonly want: ProjectionPolicy;
  readonly resolved: 'canvas' | 'dom';
  /** `null` when the resolution honors the request. */
  readonly reason: ProjectionFallbackReason | null;
}

/**
 * Scene-level projection capabilities (RFC4 §3 rule 2).
 *
 * Follows the proposed `scene.inputCapabilities` precedent shape
 * (input-dispatch-contract-v2 §4 "Feature detection story"): a plain-data
 * getter apps and devtools query to adapt, never to mutate.
 */
export interface SceneProjectionCapabilities {
  /** A real DOM is present (false under SSR/Node). */
  readonly hasDOM: boolean;
  /** A `'dom'`-kind backend is registered on this scene. */
  readonly domBackendMounted: boolean;
  /** Kinds of all registered backends, in registration order. */
  readonly backends: readonly string[];
  /** Live hysteresis tunables (scene overrides of the module constants). */
  readonly autoHysteresisFrames: number;
  readonly autoDomBudget: number;
}

/** Per-node hysteresis + memo state owned by the scene (RFC4 §3 rule 3). */
export interface ProjectionHysteresisState {
  resolved: 'canvas' | 'dom';
  /** Consecutive syncs voting against {@link resolved}. */
  consecutive: number;
  /** Frame id of the last vote, so render + a11y sync agree within a frame. */
  lastFrame: number;
}

/**
 * Sticky-vote half of hysteresis, factored pure for tests.
 *
 * Returns the resolution to keep plus the updated consecutive count: votes
 * for the current backend reset the counter, votes against accumulate until
 * `hysteresisFrames` consecutive, at which point the flip commits. The first
 * vote for a node (no current) always commits — stickiness pins flips, never
 * first placement.
 */
export function hysteresisVote(
  current: 'canvas' | 'dom' | undefined,
  desired: 'canvas' | 'dom',
  consecutive: number,
  hysteresisFrames: number,
): { resolved: 'canvas' | 'dom'; consecutive: number; flipped: boolean } {
  if (current === undefined || current === desired) {
    return { resolved: desired, consecutive: 0, flipped: false };
  }
  const next = consecutive + 1;
  if (next >= hysteresisFrames) return { resolved: desired, consecutive: 0, flipped: true };
  return { resolved: current, consecutive: next, flipped: false };
}
