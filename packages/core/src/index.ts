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
export * from './tree/Entity';
export * from './tree/Scene';
export * from './components/TextEntity';
export * from './components/GridTextEntity';
export * from './components/SplineEntity';
export * from './layout/LayoutEngine';
export * from './layout/measure';
export * from './text/MSDFFont';
export * from './math/SpatialHashGrid';
export * from './math/SpringPhysics';
export * from './animation/easing';
export * from './animation/drivers';
export { MSDFTextEntity } from './text/MSDFTextEntity';
export type { MSDFTextEntityOptions } from './text/MSDFTextEntity';
export { LayoutWorkerManager } from './layout/LayoutWorkerManager';
export { DOMPortalEntity } from './tree/DOMPortalEntity';
export { SVGEntity } from './text/SVGEntity';
export * from './tree/ComputeParticleEntity';
export * from './text/ArabicShaper';
export * from './text/BidiResolver';
