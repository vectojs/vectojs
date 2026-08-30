---
title: "09 — Three.js / XR Bridge — Two Coordinate Worlds"
description: "The adapter between VectoJS's 2D canvas contract and Three.js 3D space: CanvasTexture panels, raycast→UV→scene mapping, offscreen focus/keyboard ownership, and how Graph3D shows the pure-Three counterpart."
order: 29
---

# 09 — Three.js / XR Bridge — Two Coordinate Worlds

> **Boss 09** lives where two input models collide. VectoJS renders to a 2D logical-pixel scene with a transparent a11y DOM that owns pointer and keyboard dispatch; Three.js renders to a WebGL scene where a pointer is a ray and a panel is a textured quad floating in world space. `ThreeAdapter` is the only piece that speaks both.

- **What you'll learn**: why the adapter is a coordinate-system bridge, not a renderer; the `CanvasTexture` texture path and its `needsUpdate` proxy; how `Raycaster` UVs map to logical pixels (and the DPR trap); how pointer, wheel, hover, focus and keyboard ownership are re-routed through an offscreen canvas; and how `Graph3D`/`GraphCamera`/`GraphInteraction` demonstrate the pure-Three alternative.
- **What you won't**: the `IRenderer` contract itself (boss 07), text rasterization and the y-down ortho details (boss 07 §Text raster paths), WASM acceleration (boss 08), or 2D force-layout tuning (boss 11). This doc is the seam _between_ VectoJS's 2D contract and a 3D host.

## 1. Why the adapter is hard — two worlds, one canvas

A normal VectoJS `Scene` owns a `<canvas>` inserted in the page. Its a11y mirrors are appended to that canvas's `a11yRoot` (a `<div>` stacked over the canvas), and pointer/keyboard dispatch runs through those mirrors (`Scene.ts:3512` per-mirror listeners). In the bridge the canvas is **offscreen** — it is never inserted into the document, it is sampled as a GPU texture.

That single fact cascades:

| world       | who owns input                                      | where pixels live                    | who owns focus                                                                       |
| ----------- | --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| VectoJS 2D  | projected a11y DOM (`Scene` per-mirror listeners)   | `canvas.width/height` backing store  | `document.activeElement` + `Scene.focusedA11yElement` (`Scene.ts:1446`)              |
| Three.js 3D | `THREE.Raycaster` + `window`/`domElement` listeners | `CanvasTexture` on a `PlaneGeometry` | Three has no DOM focus; the host's `OrbitControls` or `GraphCamera` owns the pointer |

`ThreeAdapter` (`packages/three/src/ThreeAdapter.ts:90`) has to make a 2D scene that thinks it is on-screen behave correctly while its pixels are behind a 3D hit-test and its mirrors are permanently disconnected from `document`.

The other module in the package, `ThreeRenderer` (`packages/three/src/ThreeRenderer.ts:216`), is a different answer to the same prompt: it _is_ an `IRenderer` (`IRenderer.ts:41` contract) that renders VectoJS entities with Three.js instead of `CanvasRenderingContext2D`. The adapter wraps a Scene-as-texture; the renderer replaces the 2D context. They share the same y-down ortho and DPR traps (boss 07) but have opposite ownership: the adapter's `vectoScene` still renders with `CanvasRenderer` by default, the renderer's `scene/camera/renderer` (`ThreeRenderer.ts:219`) renders entities directly.

## 2. The texture path — from VectoJS pixels to a Three.js quad

```ts
// packages/three/src/ThreeAdapter.ts:125 — construction (abbreviated)
this.canvas = optCanvas ?? (document ? document.createElement('canvas') : offscreenFallback);
this.vectoScene = new VectoScene(this.canvas, { disableWindowResize: true, ...sceneOptions });
this.texture = new THREE.CanvasTexture(this.canvas);
this.texture.minFilter = THREE.LinearFilter; // ThreeAdapter.ts:151
this.texture.magFilter = THREE.LinearFilter; // ThreeAdapter.ts:152
this.vectoScene.render = (renderer, dt, time) => { originalRender.call(...); this.texture.needsUpdate = true; }; // ThreeAdapter.ts:157
this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false })); // ThreeAdapter.ts:163
```

Design notes with `file:line`:

- **Offscreen canvas ownership** — `ThreeAdapter.ts:122` `_ownsCanvas` tracks whether the adapter created the canvas. `dispose()` (`ThreeAdapter.ts:750`) only zeroes `canvas.width/height` when it owns the canvas; a caller-supplied canvas is left alone. The SSR fallback (`ThreeAdapter.ts:78` `OffscreenCanvasFallback`) spells out exactly which members exist when `document` is undefined — a bare `{width,height} as HTMLCanvasElement` previously hid that contract.
- **Resize is manual** — `sceneOptions.disableWindowResize = true` (`ThreeAdapter.ts:140`) because a full-window `Scene` auto-adopts `window.innerWidth/Height` (`Scene.ts:2284`). A texture-backed scene must not follow the window; the host calls `adapter.resize(w,h)` (`ThreeAdapter.ts:713`) which resizes the backing store, the Scene viewport, and marks `texture.needsUpdate`.
- **Dirty-gated upload** — the render proxy (`ThreeAdapter.ts:155`) sets `texture.needsUpdate = true` only when the Scene actually redrew. A continuous `Scene.renderMode: 'always'` loop still uploads every frame; an `onDemand` Scene uploads only when `markDirty()` fired — which every input path does (`ThreeAdapter.ts:270`, `ThreeAdapter.ts:612`).
- **Default mesh is convenience, not prescription** — `mesh` is a unit `PlaneGeometry(1,1)` (`ThreeAdapter.ts:163`). Hosts that need curved screens, billboards, or VR dashboards replace the geometry/material and keep the `texture`. The mesh is pre-added to no scene; the host does `scene3d.add(adapter.mesh)`.
- **Disposal hygiene** — `dispose()` (`ThreeAdapter.ts:723`) restores `vectoScene.render` to `_originalRender` (`ThreeAdapter.ts:730`) _before_ destroying the Scene, otherwise a surviving reference would set `needsUpdate` on a deleted texture and Three logs `trying to use deleted texture`. It then disposes `texture`, `geometry`, `material`(s), removes `mesh` from its parent, calls `vectoScene.destroy()`, clears `activePointers`, drops `_focusedEntity` without emitting (mirrors no longer exist), and zeroes the canvas only if owned.

