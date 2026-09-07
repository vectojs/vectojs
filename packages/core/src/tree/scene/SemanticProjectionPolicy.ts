import type { Entity } from '../Entity';

/**
 * Per-node semantic projection decision (RFC3 §5, CTX-0599).
 *
 * - `'project'` — materialize the node's semantic mirror (today's behaviour).
 * - `'defer-to-browser'` — let browser recovery (canvas-a11y capture,
 *   `html-in-canvas`, …) own this node's platform semantics. Allow-listed per
 *   content class (§5): plain display text first, never controls, and always
 *   feature-detected at runtime with a projection fallback. Unreachable while
 *   {@link supportsHTMLInCanvas} is `false` — see
 *   {@link isDeferrableSemanticNode}.
 * - `'never'` — suppress the node's semantic mirror (the policy-level
 *   equivalent of `Entity.a11yProjection: 'never'`).
 *
 * Adapters plug in _below_ the semantic tree: a future backend changes how
 * text is painted, not what the entity means. The upper API (`projection`,
 * `selectable`, `A11yAttributes`) stays stable across backend switches.
 */
export type SemanticProjectionDecision = 'project' | 'defer-to-browser' | 'never';

/**
 * Browser capabilities the policy may consult. Sourced live per decision via
 * {@link getSemanticProjectionCapabilities} — capability only narrows cost,
 * the framework-known default stays `'project'`.
 */
export interface SemanticProjectionCapabilities {
  /** A real `html-in-canvas` backend exists (cf. RFC §7 standing). */
  readonly htmlInCanvas: boolean;
  /**
   * Stable cross-engine canvas text recovery exists. Chromium capture is
   * experimental as of RFC §7, so per RFC §3 rule 2 no conformance claim may
   * depend on it — honestly `false` until that changes.
   */
  readonly canvasTextRecovery: boolean;
}

/** Runtime environment the policy may consult. */
export interface SemanticProjectionEnvironment {
  /** `false` under SSR/Node, where projection is a no-op (the `!a11yRoot` guard). */
  readonly hasDOM: boolean;
}

/**
 * Policy seam for the semantic tier (RFC3 §5). Wired at the single point
 * where the tier decides per node (`Scene.shouldProjectA11y`); the default
 * below preserves current behaviour exactly.
 *
 * Constraints on implementations (RFC §5):
 *
 * - `defer-to-browser` is allow-listed per content class via
 *   {@link isDeferrableSemanticNode} — plain display text first, never the
 *   default for controls — and always feature-detected at runtime with a
 *   projection fallback.
 * - A throwing policy must never drop semantics; `Scene` falls back to
 *   `'project'` on throw.
 */
export interface SemanticProjectionPolicy {
  /**
   * Framework-known default per node; browser capability only narrows cost.
   *
   * @param node - The entity the semantic tier is deciding about.
   * @param capabilities - Live browser capabilities (see {@link getSemanticProjectionCapabilities}).
   * @param environment - Runtime environment (DOM presence, …).
   */
  choose(
    node: Entity,
    capabilities: SemanticProjectionCapabilities,
    environment: SemanticProjectionEnvironment,
  ): SemanticProjectionDecision;
}

/**
 * Framework-known default: always `'project'`. Browser capability only
 * narrows cost, never widens it — so the out-of-the-box behaviour is
 * identical to having no policy at all.
 */
export const DEFAULT_SEMANTIC_PROJECTION_POLICY: SemanticProjectionPolicy = {
  choose: () => 'project',
};

/** Live capabilities snapshot for {@link SemanticProjectionPolicy.choose}. */
export function getSemanticProjectionCapabilities(): SemanticProjectionCapabilities {
  return {
    htmlInCanvas: supportsHTMLInCanvas(),
    canvasTextRecovery: false,
  };
}

