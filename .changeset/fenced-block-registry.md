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

- Code and math block rendering now uses the registry internally
- Built-in renderers (code, math) are auto-registered at module initialization
- Registry follows the same lazy-load + cache pattern as math rendering
- Graceful fallback to `CodeBlock` when no renderer is available
- Fully backward compatible - existing code/math blocks work unchanged

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