`ThreeRenderer` is the alternate texture path — no adapter canvas at all. It owns its own `THREE.Scene` + `THREE.OrthographicCamera(0,width,0,height)` + `THREE.WebGLRenderer({canvas, alpha:true, antialias:true})` (`ThreeRenderer.ts:256`). Its y-down ortho, `effectiveDPR`/`pixelRatio` clamping, context-loss recovery and `present()` deferral are covered in boss 07; the bridge-specific facts are that it implements `IRenderer` so any `Entity.render(r)` runs unchanged, and its `fillText`/`drawImage` caches key on `dpr` and rounded `x,y` phase (`ThreeRenderer.ts:1002`).

Bridge-relevant internals worth naming so you don't re-discover them:

- **DPR** — `effectiveDPR()` (`ThreeRenderer.ts:309`) is `min(real DPR, maxDPR)` and `pixelRatio` (`ThreeRenderer.ts:324`) is the live `renderer.getPixelRatio()`, not a snapshot. `Scene` syncs `maxDPR` onto the renderer on every `resize` (`Scene.ts:286`); `ThreeRenderer.resize` (`ThreeRenderer.ts:355`) re-applies the clamped ratio before `setSize`/`updateProjectionMatrix`. A texture keyed on `window.devicePixelRatio` instead of `pixelRatio` blurs on a clamped display.
- **Context loss** — `webglcontextlost` is `preventDefault`ed (`ThreeRenderer.ts:281`) so `webglcontextrestored` can fire; the restore handler re-applies `effectiveDPR`, re-sizes, marks `frameDirty` and `present()`s into the cleared framebuffer (`ThreeRenderer.ts:285`). `dispose()` detaches both listeners and calls `renderer.forceContextLoss()` (`ThreeRenderer.ts:1186`) so SPA remounts don't leak live GL contexts.
- **Y-down consequences** — every filled primitive needs `side: DoubleSide` (`ThreeRenderer.ts:596` fill, `:658` drawImage, `:1049` fillText) and `texture.flipY = false` (`ThreeRenderer.ts:628` drawImage, `:1035` fillText); without both, FrontSide faces are culled and images/text are upside-down under the y-down ortho (`ThreeRenderer.ts:250`).
- **Caches** — `textTextureCache` (`ThreeRenderer.ts:911`) and `imageTextureCache` (`ThreeRenderer.ts:599`) are identity-keyed, LRU-evicted at `256` (`ThreeRenderer.ts:635`, `:1040`), flagged `userData.vectoCached` so the per-frame `disposeActiveObjects` (`ThreeRenderer.ts:380`) skips them, and `drawImage` re-inserts on hit for LRU order (`ThreeRenderer.ts:641`). Mutable canvas sources must call `invalidateImage` (`ThreeRenderer.ts:602`).

## 3. Coordinate mapping — UV → logical pixels (and the three traps)

### 3.1 The raycast entry

```ts
// packages/three/src/ThreeAdapter.ts:181
public updateIntersection(raycaster: THREE.Raycaster, type, originalEvent?): boolean {
  const intersects = raycaster.intersectObject(this.mesh); // ThreeAdapter.ts:186
  if (intersects.length > 0 && hit.uv) {
    state.lastUv.copy(hit.uv);
    this.dispatchAtUv(type, hit.uv, pointerId, originalEvent);
  } else if (state.isHovering) {
    this.dispatchAtUv('pointerleave', state.lastUv, pointerId, originalEvent); // ThreeAdapter.ts:209
  }
}
```

The caller owns the `Raycaster` — typically `raycaster.setFromCamera(ndc, camera)` where `ndc` is `((clientX/width)*2-1, -((clientY/height)*2-1))`. That is `GraphInteraction.setPointerFromEvent` (`packages/graph3d/src/GraphInteraction.ts:157`) and `GraphCamera` wheel zoom (`packages/graph3d/src/GraphCamera.ts:363`) shape.

### 3.2 UV to scene pixels — logical, not backing store, y-flipped

```ts
// packages/three/src/ThreeAdapter.ts:240
private dispatchAtUv(type: VectoEvent, uv: THREE.Vector2, ...): void {
  const px = uv.x * this.vectoScene.width;        // ThreeAdapter.ts:251 — logical width
  const py = (1.0 - uv.y) * this.vectoScene.height; // ThreeAdapter.ts:253 — flip Three's bottom-origin
  this.dispatchAtPoint(type, px, py, ...);
}
```

Three traps, each behind a fixed bug:

