---
title: "07 — Renderer — Coordinates / Clipping / DPR Parity"
description: "Multi-backend parity across Canvas2D, WebGL, WebGPU, SVG and Three: the IRenderer contract, coordinate spaces, clip semantics, DPR/backing-store caps, viewport culling and draw-call batching — and every trap that makes the same scene look different on a different backend."
order: 27
---

# 07 — Renderer — Coordinates / Clipping / DPR Parity

> **Boss 07** guards the last mile: turning the Virtual Math Tree's
> geometry into pixels that look identical whether the backend is
> `CanvasRenderingContext2D`, a WebGL point layer, a WebGPU compute
> pass, an SVG export, or a Three.js instanced mesh — at any DPR,
> any zoom, and any viewport.

- **What you'll learn**: the `IRenderer` contract and why it — not
  `CanvasRenderingContext2D` — is the authority; the five coordinate
  spaces a draw call traverses; how clipping, DPR, culling and
  batching each break parity; and the filed, fixed and still-open
  traps with `file:line` you can verify.
- **What you won't**: text shaping and layout (boss 02), VMT dirty
  and lifecycle (boss 06), WASM acceleration (boss 08), or the
  Three/XR bridge's two-world mapping (boss 09). This doc is the
  rendering half of each.

## Why multi-backend parity is hard

VectoJS promises "same scene, same picture" across five backends:

| backend                     | module                                                        | retained?            | where pixels go                        |
| --------------------------- | ------------------------------------------------------------- | -------------------- | -------------------------------------- |
| Canvas2D                    | `packages/core/src/renderer/CanvasRenderer.ts:1`              | immediate            | one `<canvas>` 2D context, DPR-scaled  |
| WebGL points/sprites/glyphs | `packages/core/src/renderer/WebGLPointRenderer.ts:1`          | batched              | stacked full-window canvas, NDC quads  |
| WebGPU particles            | `packages/core/src/renderer/WebGPUParticleSystemManager.ts:1` | compute              | same stacked canvas, compute→render    |
| SVG export                  | `packages/core/src/renderer/SVGRenderer.ts:1`                 | retained strings     | `toXMLString()` DOM-free serialization |
| Three.js                    | `packages/three/src/ThreeRenderer.ts:216`                     | retained scene graph | `THREE.WebGLRenderer` ortho camera     |

Every backend receives the **same `Entity.render(r: IRenderer)` calls**
in the same order, under the same `save`/`restore`/`translate` stack.
Parity fails not where the walk is wrong but where the backends
_interpret_ the same call differently — a clip that is a path op in
one and a scissor rect in another, a backing store sized at `window
.devicePixelRatio` in one and `maxDPR`-clamped in another, a stroke
that is a `lineWidth` property in one and ribbon geometry in another.
Each divergence is invisible until a HiDPI display, a zoom, a clip
edge, or a 40k-cell grid hits it.

The contract that absorbs these divergences is `IRenderer`
(`packages/core/src/renderer/IRenderer.ts:1`). Entities must not
import a concrete renderer. The interface is method-based by design:
style travels _with_ the draw (`stroke(color, lineWidth)`,
`fillText(text, x, y, font, color)`) so a batching backend can coalesce
runs and a GPU backend has a defined boundary. Mutable style properties
(`ctx.fillStyle = …`) are deliberately absent — dev traps warn on them
(`IRenderer.ts:159`, `IRenderer.ts:301`) because in untranspiled JS
they attach as expandos and silently draw with the context default.

## The IRenderer contract (read this first)

```text
IRenderer.ts:41  — kind, pixelRatio, setDrawCounters / getDrawCounters
IRenderer.ts:134 — clip(x,y,w,h, radii?)
IRenderer.ts:149 — path: beginPath / moveTo / lineTo / bezierCurveTo / closePath / arc / roundRect
IRenderer.ts:193 — drawImage / drawImageRect? (optional)
IRenderer.ts:287 — fill / stroke / fillText / fillCircle / flush
IRenderer.ts:350 — createLinearGradient
IRenderer.ts:404 — present? / dispose? / isContextLost? / onContextRestored?
```text

Key design choices:

