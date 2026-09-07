/**
 * `@vectojs/dom` — DOM visual projection backend for VectoJS (RFC2 P1).
 *
 * The scene graph keeps owning nodes, layout, visibility, lifecycle, and
 * events; selected subtrees (explicit per-node `domPolicy === 'dom'` opt-in)
 * materialize as live `HTMLElement`s positioned by their world matrix. Depends
 * on `@vectojs/core`, never the reverse.
 */
export { DOMProjection, writeField, DOM_VISUAL_Z_INDEX, DOM_ROOT_ATTR } from './DOMProjection';
export type { DOMProjectionStats, DOMKindSpec, DOMSyncFields } from './DOMProjection';
export { attachDOMBridge, getGestureOwner } from './eventBridge';
export type { DOMInteractionMode, DOMBridgeOptions, DOMBridgeHandle } from './eventBridge';
export { affineToMatrix3d } from './matrix';
export { DOMText, DOMButton, DOMInput, DOMContainer, DOMTransform } from './nodes';