1. **Logical vs backing store (DPR)** — `canvas.width = logicalWidth * devicePixelRatio` on HiDPI (`CanvasRenderer` backing store, boss 07 §DPR). Entity layout and `findEntityAt` are logical. Multiplying `uv.x * canvas.width` lands every hit `dpr`× off. The comment at `ThreeAdapter.ts:246` states this explicitly; the programmatic entry (`dispatchPointer`, `ThreeAdapter.ts:675`) takes logical `x,y` for the same reason. `ThreeRenderer` has the matching trap on the scissor path (`ThreeRenderer.ts:468` `dpr = renderer.getPixelRatio()`) and on fillText rasterization (`ThreeRenderer.ts:987`).
2. **Y flip** — Three's UV origin is bottom-left, Canvas is top-left. `py = (1 - uv.y) * height` (`ThreeAdapter.ts:253`). `ThreeRenderer` unflips textures for the same reason (`ThreeRenderer.ts:628` `texture.flipY = false`, `ThreeRenderer.ts:1035` fillText).
3. **Off-panel clicks** — a miss when `state.isHovering` synthesizes `pointerleave` at `lastUv` (`ThreeAdapter.ts:209`) and, on `pointerdown`, blurs panel focus (`ThreeAdapter.ts:214` `if (pointerdown && _focusedEntity) setFocusedEntity(null)`) — mirroring how a click on page background moves DOM focus.

### 3.3 The shared dispatch core

Both `updateIntersection` (raycast UV) and `dispatchPointer` (logical pixels, `ThreeAdapter.ts:675`) converge on `dispatchAtPoint` (`ThreeAdapter.ts:262`):

```ts
private dispatchAtPoint(type, px, py, pointerId, originalEvent): boolean {
  this.vectoScene.markDirty();                          // ThreeAdapter.ts:270 — onDemand wake
  const hitEntity = this.vectoScene.findEntityAt(px, py); // ThreeAdapter.ts:273 — VMT hit test
  // hover transitions (ThreeAdapter.ts:277), pointerleave dedup (ThreeAdapter.ts:291),
  // then dispatchEventToTarget or canvas fallback (ThreeAdapter.ts:307)
  // then pointerdown focus (ThreeAdapter.ts:320)
}
```

`findEntityAt` is the same hit tester the on-screen Scene uses (`HitTester.ts:12`, boss 06), including `clipChildren` gating and rotation-aware bounds — no 3D-specific hit path.

## 4. Input routing — pointer, wheel, hover, and multi-touch

### 4.1 Hover transitions are per-pointer

`activePointers: Map<number, PointerState>` (`ThreeAdapter.ts:101`) tracks `{isHovering, lastUv, lastTargetId}` per `pointerId` (`ThreeAdapter.ts:64`). The `pointerId` is read from the original `PointerEvent` (`ThreeAdapter.ts:187`) or defaults to `1` for programmatic/mouse paths. On `pointermove` the adapter diffs `lastTargetId` against the current `hitEntity.id` and emits `pointerleave` on the old entity and `hover` on the new one (`ThreeAdapter.ts:277`). On a synthetic `pointerleave` (mesh exit) it emits once via `dispatchEventToTarget` and returns `false` to suppress the trailing fallback dispatch that would duplicate the leave (`ThreeAdapter.ts:291` comment + early return).

The history here: the pre-fix adapter emitted `pointerleave` twice (once via the tracked `lastTargetId`, once via the generic fallback at `lastUv`) and leaked a leave to whichever entity happened to sit under `lastUv` after the cursor left (`vectojs-docs/forge/findings/renderer-and-gpu.md:620`).

### 4.2 Multi-touch / WebXR

Touch contacts receive fresh, monotonically increasing `pointerId`s. Without pruning, `activePointers` grew by one entry per tap for the adapter's lifetime. `pruneEndedPointer` (`ThreeAdapter.ts:228`) deletes the entry on `pointerup`/`pointercancel` after the final dispatch has read it. `ThreeRenderer` had the same class of leak in `imageTextureCache`/`textTextureCache` (fixed `ThreeRenderer.ts:635` LRU eviction).

`GraphCamera` has the complementary guard at the 3D layer: an active drag owns its `pointerId` until its own `pointerup`/`pointercancel` — a second contact must not overwrite `dragging`/`lastX`/`button` (`packages/graph3d/src/GraphCamera.ts:305`).

### 4.3 Wheel — no neutral defaults

`createDOMEvent` (`ThreeAdapter.ts:372`) branches on `type === 'wheel'`: a `WheelEvent` is synthesized with `deltaX/Y/Z/deltaMode` copied from the original `WheelEvent` when present, otherwise `0` (`ThreeAdapter.ts:381`). Pointer fields synthesize `button/buttons/modifiers` with the same neutral defaults the raycaster path produces when no original event was supplied (`ThreeAdapter.ts:48` `ThreeAdapterPointerInit` doc). `dispatchPointer` explicitly does **not** cover wheel (`ThreeAdapter.ts:664` doc — deltas have no neutral defaults; route wheel through `updateIntersection` with the real `WheelEvent`).

Every dispatched event carries `clientX/clientY = px/py` (logical scene pixels) and non-standard `vectoSceneX/Y` properties (`ThreeAdapter.ts:412` `Object.defineProperties`) so handlers that need scene space don't have to un-flip or un-scale. `originalEvent` is forwarded as the `VectoJSEvent.nativeEvent` (`ThreeAdapter.ts:364`) so handlers can read `deltaMode`/`button` verbatim.

`ThreeAdapterPointerInit` (`ThreeAdapter.ts:54`) documents the defaults for the programmatic path: `button`/`buttons` 0, modifiers off — indistinguishable from the raycaster path when no original event is supplied. `ThreeAdapterPointerType` (`ThreeAdapter.ts:40`) is the closed union the two entry points accept; `type` is widened to `VectoEvent` only inside `dispatchAtPoint` (`ThreeAdapter.ts:263`).