- **`kind`** (`IRenderer.ts:76`) is a stable string discriminator
  (`'canvas2d' | 'svg' | 'three'`) — `constructor.name` minifies.
- **`pixelRatio`** (`IRenderer.ts:88`) is optional and a _live applied_
  value, not a snapshot of `window.devicePixelRatio`. A caller that
  rasterizes a blit source must read this, not the window.
- **`drawImageRect?`** (`IRenderer.ts:232`) is optional. `SVGRenderer`
  omits it on purpose: an SVG blit embeds its source as a data URL, so
  a per-cell sub-rect would inline the whole atlas thousands of times.
  Callers must feature-detect and keep a `fillText` fallback.
- **`fillCircle` + `flush`** (`IRenderer.ts:328`, `:364`) is the
  order-preserving batch. Consecutive same-color, same-alpha circles
  coalesce into one path and one `fill()` on `flush()`. `Scene` flushes
  at every sibling boundary and at frame end.
- **`present?`** (`IRenderer.ts:404`) is retained-backend-only.
  `CanvasRenderer` paints immediately; `ThreeRenderer` defers its
  single real GL render to `present()` (`ThreeRenderer.ts:957`) so a
  frame costs `O(N)` adds + `1` draw, not `O(N²)` re-renders.

## Coordinate spaces (five, not one)

A point written as `fillCircle(cx, cy, …)` traverses:

1. **Local** — the entity's own `(x, y)` box. `Entity.getBounds()`
   and `worldToLocal` live here.
2. **World** — local transformed by every ancestor's `translate` /
   `scale` / `rotate` and the scene's DPR scale. `HitTester` and
   culling test here.
3. **Viewport / CSS px** — world clipped to the scene's viewport and
   any `clipChildren` ancestor. `Scene.ts:4335` `projectionBoxVisible`.
4. **Backing store / device px** — viewport × `appliedDPR`
   (`CanvasRenderer.ts:244` `pixelRatio`). Where the GPU actually
   samples.
5. **Clip / NDC** — WebGL/WebGPU only: `(pos / resolution)*2-1`,
   y-flipped (`WebGLPointRenderer.ts:320`), Three's y-down ortho
   (`ThreeRenderer.ts:250`).

The pitfall is assuming one space is another. `ComputeParticleEntity`'s
GPU path consumes `scene.mouseX/Y` in **window** space and draws on a
stacked full-window canvas that ignores entity transforms; its CPU
fallback consumes `entity.worldToLocal(mouse)` in **local** space and
draws inside `renderer.translate(node.x, node.y)` — one buffer, two
contracts (`vectojs-docs/forge/findings/renderer-and-gpu.md:299`).
`WebGPUParticleSystemManager` record passes `screen_size` as `width /
height` (`WebGPUParticleSystemManager.ts:310`) while the CPU path
draws with the entity transform already applied.

`ThreeRenderer` lives in the same trap at the NDC boundary: its ortho
camera is y-down (`ThreeRenderer.ts:250`), so every `FrontSide` mesh
is backfacing and culled — the fix is `side: DoubleSide` on every
filled primitive, not just text (`ThreeRenderer.ts:596`, forge
2026-08-13).

## Clipping

`IRenderer.clip(x, y, w, h, radii?)` (`IRenderer.ts:134`) intersects
the current clip. The `radii` is a _progressive enhancement_: a
scissor-test GPU path may ignore it.

- **Canvas2D** — `ctx.roundRect` + `ctx.clip()` inside `save`/`restore`
  (`CanvasRenderer.ts:373`). Scoped, correct.
- **SVG** — synthetic: a fresh `<clipPath id="clip-N"><rect|path …/>`
  plus `<g clip-path="url(#clip-N)">`, closed by popping `clipDepth`
  on `restore()` and by closing tags in `toXMLString()`
  (`SVGRenderer.ts:510`, `:543`). Cost is DOM size, not fill rate.
- **Three** — scissor rect in backing-store pixels, transformed by the
  current matrix and flipped to bottom-left origin, intersected with any
  enclosing scissor (`ThreeRenderer.ts:449`). Scissor is rectangular
  only; rounded clips degrade to their AABB.
