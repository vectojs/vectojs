---
'@vectojs/markdown': minor
---

feat(markdown): generic imageResolver -> ImageSource, CapGlyph stays app-layer adapter

- Expose `MarkdownImageResolver = (src:string)=>ImageSource|Promise<ImageSource>` with default `(src)=>({kind:'url',url:src})` in `markdown-image.ts`.
- `MarkdownOptions.imageResolver` drives both block `Image` entities (via `new Image(resolved, ...)`) and inline `InlineObject` rasters (via `ensureInlineImageRaster` with `blob`/`bitmap` decode).
- `paragraphImage` handles sync and async resolvers, reflows on decoded size and triggers `scene.markDirty()`. `refitParagraphImage` reads `decodedImage` for generic sources.
- `collectSpans` / `renderInlineToRichText` thread `imageResolver` for heading/table inline images; `paintInlineImage` draws generic `CanvasImageSource`.
- SSR/Worker remains usable: `blob`/`bitmap` paths do not require `globalThis.Image`.
- `@vectojs/markdown` has no CapGlyph dependency; adapter example `capglyph:` → `fetch` → `createImageBitmap` → `{kind:'bitmap'}` lives in app layer.