### 4.4 Programmatic driving vs raycast driving

The two entry points are intentionally symmetric but not identical:

| entry                                                                | caller supplies                        | UV step                                                            | wheel                                    | use for                                  |
| -------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------- |
| `updateIntersection(raycaster, type, event)` (`ThreeAdapter.ts:181`) | `THREE.Raycaster` + DOM `Event`        | `raycaster.intersectObject(this.mesh)` → `hit.uv` → `dispatchAtUv` | yes — `WheelEvent` forwarded with deltas | live 3D pointer/wheel, VR controller ray |
| `dispatchPointer(type, x, y, init)` (`ThreeAdapter.ts:675`)          | logical `x,y` + optional `PointerInit` | none — `x,y` are already scene pixels                              | no — deltas have no neutral defaults     | tests, automation, headless              |

Both converge on `dispatchAtPoint` (`ThreeAdapter.ts:262`) so hover transitions, focus, `markDirty` and the `isConnected` dispatch gate behave identically. `dispatchPointer` is the only entry that creates its own `PointerEvent` (`ThreeAdapter.ts:690`) — it must, because there is no backing DOM event in the programmatic case.

### 4.5 Canvas fallback

When `findEntityAt` returns `null` (dead space), the event is dispatched on `this.canvas` itself (`ThreeAdapter.ts:312` `canvas.dispatchEvent(fallbackEvent)`). For on-screen Scenes this would bubble through the a11y mirrors; for the offscreen adapter it lets Scene-level handlers still observe background clicks (which then blur focus, see §5).

## 5. Focus and keyboard ownership — offscreen, so synthetic

### 5.1 Why panel focus is not `document.activeElement`

The adapter's canvas is never appended to `document`, so its `a11yRoot` (the container `Scene` creates for mirrors) is also never connected. `getA11yElement(entity.id)` still returns a real element (`Scene.syncA11y` populates it regardless), but `el.isConnected === false` permanently. Native APIs that require a connected element (`setPointerCapture`, robust `focus()`) throw on such elements, so the adapter treats disconnected mirrors as absent.

Panel focus is therefore **adapter-side state**: `ThreeAdapter._focusedEntity` (`ThreeAdapter.ts:111`) with the doc comment explaining the gap and the synthetic `FocusEvent` bridge. Access via `focusedEntity` getter (`ThreeAdapter.ts:441` — returns `null` when disposed) and `focus(entity|null)` / `blur()` (`ThreeAdapter.ts:458`).

### 5.2 How focus moves

- **Pointer-driven** — after the event is dispatched, `pointerdown` focuses the nearest focusable ancestor of the hit entity (`ThreeAdapter.ts:321` `focusNearestFocusable(hit)`), or blurs on dead space. `focusNearestFocusable` (`ThreeAdapter.ts:499`) walks `hit.parent` chain and tests `isFocusable` at each node — so clicking a `<span>` inside a `<button>` focuses the button, matching DOM. If nothing in the chain is focusable, it blurs (`ThreeAdapter.ts:506`). The focus transition runs _after_ the event so handlers observe the pre-click focus world, matching native `pointerdown`-then-focus ordering (`ThreeAdapter.ts:319` comment).
- **Programmatic** — `focus(entity)` (`ThreeAdapter.ts:458`) accepts any entity (even non-focusable) so tests/automation can force focus; the pointer path is stricter and only focuses what the projection declares reachable.
- **`isFocusable` contract** (`ThreeAdapter.ts:478`) — true when the mirror carries `tabindex` (explicit `tabIndex` or the implicit `0` core adds for interactive ARIA roles) or renders as a natively-focusable tag (`button`/`input`/`textarea`/`select`/`a[href]`). Falls back to raw `getA11yAttributes()` values before the first projection sync.

### 5.3 The synthetic FocusEvent bridge

`setFocusedEntity` (`ThreeAdapter.ts:516`) dispatches synthetic `FocusEvent('blur')` on the previous mirror and `FocusEvent('focus')` on the next mirror when they exist; otherwise it `emit`s directly on the entity. This lets core's own listeners run unchanged: entity `focus`/`blur` emits, `Scene.focusedA11yElement` tracking, and `Input` caret-blink wake/cleanup. Every transition also `markDirty()` so focus visuals (caret, highlight) repaint in `onDemand` mode (`ThreeAdapter.ts:529`).

### 5.4 Keyboard routing — `dispatchKey` and ownership

```ts
// packages/three/src/ThreeAdapter.ts:573
public dispatchKey(key: string, mods: ThreeAdapterKeyModifiers = {}, phase: 'press'|'keydown'|'keyup' = 'press'): void {
  const init = { key, code: mods.code ?? ThreeAdapter.codeFor(key), ...mods, bubbles:true, cancelable:true };
  if (phase !== 'keyup') this.routeKeyEvent(new KeyboardEvent('keydown', init));
  if (phase !== 'keydown') this.routeKeyEvent(new KeyboardEvent('keyup', init));
}
```

`codeFor` (`ThreeAdapter.ts:597`) infers `KeyboardEvent.code` from `key`: letters to `Key<X>`, digits to `Digit<N>`, space to `Space`, others passed through — best-effort because `code` is layout-dependent.

`routeKeyEvent` (`ThreeAdapter.ts:610`) implements four rules (doc at `ThreeAdapter.ts:536`):