- **`clipChildren`** — a `Scene`/entity-level flag, _not_ the renderer
  `clip()` call, that virtualizes hit, a11y and content projection.
  Both `Scene.ts:254` (hit) and `Scene.ts:4305` (culling) intersect the
  world box of every `clipChildren` ancestor; `isHitEligible` re-checks
  with the exact rotation-aware local rect.

Known clip gap: `IRenderer.fill` cannot express `fillRule: 'evenodd'`
(`forge/findings/renderer-and-gpu.md:38`). `Canvas2D` and `SVG` can do
even-odd (`ctx.fill('evenodd')`, `<path fill-rule="evenodd">`), but the
interface exposes only `fill(colorOrGradient)`. A compound path with
more than one closed component therefore fills `nonzero` on every
backend. The prescribed shape is a backward-compatible optional
`fillRule` argument on `fill`, to be implemented consistently before
consumers drop their diagnostic guard.

## DPR scaling and backing-store caps

```text
CanvasRenderer.ts:219  effectiveDPR()  = min(real DPR, maxDPR)
CanvasRenderer.ts:244  pixelRatio      = appliedDPR (recorded, not live)
CanvasRenderer.ts:119  constructor / resize apply scale(dpr, dpr)
WebGLPointRenderer.ts:972  same clamp for the point layer
ThreeRenderer.ts:307   effectiveDPR() / pixelRatio via getPixelRatio()
Scene.ts:286           SceneOptions.maxDPR — syncs to every renderer on resize
```text

Three invariants:

1. **Clamp, don't trust.** `maxDPR` (`SceneOptions.maxDPR`,
   `CanvasRenderer.ts:66`) caps backing-store growth. `maxDPR: 2` is
   a sane default, _not_ a guarantee — a per-frame stroke pass with
   thousands of thin segments measured `16.7 ms` at DPR1 vs `140 ms` at
   DPR2 on the same content (`forge 2026-07-18` backing-store cap).
   Expensive passes may need `maxDPR: 1` even when the engine default
   is 2.

2. **Applied, not live.** `pixelRatio` reports the ratio the context
   is _currently scaled by_ (`appliedDPR`), not `effectiveDPR()`
   re-read on access (`CanvasRenderer.ts:234`). A live getter would
   report the _future_ DPR during the window between a zoom/DPR change
   and the next `resize`, and a caller rasterizing from it would produce
   a texture the still-old context resamples. Caches keyed on
   `pixelRatio` (e.g. `GlyphRasterAtlas`, `Markdown` code atlas pool)
   therefore re-key only after the resize that actually reallocates.

3. **Resize invalidates style caches.** Setting `canvas.width/height`
   resets the whole 2D context to `10px sans-serif / #000` per spec.
   `CanvasRenderer.resize` drops `_cachedFont/_cachedFill/_cachedStroke`
   and batch state (`CanvasRenderer.ts:258`) and records the new
   `appliedDPR`. `contextrestored` does the same (`CanvasRenderer.ts:164`);
   a missing drop is a stale-cache repaint at the default font. The
   matching `WatchDevicePixelRatio` media-query loop re-arms on every
   change (`ThreeRenderer.ts:338`, `Scene` equivalent) so a drag
   between displays or a zoom triggers a real `resize`.

Pre-rasterized bitmaps must sit on this:

- `GlyphRasterAtlas` and `TextRasterCache` rasterize at a construction-
  time `dpr` (`GlyphRasterAtlas.ts:174`, `TextRasterCache.ts:88`) but
  their lookup keys historically omitted it (`forge 2026-08-25`):
  reusing one atlas across a DPR change served stale-density bitmaps
  under identical keys and blitted them resampled (blurry). The doc
  contract says "an atlas is keyed by DPR and replaced on change"
  — safety depends on caller discipline unless the key folds the DPR.
- `SplineEntity.bake` once read raw `window.devicePixelRatio`
  (`SplineEntity.ts:433` pre-fix) while its blit went into a `maxDPR`-
  clamped context — an over-resolution bitmap downsampled every frame.
  Fixed to read `renderer.pixelRatio` at render time and re-bake on
  change (`SplineEntity.ts:504`).

## Viewport culling

