import { Scene } from './tree/Scene';
import { createWebGLPointRenderer } from './renderer/WebGLPointRenderer';
import { WebGPUParticleSystemManager } from './renderer/WebGPUParticleSystemManager';

// Automatically register default renderers/managers for backward compatibility
Scene.registerWebGLPointRendererCreator(createWebGLPointRenderer);
Scene.registerWebGPUParticleSystemManager(WebGPUParticleSystemManager);

// Export everything
export * from './renderer/IRenderer';
export * from './renderer/CanvasRenderer';
export * from './renderer/SVGRenderer';
export * from './renderer/WebGLPointRenderer';
export * from './renderer/WebGPUParticleSystemManager';
export * from './renderer/colorParse';
export * from './renderer/url';
export * from './renderer/TextRasterCache';
export * from './tree/Entity';
export * from './tree/Scene';
export * from './components/TextEntity';
export * from './components/GridTextEntity';
export * from './components/SplineEntity';
export * from './components/Rect';
export * from './components/Circle';
export * from './components/Group';
// Re-export the extracted standalone engines so the `@vectojs/core` barrel stays
// backward compatible. These now live in their own packages:
//   @vectojs/layout, @vectojs/text, @vectojs/math, @vectojs/animation
export * from '@vectojs/layout';
export * from '@vectojs/text';
export * from '@vectojs/math';
export * from '@vectojs/animation';
export { MSDFTextEntity } from './text/MSDFTextEntity';
export type { MSDFTextEntityOptions } from './text/MSDFTextEntity';
export { DOMPortalEntity } from './tree/DOMPortalEntity';
export { SVGEntity } from './text/SVGEntity';
export * from './tree/ComputeParticleEntity';