1. **No panel focus** — event goes straight to `window`; core's scene-level channel (`Scene.ts:3351` `dispatchKeyboard`) applies its native gates (`defaultPrevented`, auto-repeat, `ownsKeyboard(document.activeElement)`). Orbit-camera consumers and host inputs are never starved.
2. **Panel focus, at the mirror** — dispatch on the focused mirror so core's generic key forwarding and `#694` Enter/Space activation run. If no mirror exists, `VectoJSEvent` on the entity.
3. **Ownership — stop** — if `entityOwnsKeyboard(focused)` (`ThreeAdapter.ts:643`) returns true (tag `input`/`textarea`/`select`, or `role` in `KEYBOARD_OWNING_ROLES` from `Scene.ts:115` — `textbox`, `searchbox`, `spinbutton`, `option`, `listbox`, `button`, `link`, `tab`, `menuitem`, `slider`, `combobox`), the event is consumed; nothing leaks to `window`. The tag+role set mirrors `Scene.ownsKeyboard` (`Scene.ts:143`) and is documented as intentionally unified via the exported set.
4. **Otherwise, bubble to window** — unless `nativeEvent.defaultPrevented` or `cancelBubble` was set by an entity handler, matching connected-canvas bubbling. That gate is why a panel handler can `preventDefault()` on Enter to suppress a host shortcut.

This is the mechanism behind the `vectojs-three` skill recipe (`.agents/skills/vectojs-three/references/three-recipes.md:60`) `adapter.focus(panel); adapter.dispatchKey('Enter')` and the `isFocusable` guard.

## 6. Semantic projection inside 3D — what AT sees

On a connected canvas, `Scene.syncA11y` projects each interactive entity's `getA11yAttributes()` into a transparent, absolutely-positioned DOM mirror (role, label, tabindex, bounds). Screen readers and Playwright's `getByRole` drive those mirrors. Hit-testing and dispatched events are separable concerns: the Scene's `HitTester` (`HitTester.ts:12`) is the hit authority, while the mirrors are the dispatch transport (`Scene.ts:3512` per-mirror listeners) — a distinction the offscreen bridge relies on.

Inside `ThreeAdapter` the mirrors are created identically — `Scene` does not know the canvas is offscreen — but they are never connected to `document`. Consequences:

- **AT invisible by default** — a `CanvasTexture` panel is not in the page's a11y tree. If the 3D scene needs AT reachability, the host must either render a 2D overlay of the same Scene or expose the panel through a separate, connected Scene. The adapter does not invent this; it preserves the 2D projection contract and leaves the 3D-host's page structure to the host. This is the correct default: a texture has no DOM semantics.
- **Dispatch fallback — `isConnected` is load-bearing** — `dispatchEventToTarget` (`ThreeAdapter.ts:330`) checks `a11yEl && a11yEl.isConnected` (`ThreeAdapter.ts:349`). Connected mirrors get a real `PointerEvent`/`WheelEvent` dispatched on them so natively-bound widgets (e.g. a projected `<input>` that calls `setPointerCapture`, or the per-entity `focus()` path that calls `a11yEl.focus()` at `ThreeAdapter.ts:360`) work with the browser's native dispatch. Disconnected mirrors take the fallback: `new VectoJSEvent(type, entity, originalEvent, …, {x,y})` bubbled through the virtual tree (`ThreeAdapter.ts:363`). The comment at `ThreeAdapter.ts:341` explains the failure mode — a disconnected element throws on `setPointerCapture` and `focus()` is a no-op — so routing through the fallback is not a style choice, it's a correctness gate.
- **Pointer events are not gated by `pointerEvents: 'none'` on descendants** — the adapter's hit test is `findEntityAt` on the Scene, not CSS hit-testing. The `pointerEvents: 'none'` semantic that matters on the 2D page (boss 03, `ScrollView` `pointerEvents: 'none'` interaction) does not affect the 3D path; only the 2D mirror path respects it. In the adapter path the hit is already resolved before any DOM dispatch is attempted.
- **Focus mirrors the same split** — `setFocusedEntity` dispatches on the mirror when `isConnected` and `emit`s on the entity otherwise (`ThreeAdapter.ts:516`); the two paths drive the same core listeners (entity `focus`/`blur`, `Scene.focusedA11yElement`, caret blink) so `onFocus` handlers don't need to branch.

`ThreeRenderer` has no projection concern — it is a renderer, not a Scene — so it has no a11y path at all. A `ThreeRenderer`-backed Scene still projects through the normal 2D `Scene` a11y layer because the renderer never touches the `a11yRoot`.

Spot the difference on the two sides of the adapter's dispatch branch (`ThreeAdapter.ts:341` vs `ThreeAdapter.ts:363`):

```ts
// Connected mirror — real DOM dispatch, native capture/focus work
a11yEl.dispatchEvent(domEvent); // ThreeAdapter.ts:351
if (type === 'pointerdown' && (a11yEl instanceof HTMLInputElement || …)) a11yEl.focus();

// Disconnected mirror — virtual-tree bubble, no DOM
entity.dispatchEvent(new VectoJSEvent(type, entity, originalEvent, …, { x, y })); // ThreeAdapter.ts:363
```

## 7. The pure-Three counterpart — `Graph3D` family

`@vectojs/graph3d` shows what a non-adapter 3D consumer looks like — no `ThreeAdapter`, no Scene, no a11y projection. It is the reference for where the adapter is and isn't needed.

