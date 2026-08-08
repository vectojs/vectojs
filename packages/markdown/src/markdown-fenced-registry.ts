import type { Entity } from '@vectojs/core';
import type { MarkdownTheme } from './theme';

/**
 * Fenced block renderer registry: pluggable rendering for code fences keyed by
 * info string.
 *
 * Each language (code, math, mermaid, graphviz, …) is a plugin rather than a
 * branch in `Markdown.renderToken`. Renderers lazy-load on demand and cache
 * conversions, reusing the pattern math already established.
 *
 * ## Lifecycle
 *
 * A renderer may be in one of three states:
 * - **incomplete**: The renderer is registered but its module/assets are not
 *   loaded yet. The first call to `render()` triggers the load.
 * - **ready**: The renderer is loaded and can render synchronously.
 * - **error**: The renderer failed to load or encountered an unrecoverable error.
 *   Falls back to default code block rendering.
 *
 * ## Fallback
 *
 * When no renderer is registered for a language, or when a renderer returns
 * `null`, the registry falls back to the default code block renderer. This
 * preserves backward compatibility and degrades gracefully.
 *
 * ## Example
 *
 * ```typescript
 * import { FencedBlockRegistry } from '@vectojs/markdown';
 *
 * // Register a custom renderer
 * FencedBlockRegistry.register('mermaid', {
 *   async load() {
 *     const mermaid = await import('mermaid');
 *     return (source, lang, options) => {
 *       // ... render logic
 *       return entity;
 *     };
 *   }
 * });
 *
 * // Unregister (for testing or cleanup)
 * FencedBlockRegistry.unregister('mermaid');
 * ```
 */

/**
 * Options passed to a fenced block renderer.
 *
 * Includes the theme, available width, and whether text should be selectable.
 * Renderers may ignore options that don't apply to their output format.
 */
export interface FencedBlockRenderOptions {
  /** The current Markdown theme (colors, fonts, sizes). */
  theme: MarkdownTheme;
  /** Available horizontal space in pixels. */
  availableWidth: number;
  /** Whether text content should be selectable. */
  selectable: boolean;
}

/**
 * A fenced block renderer: converts source code in a specific language to an Entity.
 *
 * Returns `null` when rendering fails or the source is invalid. The caller falls
 * back to a default code block.
 */
export type FencedBlockRenderer = (
  source: string,
  lang: string,
  options: FencedBlockRenderOptions,
) => Entity | null;

/**
 * A lazy-loadable renderer specification.
 *
 * The `load()` method is called once, the first time a fence with this language
 * appears. It should return a synchronous renderer function, or `null` if loading
 * fails. Failures are logged but swallowed — the fence renders as a code block.
 */
export interface FencedBlockRendererSpec {
  /**
   * Load the renderer asynchronously.
   *
   * Called exactly once, the first time a fence with this language is encountered.
   * Returns a synchronous renderer, or `null` on failure. The promise rejection
   * is caught and logged; renderers must not leave unhandled rejections.
   */
  load: () => Promise<FencedBlockRenderer | null>;
}

/** Internal state of a registered renderer. */
interface RendererState {
  spec: FencedBlockRendererSpec;
  /** The loaded renderer, or null if not loaded yet or load failed. */
  renderer: FencedBlockRenderer | null;
  /** The load promise, cached so multiple calls join one load. */
  loadPromise: Promise<void> | null;
}

/**
 * Global registry of fenced block renderers, keyed by language (info string).
 *
 * Languages are normalized to lowercase before lookup. A fence with `lang="JavaScript"`
 * matches a registration for `"javascript"`.
 */
const renderers = new Map<string, RendererState>();

/**
 * Register a lazy-loadable fenced block renderer for a language.
 *
 * @param lang - The language identifier (case-insensitive). Normalized to lowercase.
 * @param spec - The renderer specification, with a `load()` method.
 *
 * @example
 * ```typescript
 * FencedBlockRegistry.register('mermaid', {
 *   async load() {
 *     const mermaid = await import('mermaid');
 *     return (source, lang, options) => {
 *       // ... render Mermaid diagram
 *       return entity;
 *     };
 *   }
 * });
 * ```
 */
export function registerFencedBlockRenderer(lang: string, spec: FencedBlockRendererSpec): void {
  const key = lang.toLowerCase();
  renderers.set(key, {
    spec,
    renderer: null,
    loadPromise: null,
  });
}

/**
 * Unregister a fenced block renderer.
 *
 * Used for testing (sabotage tests) and cleanup. After unregistering, fences with
 * this language fall back to the default code block renderer.
 *
 * @param lang - The language identifier (case-insensitive).
 */
export function unregisterFencedBlockRenderer(lang: string): void {
  const key = lang.toLowerCase();
  renderers.delete(key);
}

/**
 * Check if a renderer is registered for a language.
 *
 * Returns `true` if a renderer is registered, regardless of whether it has loaded yet.
 *
 * @param lang - The language identifier (case-insensitive).
 */
export function hasFencedBlockRenderer(lang: string): boolean {
  const key = lang.toLowerCase();
  return renderers.has(key);
}

/**
 * Check if a renderer is ready (loaded and available for synchronous rendering).
 *
 * Returns `false` if the renderer is not registered, not loaded yet, or failed to load.
 *
 * @param lang - The language identifier (case-insensitive).
 */
export function isFencedBlockRendererReady(lang: string): boolean {
  const key = lang.toLowerCase();
  const state = renderers.get(key);
  return state?.renderer !== null && state?.renderer !== undefined;
}

/**
 * Begin (or join) loading a fenced block renderer.
 *
 * Idempotent: the load promise is cached, so multiple callers share one load.
 * Failures are swallowed — the renderer simply stays unavailable.
 *
 * Call this when a fence with this language first appears, even while it is still
 * open (incomplete). This prefetches the module so the closing fence can render
 * synchronously, hiding the lazy load during a stream.
 *
 * @param lang - The language identifier (case-insensitive).
 * @returns A promise that resolves when the renderer is ready, or immediately if
 *          already loaded.
 */
export function ensureFencedBlockRenderer(lang: string): Promise<void> {
  const key = lang.toLowerCase();
  const state = renderers.get(key);
  if (!state) return Promise.resolve();
  if (state.renderer !== null) return Promise.resolve();
  if (state.loadPromise) return state.loadPromise;

  state.loadPromise = (async () => {
    try {
      const loaded = await state.spec.load();
      state.renderer = loaded;
    } catch (e) {
      console.error(`Fenced block renderer for "${lang}" failed to load`, e);
      state.renderer = null;
    }
  })();

  return state.loadPromise;
}

/**
 * Render a fenced code block using the registered renderer for its language.
 *
 * Returns `null` if:
 * - No renderer is registered for this language
 * - The renderer is not loaded yet
 * - The renderer returned `null` (rendering failed)
 *
 * The caller falls back to the default code block renderer in all three cases.
 *
 * @param source - The source code inside the fence.
 * @param lang - The language identifier (case-insensitive).
 * @param options - Rendering options (theme, width, selectable).
 * @returns The rendered entity, or `null` to fall back to default code block.
 */
export function renderFencedBlock(
  source: string,
  lang: string,
  options: FencedBlockRenderOptions,
): Entity | null {
  const key = lang.toLowerCase();
  const state = renderers.get(key);
  if (!state || !state.renderer) return null;
  return state.renderer(source, lang, options);
}