`Scene` culls strictly against the viewport: an entity whose _fill box_
is fully outside the viewport is skipped (`Scene.ts:7254` cull trace).
Two refinements:

- **Stroke inflation.** `Circle.getBounds()` / `Rect.getBounds()` now
  inflate by `strokeWidth/2` when stroked (`Circle.ts:67`,
  `Rect.ts:54`, fixed `@vectojs/core@2.18.3` CTX-0261). Before, a
  thick stroke at the viewport edge lost up to half its width. The
  `-0` follow-up (`-inflation` negating `0`) needed a positive-only
  negate (`forge 2026-08-08` `-0` entry).
- **Clip-aware culling** (`Scene.ts:4335`). `projectionBoxVisible`
  intersects the viewport with every `clipChildren` ancestor's AABB;
  off-viewport-but-clipped-in content is virtualized (boss 03). An
  unbounded full-viewport overlay is intentionally never clipped
  (`Scene.ts:4238`).

## Batching and draw-call economics

| path                          | mechanism                                                        | cap / cost                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fillCircle` (Canvas2D)       | same-color, same-alpha run → one path, one `fill()` on `flush()` | `MAX_BATCH = 64` (`CanvasRenderer.ts:88`) — superlinear beyond                                                                                                           |
| `fillCircle` (SVG)            | one `<path d="… A … A …">` per flush                             | no GPU cost, DOM size                                                                                                                                                    |
| `fillCircle` (WebGL/Three)    | instanced quads / `CircleGeometry`                               | near-constant; only flush matters                                                                                                                                        |
| `drawImage` / `drawImageRect` | none — immediate `drawImage` / `<image>`                         | atlas (`GlyphRasterAtlas`) keeps one source texture; `TextRasterCache` per-canvas sources measured **0.87×** (`fillText` baseline) at 40k cells vs **~2×** for the atlas |

`CanvasRenderer.flush` (`CanvasRenderer.ts:414`) restores `globalAlpha`
from its pre-batch value (not `1`) and updates `_cachedFill` to the
batch color — otherwise the next `fill('red')` with a stale cache skips
the assignment and paints the batch color. A pending batch is committed
before `drawImage`, `beginPath`, `save`/`restore`, `clip`, `fill`,
`stroke` and `fillText`.

`ThreeRenderer.flush` (`ThreeRenderer.ts:957`) _only_ marks `frameDirty`.
The real GL render is `present()` (`ThreeRenderer.ts:968`), called once
by `Scene` at frame end; without this, `O(N)` flushes would cost
`O(N²)` renders. Older `Scene` builds that never call `present()` are
covered by a microtask fallback.

WebGL-specific: `setTexture` now commits the sprite batch before
`texImage2D` when the source changes (`WebGLPointRenderer.ts:974`,
fixed `@vectojs/core@2.18.3`), mirroring `setMSDFTexture`. `ctx.filter
= 'blur()'` cost is deferred to the _next_ pixel read
(`forge 2026-07-18` `ctx.filter` entry) — blur at half resolution when
possible.

## Text raster paths

`fillText` is CPU-shaping + color-parse + rasterization at up to
5 000 calls/frame; the GPU sits idle (`(program)` dominates).
Two opt-in caches convert shaping into blits:

- `GlyphRasterAtlas` (`GlyphRasterAtlas.ts:1`) — one canvas, shelf-
  packed slots, `drawImageRect` sub-rects. For bounded monospace sets
  (code grid, terminal). Needs `drawImageRect`; `SVGRenderer` is not a
  target.
- `TextRasterCache` (`TextRasterCache.ts:1`) — one small canvas per
  `(font, color, text)` run, `drawImage` blit. For bounded phrase sets
  (danmaku 395 codepoints → one `≤1024²` MSDF atlas). Both bound memory
  (atlas shelf + reset counter, cache `maxEntries` with 10% insertion-
  order eviction) and fall back to `fillText` headlessly. The 5 000-
  danmaku wall was _not_ shaping but draw-count + overdraw: swapping
  `fillText→drawImage` changed nothing; batching glyphs into ~1 WebGL
  draw via `MSDFTextEntity` / `pointRenderer.addGlyph` moved it from
  `~28 fps` → `~130 fps` (`forge 2026-07-20` correction, `bakudan` v0.5).

Three's text path rasterizes at `dpr` (`ThreeRenderer.ts:747`) and keys
the texture cache on `dpr|font|color|text|gradient-definition` plus,
for gradients, the rounded `x,y` phase (`ThreeRenderer.ts:806`). Font
size is parsed by `parseFontSize` (`ThreeRenderer.ts:274`), _not_
`parseInt` — the styles shorthand puts weight first (`'700 16px Inter'`)
so naïve `parseInt` read `700`. Baseline: the alphabetic baseline lands
at `y`; Three's `PlaneGeometry` centre is offset by `-fontSize + h/2`
(`ThreeRenderer.ts:831`).

## Scene wiring (where the renderer's knobs are set)

```text
Scene.ts:226  SceneOptions.pointBackend: 'canvas' | 'webgl'   (glyphs/sprites)
Scene.ts:233  SceneOptions.particleBackend: 'auto'|'webgpu'|'cpu' (compute particles)
Scene.ts:286  SceneOptions.maxDPR               → syncs to pr.maxDPR on every resize
Scene.ts:398  SceneOptions.renderMode: 'always' | 'onDemand'
Scene.ts:1142 Scene.renderMode + DirtyTracker + RenderScheduler (maxFPS / autoThrottle)
Scene.ts:2284 full-window viewport adoption (once) + disableWindowResize
Scene.ts:2781 clientToScene viewport mapping
```text

- **`pointBackend` vs `particleBackend` are different features**
  (`forge 2026-08-26`). `pointBackend: 'webgl'` batches glyph/sprite
  quads; `particleBackend: 'webgpu'` drives
  `WebGPUParticleSystemManager` for `ComputeParticleEntity`. No WebGPU
  glyph/MSDF path exists; flipping `particleBackend` does nothing for
  danmaku.
- **`WebGPUParticleSystemManager` is opt-in via a static**
  (`forge 2026-08-02`): `Scene.registerWebGPUParticleSystemManager(...)`.
  On default `'auto'` without registration there is no throw and no
  `console.warn` — the CPU fallback runs while `initWebGPUContext`
  still allocates an unused stacked canvas.
- **`renderMode: 'always'`** (default) drives a continuous rAF loop;
  `autoThrottle` drops it to `idleFPS` when static. **`'onDemand'`**
  paints only after `markDirty()` or an active animation/physics tick.
  `render()` itself renders unconditionally — `renderMode` only affects
  the loop scheduler (`Scene.ts:3405`).

## Known pitfalls (with file:line)

| pitfall                                                                                                                | where                                                                                         | status                                    |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Even-odd fill not expressible (`IRenderer.fill` has no `fillRule`)                                                     | `IRenderer.ts:287`, forge 2026-07-18                                                          | open                                      |
| No shadow/glow primitive (`shadowBlur` absent; `ctx.filter` blur cost deferred)                                        | `IRenderer.ts:159` hints, forge 2026-07-18 / 2026-08-25                                       | open                                      |
| No backdrop blur/material for wallpaper sampling                                                                       | forge 2026-08-25                                                                              | open (stretch)                            |
| Glyph/Text raster keys omit DPR — stale-density bitmaps after DPR change                                               | `GlyphRasterAtlas.ts:174`, `TextRasterCache.ts:88`, forge 2026-08-25                          | open (contract=caller must replace atlas) |
| `WebGPUParticleSystemManager` requires `Scene.register…` static; silent CPU fallback on `'auto'`                       | `Scene.ts:256` registration gate, forge 2026-08-02                                            | open                                      |
| CPU vs GPU particle coordinate spaces disagree (window vs local)                                                       | `WebGPUParticleSystemManager.ts:310`, `ComputeParticleEntity.ts`, forge 2026-08-02 related    | compensated app-side                      |
| Backing-store sized at window DPR instead of clamped `appliedDPR`                                                      | `CanvasRenderer.ts:244`, `ThreeRenderer.ts:318`, `SplineEntity.ts:504`                        | fixed                                     |
| `resize` left font/fill caches stale across context reset                                                              | `CanvasRenderer.ts:258`, forge 2026-08-13 `CanvasRenderer.resize`                             | fixed #463                                |
| `flush` mutated `fillStyle`/`globalAlpha` without updating caches                                                      | `CanvasRenderer.ts:414`, forge 2026-08-13                                                     | fixed #469                                |
| `parseColorToRGBA` returned prior parse on invalid input                                                               | `renderer/colorParse.ts:60`, forge 2026-08-13                                                 | fixed #492                                |
| `SplineEntity.bake` used raw `window.devicePixelRatio`                                                                 | `SplineEntity.ts:433` pre-fix, forge 2026-08-13                                               | fixed #492                                |
| `WebGLPointRenderer.setTexture` missed batch flush                                                                     | `WebGLPointRenderer.ts:974`, forge 2026-08-13                                                 | fixed #520                                |
| `ThreeRenderer.fillText` parsed weight as size; baseline off by `fontSize/2`                                           | `ThreeRenderer.ts:274`, `:831`, forge 2026-08-13 / #486                                       | fixed #511                                |
| Mirrored ortho culled `FrontSide` fills/circles/gradients/images                                                       | `ThreeRenderer.ts:250`, forge 2026-08-13                                                      | fixed #519                                |
| `drawImage` vertically flipped (`flipY = true`) on y-down camera                                                       | `ThreeRenderer.ts:478`, forge 2026-08-23 #603                                                 | fixed #613                                |
| Hairline strokes (`LineBasicMaterial.linewidth` ignored); DPR ignored; GL context leaked; gradients >8 stops resampled | `ThreeRenderer.ts:110` ribbon, `:307`, `ThreeRenderer.ts:1044` dispose, forge 2026-08-23 #604 | fixed #623                                |
| `getBounds()` excluded stroke → culling clipped `strokeWidth/2`                                                        | `Circle.ts:67`, `Rect.ts:54`, forge 2026-08-08                                                | fixed 2.18.3                              |
| `getBounds()` `-0` artefact enshrined in tests                                                                         | forge 2026-08-08 `-0` entry                                                                   | fixed 2.18.3                              |

## Checklist before you ship a renderer change

1. **Read `pixelRatio`, not `window.devicePixelRatio`.** If you
   rasterize a texture that will be blitted, key the cache on
   `renderer.pixelRatio` and re-rasterize after `resize`.
2. **DoubleSide and unflip.** Under the y-down ortho, every
   `Mesh`/`PlaneGeometry` needs `side: DoubleSide` and
   `texture.flipY = false` (`ThreeRenderer.ts:596`, `:478`).
3. **Flush-aware caches.** Any path that mutates `fillStyle` or
   `globalAlpha` must update the corresponding cache; anything that
   resets the context must drop it (`CanvasRenderer.ts:258`).
4. **Respect the batch.** Don't interleave a non-batched draw between
   same-style `fillCircle`s if you want them to coalesce; `flush()`
   before scissor/texture/alpha changes.
5. **Clip has three places.** Renderer `clip()` for paints, `clipChildren`
   for hit/A11y/content (`Scene.ts:254`, `:4335`), and viewport band
   for virtualization. Changing one without auditing the other two is a
   bug.
6. **Profile at real DPR.** `maxDPR: 2` is not a performance guarantee
   for stroke-heavy passes — measure at native DPR on real hardware with
   `benchmarks/run-browsers.sh` (both engines, headed).

## Relations

- **Boss 03 (projection & virtualization)** owns `clipChildren` and the
  `projectionBoxVisible` / content-tier policy this boss's culling
  mirrors.
- **Boss 06 (VMT runtime)** owns `Scene.render`, the `RenderScheduler`
  / `DirtyTracker` policy, and the `worldMatrix` that every renderer
  consumes.
- **Boss 02 (text/layout)** owns the metrics this boss rasterizes.
  **Boss 09 (Three/XR)** reuses every trap in this doc — ribbon
  strokes, scissor clips, DPR, and DoubleSide are its starting kit.
  **Boss 08 (WASM)** re-uses the same `Scene` viewport and DPR values;
  a stale typed-array view across memory growth is the next boss's
  version of a stale raster cache.