| piece                                | role                                                                                                                          | key file:line                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Graph3D`                            | instanced presentation: one `InstancedMesh` for nodes + one `LineSegments` for links under a single `group` (`Graph3D.ts:30`) | `Graph3D.ts:28` group, `Graph3D.ts:115` InstancedMesh, `Graph3D.ts:136` LineSegments                                         |
| `GraphCamera`                        | 2D ortho vs 3D perspective pan/zoom/orbit controls                                                                            | `GraphCamera.ts:73` GraphCamera, `GraphCamera.ts:200` setSize zoom fix, `GraphCamera.ts:354` wheel zoom-about-cursor         |
| `GraphInteraction`                   | `Raycaster` + NDC → `pickNode` → hover/select/drag-to-pin                                                                     | `GraphInteraction.ts:83` GraphInteraction, `GraphInteraction.ts:157` setPointerFromEvent, `GraphInteraction.ts:246` pickNode |
| `VectoForceLayout` / `D3ForceLayout` | layout contract feeding `Float32Array` positions to `applyPositions`                                                          | `packages/graph3d/src/layout/`                                                                                               |

Notable invariants that mirror adapter gotchas:

- **`setGraphData` throws before mutating** — link endpoints are resolved via `indexById` (`Graph3D.ts:80`) and validated (`Graph3D.ts:90` throw) before `clearMeshes()` (`Graph3D.ts:99`) or any mesh is attached, so a rejected graph leaves the scene intact (`Graph3D.ts:73` doc, `forge 2026-08-13` entry).
- **`applyPositions` guards NaN** — `positions.length < nodeCount*3` bails before writing, warns once per `setGraphData` (`Graph3D.ts:162` `hasWarnedShortPositions`, reset at `Graph3D.ts:100`), and skips the update to avoid NaN instance matrices and a NaN bounding sphere that would frustum-cull the whole mesh (`Graph3D.ts:148` doc). No per-link bounds check is needed because `setGraphData` validated every endpoint.
- **`pickNode` is instance-aware** — `raycaster.intersectObject(nodeMesh)` filtered to `h.instanceId != null` (`Graph3D.ts:248`), returning the `GraphData.nodes` index aligned with the layout.
- **`GraphCamera.setSize` zoom double-apply fix** — frustum stays at unzoomed half-extents; `camera.zoom` alone carries the zoom (`GraphCamera.ts:200` comment: baking zoom into the frustum _and_ setting `camera.zoom` made visible extent `1/zoom²` and snapped the graph out of view).
- **`GraphInteraction` pointer capture** — `setPointerCapture` on `domElement` at `pointerdown` (`GraphInteraction.ts:284`) and via `window` `pointerup`/`pointercancel` (`GraphInteraction.ts:135`) so a release outside the canvas still ends the drag and re-enables host controls; `dispose()` mid-drag runs the finish path (`GraphInteraction.ts:314`).

## 8. Gotchas and traps (with file:line)

| trap                                                  | where                                                              | symptom                                                                                   | fixed / status                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| UV × backing store instead of logical size            | `ThreeAdapter.ts:246` comment                                      | every hit off by `dpr`× down/right on HiDPI                                               | fixed — use `vectoScene.width/height`                                   |
| Y not flipped                                         | `ThreeAdapter.ts:253`                                              | hits mirrored vertically                                                                  | fixed — `(1-uv.y)*height`                                               |
| A11y mirror dispatched while disconnected             | `ThreeAdapter.ts:349` `isConnected`                                | `setPointerCapture` throws, `focus()` no-ops                                              | fixed — fallback to `VectoJSEvent`                                      |
| Duplicate `pointerleave` on mesh exit                 | `ThreeAdapter.ts:291` early return                                 | entity hit twice, neighbour leaked a leave                                                | fixed `ThreeAdapter.ts:291` skip trailing dispatch (`forge 2026-08-13`) |
| `activePointers` grew per tap                         | `ThreeAdapter.ts:228` `pruneEndedPointer`                          | unbounded Map, WebXR/multi-touch                                                          | fixed — delete on `pointerup`/`pointercancel`                           |
| Wheel has no neutral defaults                         | `ThreeAdapter.ts:664` doc                                          | `dispatchPointer('wheel',…)` would synthesize wrong deltas                                | by design — use `updateIntersection` with real `WheelEvent`             |
| Off-panel `pointerdown` didn't blur                   | `ThreeAdapter.ts:214`                                              | panel kept focus after clicking empty 3D space                                            | fixed — blur on outside `pointerdown`                                   |
| `render` proxy not restored on dispose                | `ThreeAdapter.ts:113` `_originalRender`                            | `needsUpdate` on deleted `CanvasTexture` → `THREE.Texture: trying to use deleted texture` | fixed `ThreeAdapter.ts:730`                                             |
| Canvas zeroed though caller-supplied                  | `ThreeAdapter.ts:122` `_ownsCanvas`                                | caller’s canvas blanked after dispose                                                     | fixed — only zero when owned                                            |
| `ThreeRenderer` `FrontSide` culled under y-down ortho | `ThreeRenderer.ts:250` camera, `ThreeRenderer.ts:596` `DoubleSide` | `fillCircle`/fills/gradients/drawImage invisible                                          | fixed (`forge 2026-08-13`, `ThreeRenderer.ts:596`)                      |
| `drawImage` vertically flipped                        | `ThreeRenderer.ts:628` `flipY = false`                             | every blitted image upside-down                                                           | fixed (`forge 2026-08-23`, `ThreeRenderer.ts:478`)                      |
| `LineBasicMaterial.linewidth` ignored                 | `ThreeRenderer.ts:110` `buildStrokeRibbon`                         | every stroke hairline                                                                     | fixed — ribbon geometry                                                 |
| `fillText` parsed weight as size                      | `ThreeRenderer.ts:274` `parseFontSize`                             | bold text 700px tall, baseline `fontSize/2` low                                           | fixed (`forge 2026-08-13 #486`, `ThreeRenderer.ts:274` + `:831`)        |
| `Graph3D` half-built on bad link id                   | `Graph3D.ts:73`                                                    | nodes attached, links missing, stale scales                                               | fixed `Graph3D.ts:80` resolve-first                                     |
| `applyPositions` undersized array → NaN               | `Graph3D.ts:148`                                                   | nodes vanish, frustum blank                                                               | fixed `Graph3D.ts:162` guard + latched warn                             |
| `GraphInteraction` dispose mid-drag                   | `GraphInteraction.ts:314`                                          | host controls stuck disabled                                                              | fixed — `finishDrag` in `dispose`                                       |
| `GraphCamera` double-zoom on resize                   | `GraphCamera.ts:200`                                               | zoom `1/zoom²`, graph snaps out                                                           | fixed — frustum stays unzoomed                                          |