/**
 * Roles whose semantics must never defer to browser recovery: losing the
 * framework-known role/state/action (button, link, checkbox, …) to an
 * OCR-grade string is the exact failure RFC §3 rules out.
 *
 * Sibling of `KEYBOARD_OWNING_ROLES` (`tree/Scene.ts`): that set answers
 * "who owns the keyboard", this one answers "who must keep its framework
 * mirror". Kept as its own literal rather than derived so this module stays
 * importable without the `Scene` runtime (no `Scene` ↔ policy import cycle).
 */
const CONTROL_SEMANTIC_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'textbox',
  'searchbox',
  'progressbar',
  'scrollbar',
  'meter',
]);

/**
 * Whether `node` belongs to a content class that may one day defer its
 * platform semantics to the browser (RFC §5 allow-list).
 *
 * Allow-listed today: nodes with no control semantics — no native-control tag,
 * no control role, no keyboard tab stop — i.e. plain display text first, per
 * §5. Everything else (controls, tab stops, natively selectable text whose
 * DOM mirror owns selection per RFC §6) always keeps its framework mirror.
 *
 * Structural today: `Scene` additionally requires a real backend before any
 * deferral takes effect, so this predicate changes no behaviour on its own —
 * it is the gate a future backend consults, and the contract custom policies
 * must honour when returning `'defer-to-browser'`.
 */
export function isDeferrableSemanticNode(node: Entity): boolean {
  const attrs = node.getA11yAttributes();
  if (attrs.tag !== undefined && attrs.tag !== 'div') return false;
  if (attrs.role !== undefined && CONTROL_SEMANTIC_ROLES.has(attrs.role)) return false;
  if (typeof attrs.tabIndex === 'number' && attrs.tabIndex >= 0) return false;
  const projection = node.getContentProjection?.();
  if (projection?.selectable) return false;
  return true;
}

/**
 * Honest detail behind {@link supportsHTMLInCanvas}: `supported` is `false`
 * until a real backend exists, and `reason` says why.
 */
export type HTMLInCanvasSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: 'no-dom' | 'no-backend' };

/**
 * Feature-detection contract for a future `html-in-canvas` backend
 * (RFC §5 + RFC2 §8). Honest by construction:
 *
 * - SSR/Node (`typeof document === 'undefined'`) → `{ supported: false }`
 *   without touching the DOM at all (core owns no unguarded
 *   `document`/`window` contact per RFC1 §4).
 * - Any probe throw (e.g. jsdom's unimplemented `getContext`) → `false`.
 * - No backend today → `{ supported: false, reason: 'no-backend' }`.
 *
 * The probe is written as a real detection — a `2d` context exposing the
 * `html-in-canvas` entry point (`drawElementImage`, RFC §7) reports `true` —
 * so the day a browser ships it, this flips without a framework change. Until
 * then there are no fake positives: nothing claims support it cannot use.
 */
export function describeHTMLInCanvasSupport(): HTMLInCanvasSupport {
  if (typeof document === 'undefined') return { supported: false, reason: 'no-dom' };
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d') as unknown;
    // A genuine 2d context, not just something shaped like one: test doubles
    // (and mocks generally) answer any property read with a function, so a
    // bare `'drawElementImage' in ctx` duck-type reports support where none
    // exists — measured with this repo's own jsdom `fakeCtx()` Proxy, which
    // returns `() => {}` for every prop. Only a native context counts.
    const native2D =
      typeof CanvasRenderingContext2D !== 'undefined' && ctx instanceof CanvasRenderingContext2D;
    if (
      native2D &&
      typeof (ctx as unknown as Record<string, unknown>)['drawElementImage'] === 'function'
    ) {
      return { supported: true };
    }
  } catch {
    return { supported: false, reason: 'no-backend' };
  }
  return { supported: false, reason: 'no-backend' };
}

/**
 * Whether an `html-in-canvas` backend is available right now (RFC §5 seam).
 * `false` until a real backend exists — detection contract per RFC §5 +
 * RFC2 §8, no fake positives. See {@link describeHTMLInCanvasSupport} for
 * the reasoned form.
 */
export function supportsHTMLInCanvas(): boolean {
  return describeHTMLInCanvasSupport().supported;
}
