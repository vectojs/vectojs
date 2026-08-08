---
'@vectojs/markdown': minor
---

Add fenced-block renderer registry for pluggable code fence rendering

Introduces a new registry system that allows custom renderers to be registered for specific code fence languages (info strings). This enables extending Markdown with new languages (Mermaid, Graphviz, etc.) without modifying the core renderer.

**New exports:**

- `registerFencedBlockRenderer(lang, spec)` - Register a lazy-loadable renderer
- `unregisterFencedBlockRenderer(lang)` - Unregister a renderer
- `hasFencedBlockRenderer(lang)` - Check if a renderer is registered
- `isFencedBlockRendererReady(lang)` - Check if a renderer is loaded
- `ensureFencedBlockRenderer(lang)` - Prefetch a renderer module
- `renderFencedBlock(source, lang, options)` - Render using the registry
- `FencedBlockRenderer` type - Renderer function signature
- `FencedBlockRendererSpec` type - Lazy-loadable renderer specification
- `FencedBlockRenderOptions` type - Options passed to renderers

**Changes:**

- Purely additive: the registry is consulted only for languages the built-in
  `code` and `math` arms do not already claim, so both keep their exact existing
  paths and are deliberately **not** registry entries. Display math depends on
  instance state the registry cannot reach (it subscribes for raster repaint and
  wraps its formula in a `RichText` inline object so selection, find-in-page and
  the a11y projection reach it), and a module-level copy of that logic diverges
  silently.
- Registry follows the same lazy-load + `incomplete → ready → error` pattern as
  math rendering, prefetching on the opening fence so a streamed block can render
  synchronously once it closes.
- A renderer is only invoked once its fence is **closed**, the same rule math
  already applies — a half-arrived source is never handed to a renderer as final.
- Graceful fallback to `CodeBlock` when no renderer is registered, its load has
  not resolved, it failed to load, or it returned `null`.
- Fully backward compatible — existing code/math blocks are untouched.

**Example:**

```typescript
import { registerFencedBlockRenderer } from '@vectojs/markdown';

registerFencedBlockRenderer('mermaid', {
  async load() {
    const mermaid = await import('mermaid');
    return (source, lang, options) => {
      // ... render Mermaid diagram
      return entity;
    };
  },
});
```