## 9. Recipes — when to use which path

**Panel in a 3D scene (HUD, dashboard, VR screen):**

```ts
// .agents/skills/vectojs-three/references/three-recipes.md:10 + :24
import { ThreeAdapter } from "@vectojs/three";
import { Button, Stack, Text } from "@vectojs/ui";
const adapter = new ThreeAdapter({ width: 800, height: 500 });
const panel = new Stack({ direction: "vertical", gap: 16 });
panel.add(new Text("VectoJS in 3D", { font: "700 28px Inter" }));
adapter.vectoScene.add(panel);
adapter.vectoScene.start();
scene3d.add(adapter.mesh);
// pointer routing — raycaster owns the 3D hit, adapter owns the 2D dispatch
const handled = adapter.updateIntersection(raycaster, type, event);
if (handled) event.preventDefault();
```

- Call `adapter.updateIntersection(raycaster, type, event)` from `window`/`document` listeners, passing the real `PointerEvent`/`WheelEvent` so button/modifier state and wheel deltas forward. When `handled` is true the 3D hit was consumed — `preventDefault()` the host event so the page doesn't scroll/select underneath.
- Use `adapter.dispatchPointer(type, x, y)` (`ThreeAdapter.ts:675`) for tests/automation — logical pixels, same downstream path as the raycaster, but wheel stays on the raycaster path (no neutral delta to synthesize, `ThreeAdapter.ts:664`).
- Focus: `adapter.focus(entity)` / `adapter.blur()` (`ThreeAdapter.ts:458`), query with `adapter.isFocusable(entity)` (`ThreeAdapter.ts:478`). Keyboard: `adapter.dispatchKey('Enter')` (`ThreeAdapter.ts:573`) — full press by default, or `dispatchKey('a', {shiftKey:true}, 'keydown')` for held keys. Focus drives the `ownsKeyboard` gate that decides whether keys leak to `window`.
- Resize: `adapter.resize(w, h)` (`ThreeAdapter.ts:713`) when the host canvas or panel size changes; the Scene does not follow `window` (`ThreeAdapter.ts:140` `disableWindowResize`).
- Teardown: `scene3d.remove(adapter.mesh); adapter.dispose()` (`ThreeAdapter.ts:723`) — restores the render proxy (`ThreeAdapter.ts:730`), disposes texture/geometry/material, removes mesh, destroys Scene, clears pointers/focus.

**3D graph without a 2D panel:**

Use `Graph3D` + `GraphCamera` + `GraphInteraction` directly — no adapter. `Graph3D.group` is added to the host scene, `GraphCamera` owns the camera and its own `pointerdown/move/up/wheel` listeners (`GraphCamera.ts:150`), and `GraphInteraction` owns `pointermove/down` on `domElement` plus `window` `pointerup/cancel` for drag-outside. Wire them with `() => graphCamera.camera` getter so `setMode('2d'|'3d')` stays live (`GraphInteraction.ts:5` `GraphInteractionCamera`).

**Host owns the camera (e.g. `OrbitControls` + graph):**

Pass `setControlsEnabled` (`GraphInteraction.ts:53`) so a node drag disables the camera controls for the drag duration. The same pattern applies to an adapter panel that shares the canvas with a 3D scene: gate the panel's `updateIntersection` when the camera is dragging and vice versa.

## 10. Open questions and XR horizon

- **XR session delivery** — WebXR controllers produce `select`/`squeeze` + `XRInputSource` ray, not `PointerEvent`. The adapter's `pointerId` map (`ThreeAdapter.ts:101`) already generalizes to multi-pointer, but the host must synthesize `Raycaster` from the XR view + input pose and call `updateIntersection` per input source. No `XRRaycaster` helper exists yet.
- **Two panels, one canvas** — `updateIntersection` hit-tests a single `mesh` (`ThreeAdapter.ts:186` `intersectObject(this.mesh)`). Two adapters in one Three.js scene need per-adapter raycast or a shared `intersectObjects([a.mesh, b.mesh])` with dispatch by `hit.object`. The per-`pointerId` hover state is per-adapter, so cross-panel `pointerleave` is already isolated.
- **AT for 3D panels** — as §6 notes, offscreen mirrors are AT-invisible. An XR or WebGL-only deployment that needs AT must keep a connected 2D Scene (or a DOM overlay) in sync — the adapter doesn't solve this because the page's a11y tree is out of scope for a texture.
- **SSR / OffscreenCanvas** — `ThreeAdapter.ts:130` falls back to a `{width,height}` object when `document` is undefined. `THREE.CanvasTexture` still expects a tex-image source; hosts that pre-render on the server need a real `OffscreenCanvas` or a deferred adapter construction.

