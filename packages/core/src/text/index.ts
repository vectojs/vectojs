// Re-export the standalone text-shaping primitives (now @vectojs/text) so the
// `@vectojs/core/text` subpath and barrel stay backward compatible.
export * from '@vectojs/text';
// Entity-based text renderers stay in core because they extend Entity.
export * from './MSDFTextEntity';
export * from './SVGEntity';