## 11. Checklist before you ship a change in this area

- [ ] **No `uv.x * canvas.width`.** Every UV→pixel path uses `vectoScene.width/height` (logical), not `canvas.width/height` (backing store). Grep `canvas\.width` in `packages/three/src/ThreeAdapter.ts`.
- [ ] **Y is flipped.** `py = (1 - uv.y) * height` (`ThreeAdapter.ts:253`); textures that blit into the scene are `flipY = false` (`ThreeRenderer.ts:628`, `:1035`).
- [ ] **`updateIntersection` and `dispatchPointer` converge.** New input semantics go in `dispatchAtPoint` (`ThreeAdapter.ts:262`) so the raycast and programmatic paths don't diverge.
- [ ] **`isConnected` gate preserved.** `dispatchEventToTarget` (`ThreeAdapter.ts:349`) checks `a11yEl.isConnected` before dispatching to a mirror; the `VectoJSEvent` fallback must stay for the offscreen case.
- [ ] **Panel focus bridged.** Every `setFocusedEntity` transition dispatches synthetic `FocusEvent`s on mirrors and `markDirty()` (`ThreeAdapter.ts:516`); `pointerdown` focus walks `isFocusable` ancestors (`ThreeAdapter.ts:499`).
- [ ] **Keyboard ownership unified.** `entityOwnsKeyboard` (`ThreeAdapter.ts:643`) uses the same `KEYBOARD_OWNING_ROLES` set as `Scene.ownsKeyboard` (`Scene.ts:115`, `Scene.ts:143`); adding a role to one must update the other.
- [ ] **`hover` vs `pointermove` preserved.** `dispatchAtPoint` maps `pointermove` hover transitions to `hover` on the new entity and `pointerleave` on the old (`ThreeAdapter.ts:277`); changing the event name breaks `Entity.on('hover',…)` handlers.
- [ ] **`pointerleave` dedup intact.** Synthetic mesh-exit `pointerleave` (`ThreeAdapter.ts:291`) must not fall through to the generic dispatch — the `return false` is load-bearing.
- [ ] **`activePointers` pruned.** `pruneEndedPointer` (`ThreeAdapter.ts:228`) on `pointerup`/`pointercancel` in both `updateIntersection` and `dispatchPointer` (plus `ThreeRenderer` LRU caps).
- [ ] **`needsUpdate` gated.** The render proxy (`ThreeAdapter.ts:157`) only sets `needsUpdate` when the Scene redrew; `resize`/`dispose` semantics (`_ownsCanvas`, `_originalRender`) untouched.
- [ ] **`Graph3D` guards hold.** `setGraphData` resolves links before mutating (`Graph3D.ts:80`), `applyPositions` bails on short arrays (`Graph3D.ts:162`), `GraphInteraction` cleans up mid-drag (`GraphInteraction.ts:314`).

## Relations

- **Boss 06 (VMT runtime)** owns `Scene`, `Entity`, `findEntityAt`, `focusedA11yElement` and the `WASM_UPLOAD_REJECT_LIMIT` / structure-version wiring the adapter reuses.
- **Boss 07 (renderer)** owns `IRenderer`, `CanvasRenderer`'s DPR/backing-store caps, the y-down ortho, scissor and `present()` vs `flush()` batching that both `ThreeAdapter` (via `CanvasRenderer`) and `ThreeRenderer` (as `IRenderer`) inherit.
- **Boss 11 (graph layout)** owns the force kernels that feed `Graph3D.applyPositions`; `@vectojs/graph-layout` 2D quadtree (`BarnesHutQuadtree.ts`) stays JS-only while `crates/vectojs-force-rs` accelerates the 3D octree.
- **Boss 08 (WASM)** shares the `Scene` viewport and `appliedDPR` values; a stale typed-array view across memory growth is this boss's texture-cache analog.

## References

- `packages/three/src/ThreeAdapter.ts:1` — adapter: offscreen canvas, `CanvasTexture`, render proxy, raycast + programmatic input, panel focus/keyboard
- `packages/three/src/ThreeRenderer.ts:1` — `IRenderer` via Three.js: y-down ortho, ribbon strokes, gradient shader, DPR, caches, `present()`/`dispose()`
- `packages/three/src/index.ts:1` — public barrel (`ThreeAdapter`, `ThreeRenderer`)
- `packages/graph3d/src/Graph3D.ts:1` — instanced nodes + line links, `setGraphData` resolve-first, `applyPositions` guard, `pickNode`
- `packages/graph3d/src/GraphCamera.ts:1` — ortho/perspective camera + pan/zoom/orbit, `setSize` zoom fix, wheel-zoom-about-cursor
- `packages/graph3d/src/GraphInteraction.ts:1` — `Raycaster` + NDC, `pointerId` hover/drag-to-pin, `window` up/cancel, `setControlsEnabled`
- `packages/core/src/tree/Scene.ts:115` `KEYBOARD_OWNING_ROLES` / `Scene.ts:143` `ownsKeyboard` / `Scene.ts:1446` `focusedA11yElement` / `Scene.ts:3512` per-mirror dispatch — the 2D ownership the adapter mirrors
- `.agents/skills/vectojs-three/references/three-recipes.md:1` — panel, pointer, wheel, programmatic and dispose recipes
- `vectojs-docs/forge/findings/renderer-and-gpu.md:1` — renderer/gpu findings (DPR, `FrontSide` cull, `flipY`, hairline, cache leaks, projection traps)
