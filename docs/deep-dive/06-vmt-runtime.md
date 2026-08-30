---
title: "06 — VMT Runtime — Lifecycle / Dirty / Events"
description: "The Virtual Math Tree runtime: entity lifecycle, dirty/invalidation granularity, world-matrix composition, and capture/bubble event dispatch — with the ancestor-walk and lifecycle-leak traps that break all three invariants."
order: 26
---

# 06 — VMT Runtime — Lifecycle / Dirty / Events

> The Virtual Math Tree is not a scene graph you render. It is a retained numeric tree whose every frame recomposes transforms, decides what is dirty, culls what is invisible, hit-tests what is interactive, and only then paints. The DOM is a projection; the canvas is the truth. This document is the control loop that keeps that truth consistent.

## 1. The VMT pipeline in one picture

```text
                    Entity tree               packages/core/src/tree/Entity.ts:782
                    (Scene.root)              Scene holds root + overlayRoot, never reassigns
                         │
                         │  add/remove/reparent  Entity.ts:1065 add / :1117 remove
                         │  structureVersion++   Scene.ts:3462 structureVersion
                         ▼
               ┌─────────────────────┐
               │  Dirty propagation  │   DirtyTracker  scene/DirtyTracker.ts:70
               │  markDirty / clear  │   dirty:boolean  Scene.ts:534
               └─────────┬───────────┘   consumed BEFORE update  Scene.ts:5646
                         │
                         ▼
               ┌─────────────────────┐
               │ Transform gather    │   getWorldTransform  Entity.ts:1668
               │ T·S·R compose       │   _worldFrame cache  Entity.ts:845 / :1668 fast path
               │ per-frame cache     │   currentFrame++     Scene.ts:5806 (O(1) invalidation)
               │ WASM SoA store (G1) │   _storeSlot         Entity.ts:865 / WasmBackendFacade.ts:30
               └─────────┬───────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
     ┌────────────────┐   ┌──────────────────┐
     │ Layout         │   │ Hit test         │   HitTester  scene/HitTester.ts:17
     │ LayoutEngine   │   │ findEntityAt     │   :121 JS walk fallback
     │ measurePrepared│   │ isHitEligible    │   :326 clip + opacity + pointerEvents
     │ layoutPrepared │   │ WASM grid        │   :144 ensureHitGrid / :185 fused gather
     └───────┬────────┘   └────────┬─────────┘
             │                     │  pointer capture  Scene.ts:3851 setPointerCapture
             └──────────┬──────────┘   capture/bubble  Entity.ts:1610 dispatchEvent
                        ▼
              ┌───────────────────┐
              │ Render walk       │   Scene.ts:5730 render / :5569 loop
              │ cull → paint      │   renderMode always/onDemand  Scene.ts:401
              │ a11y sync after   │   syncA11y deferred when animating
              └───────────────────┘
                        │
                        ▼
                   Pixels + DOM mirrors
```

The causal order is fixed — `Scene.ts:5745` documents it as a correctness contract — even though physical walks may fuse. The JS path interleaves `update → compose → cull → paint` per node in pre-order; the WASM path updates the whole tree, then gathers and composes in one SoA pass before the same cull/paint walk. Both must expose an `update()` mutation in that same frame.

## 2. Lifecycle — create / add / remove / destroy

### 2.1 Entity shape

`Entity` (`Entity.ts:782`) is `abstract`. Every instance carries:

- `id: string` — random `entity_<7>` when omitted (`Entity.ts:1055` constructor).
- `parent: Entity | null` (`:791`), `children: Entity[]` (`:790`). Parent is the sole ownership link.
- `scene` getter (`:796`) — walks `parent` to the true owner; never stored on the entity itself except as Scene's own `_scene` escape hatch.
- Local transform: `_x/_y/_scaleX/_scaleY/_rotation/_opacity` (`:805`), with `_hasTransitions` fast-path flag (`:812`) so a passive entity's `x = v` is one boolean check + field write.
- Lazily allocated `Map`s: `_drivers`, `listeners`, `captureListeners` (`:819`) — null until first use. A scene of 20k particles never allocates them.
- `_mounted: boolean` (`:816`), `_destroyed: boolean` (`:817`), `_driversTickedFrame: number` (`:828`, `-1` initially).
- World-matrix cache `_wa.._wf / _worldFrame` (`:845`) and WASM slot `_storeSlot: number` (`:865`, `-1` when not in the store).

Subclasses override `getBounds()`, `drawSelf()`, `getContentProjection()`, `update()`, `onMounted()`, `destroy()`.

### 2.2 add — attach with cycle guard and structure invalidation

`Entity.add(...children)` (`:1065`) forwards to `_addOne` (`:1075`):

1. Cycle guard — `child === this` throws; walking `this.parent` chain checks ancestor equality (`:1080`). O(depth), add is rare vs per-frame work.
2. Detach from old parent — `child.parent.remove(child)` when `child.parent` is set, so re-parenting never duplicates.
3. `child.parent = this; this.children.push(child)` — O(1) tail append.
4. If `this.scene` exists (live tree):
   - `s.a11yNeedsReorder = true`
   - `s.markStructureChanged()` — bumps `structureVersion`, invalidates the WASM transform store layout (`Scene.ts:1625` `_storeStructureVersion`).
   - `s.markDirty({ entity: this.id, reason: 'child-added' })` (`:1086`).
   - `child._notifyMounted()` (`:1087`) — depth-first `onMounted()` guarded by `_mounted` so a re-attached subtree fires once.
   - `s._registerActiveDriverSubtree(child)` — resumes any batched drivers the subtree had in flight when detached (mirror of `remove`'s unregister).

Multiple children (`add(a,b,c)`) attach in argument order with the same semantics.

### 2.3 remove — detach with driver deregistration

`Entity.remove(child)` (`:1117`) is `indexOf` + `splice`:

1. `child.parent = null`.
2. `s.detachA11y(child)` + `a11yNeedsReorder`.
3. `s.markStructureChanged()` + `markDirty({ reason: 'child-removed' })` (`:1123`).
4. `s._unregisterActiveDriverSubtree(child)` — drops the off-tree subtree from `DriverTicker.active` so its drivers stop ticking and pinning entities. The `_addOne` mirror resumes them if re-attached before they settle.

Removing a non-child is a no-op (returns `this`). There is no `removeAll()` — iterate or `destroy()`.

### 2.4 destroy — leaf-first recursive teardown

`Entity.destroy()` (`:1525`) — idempotent via `_destroyed` guard:

```ts
while (this.children.length > 0) this.children.at(-1)!.destroy();
animations = null;
for (const d of this._drivers.values()) this._settleDriver(d); // resolve animateTo promises
this._drivers.clear(); listeners.clear(); captureListeners.clear();
if (this.parent) this.parent.remove(this);
```

- Leaf-first (destroy from tail) so each child's `parent.remove(this)` mutates the tail being iterated past — no snapshot, no index skew.
- Subclasses owning GPU/DOM resources override, free the resource, then call `super.destroy()` (`ComputeParticleEntity.ts:419`, `DOMPortalEntity.ts:142`).
- Promise settlement via `_settleDriver` (`:1329`) resolves `animateTo`/`springTo` callers instead of hanging forever.

`Scene.destroy()` (`Scene.ts:2957`) adds the scene-level twin:

- Guard `if (destroyed) return` (`:2958`), set `destroyed = true`.
- `while (root.children.length) destroyEntitySubtree(root.children.at(-1)!)` and same for `overlayRoot` (`:2964`), each delegating to `entity.destroy()` (`:2951`).
- Tear down `pointRenderer`, `WebGPU device/manager`, `ResizeObserver`, DPR watch, pointer listeners (detaching from `pointerEventTarget`), `a11yRoot`/`portalRoot`, and clear `keydownHandlers/shortcuts`.
- Idempotent — `start()` early-returns when `destroyed` (`:3143`), and WebGPU device recovery checks `if (destroyed) newDevice.destroy()` (`:5813`).

A `destroy()`d entity must never be re-added — its `_destroyed` flag makes any further `destroy()` a no-op but its `parent` is already null and its children gone.

## 3. Dirty / invalidation granularity

### 3.1 The boolean flag and its attribution

`Scene.dirty: boolean` (`Scene.ts:534`) is the only scheduling signal. `onDemand` skips rendering when `!dirty && !frameHadAnimation && !contentSemanticDeferred` (`Scene.ts:5594` `isIdle`); `always` renders every rAF unless `autoThrottle` drops to `idleFPS`.

Ownership is split per `DirtyTracker.ts:2` header:

- `DirtyTracker` (`scene/DirtyTracker.ts:70`) owns the flag (`isDirty`), the opt-in attribution map, and its FIFO bound (`MAX_DIRTY_REASONS = 200` at `:71`).
- `Scene.markDirty(source?)` (`Scene.ts:3443`) keeps its exact name/signature and delegates to `_dirty.mark(source, currentFrame)` — 129 call sites in `Entity.ts` rely on `scene.markDirty()` (`DirtyTracker.ts:33`).
- `Scene._dirty: DirtyTracker` (`Scene.ts:1220`) with private getter/setter (`:1229`) — `set dirty(true)` calls `mark(undefined, currentFrame)`, `set dirty(false)` calls `clear()`.

Hot-path cost (`DirtyTracker.ts:47`): when `tracking` is off, `mark()` is one field write (`isDirty = true`) plus one already-false branch. `record()` is a separate method so V8 inlines the one-field version.

### 3.2 When the flag is set and when it is consumed

**Set** — dozens of sites, each with a `reason` string for attribution:

- `Entity.add` → `child-added` (`:1086`), `remove` → `child-removed` (`:1123`), `animate` → `animation-start`, `_spawnDriver` → `driver-added` (`:1305`), `tickDrivers` → `driver-tick` (`:1389`), `ComputeParticleEntity` → `markDirty()` per particle mutation (`ComputeParticleEntity.ts:113`).
- `Scene` itself: style changes, resize, font load (`:2717`), a11y reorder (`:3674`), scroll (`:3931`).

**Consumed** — `Scene.loop` (`:5569`) does `this.dirty = false` **before** the `update/render` pass (`:5650`). Any `markDirty()` inside `entity.update()` survives into the next frame; clearing after render would wipe self-animating re-arms and freeze the entity (`DirtyTracker.ts:98`). `Scene.step(dt)` (`:3420`) is the exception — it renders unconditionally (neither `renderMode` nor `dirty` consulted, `DirtyTracker.ts:33` contract) and clears after (`:3434`), since determinism is the point.

### 3.3 Attribution — finding what keeps an onDemand scene awake

Off by default. Enable with `scene.setDirtyTracking(true)` (`Scene.ts:3475`), run, then read `scene.dirtyReasons: DirtyReasonEntry[]` (`:3489`, sorted most-frequent first). Each entry is `{ entity?, reason, property?, count, firstFrame, lastFrame }` (`DirtyTracker.ts:59`). Key is `entity:reason.property` (`:120`). Bounded FIFO — oldest dropped at 200 (`:127`). Clear with `scene.clearDirtyReasons()` (`:3495`). The `onDemand` diagnosis that used to be "dirty is true, no idea why" is now a sorted table.

`structureVersion` (`Scene.ts:3462`, backed by `_structureVersion` at `:1636`) is the companion signal: add/remove/reparent bump it; property changes do not. A cache of tree shape is valid exactly while this value is unchanged — O(1) vs re-walking.

## 4. World-matrix composition

### 4.1 The affine and its cache

`AffineTransform { a,b,c,d,e,f }` (`Entity.ts:33`) matches `CanvasRenderingContext2D` — `T * S * R` per node, six scalars.

`getWorldTransform(): AffineTransform` (`Entity.ts:1668`) has two paths:

**Fast path** — per-frame cache written by Scene's render walk (`_setWorldCache` at `:1784`, stamping `_wa.._wf` and `_worldFrame`). If `_worldFrame === scene.currentFrame` (`:1672`), return the six scalars verbatim — no walk, no allocation beyond the returned object. A stale cache (entity not rendered this frame, or queried between frames) fails the check and falls through; the cache can only skip work, never return a wrong matrix.

**Authoritative walk** — build `path: Entity[]` from `this` to the true root (`parent === null`, not `id === 'root'` — user-settable, `:1690`), then compose root→self:

```ts
for (let i = path.length -1; i >=0; i--) {
  const {cos, sin} = node._getTrig(); // cached, :1746
  const la = scaleX*cos, lb = scaleY*sin, lc = -scaleX*sin, ld = scaleY*cos;
  const le = x, lf = y;
  nextA = a*la + c*lb; nextB = b*la + d*lb;
  nextC = a*lc + c*ld; nextD = b*lc + d*ld;
  nextE = a*le + c*lf + e; nextF = b*le + d*lf + f;
}
```

`_getTrig()` (`:1746`) caches `{cos, sin}` and recomputes only when `rotation` changed (`_trigRotation` check) — V8's `Math.cos/sin` is ~2.5× slower than other engines, and this is per-entity-per-frame. `_readWorldCache(frame, out)` (`:1647`) is the zero-allocation sibling for per-entity gathers (e.g. G3's `gatherHitAABBs`) — six scalar reads into a caller-owned `out` instead of one object per entity.

Invalidation is O(1): `Scene.render` bumps `currentFrame++` (`:5806`) at the start of the authoritative walk, so every entity's cache is stale in one increment without touching entities.

### 4.2 WASM G1 path — the SoA transform store

When the transform backend is active (`transformBackend: 'wasm'` / `'auto'` with module loaded), `Scene` maintains a resident SoA store (`WasmBackendFacade.ts:228` `structureVersion`, `scene-store.ts:buildTreeStore`). On `markStructureChanged`, the store rebuilds its topology (parent indices, slot assignment); each `Entity._storeSlot` (`:865`) is assigned then and validated against the slot table before trusting. Per-frame, `ensureAabbs()` composes all world matrices in one WASM pass over the SoA buffers — the same `T·S·R` math, bit-identical to the JS walk. The hit-test fused gather (`HitTester.ts:144`) prefers `transform.aabbView()` when available, falling back to the JS `gatherHitAABBs` (`wasm/hit-store.ts:47`) which calls `getWorldTransform()` per entity. A stale `_storeSlot` only costs a JS fallback, never a wrong read.

### 4.3 Derived queries

- `localToWorld(x,y)` (`:1784`) / `worldToLocal(x,y)` (`:1796`) — apply/invert the world matrix; `worldToLocal` returns `null` on singular determinant (`|det| < 1e-12`).
- `getWorldBounds()` (`:1819`) — `getBounds() ?? {x:0,y:0,width,height}` transformed by four corners, producing the world AABB used for culling and hit-grid input.
- `getWorldScale()` (`:1850`) — multiplies `scaleX/scaleY` up the parent chain (ignores rotation — for hit-test inverse only).

## 5. Event dispatch — capture / bubble and pointer ownership

### 5.1 VectoJSEvent

`VectoJSEvent<N>` (`Entity.ts:607`) mirrors the DOM surface: `type: VectoEvent` (`:538`, `click | dblclick | hover | pointerdown/up/move/cancel/leave | wheel | keydown/keyup | scroll | change | ...`), `target: Entity`, `currentTarget: Entity` (set per node during dispatch), `nativeEvent: N | undefined`, `bubbles: boolean` (default `true`; `hover`/`pointerleave` are `false`), plus `stopPropagation()`, `stopImmediatePropagation()`, `preventDefault()`, and forwarded `clientX/Y`, `sceneX/Y`, `localX/Y`, `deltaX/Y`, `key/shiftKey/ctrlKey/altKey/metaKey`.

### 5.2 Registration

`Entity.on(event, cb, { capture })` (`:1470`) and `off(event, cb, { capture })` (`:1485`):

- Two lazily allocated maps: `listeners` (bubble) and `captureListeners` (`:1030`), each `Map<VectoEvent, Array<cb>>`.
- `capture: true` registers on `captureListeners`; default is bubble. `off` must match the phase.
- `emit(event, payload)` (`:1540`) is the direct self-only path (bubble listeners only, no propagation) — for component-internal `change` events. `dispatchEvent` is the tree path.

### 5.3 Dispatch — capture then bubble

`Entity.dispatchEvent(event)` (`:1610`):

1. Build `path: Entity[]` target→root via `parent` chain.
2. Capture: root→target (`for i = path.length-1 .. 0`) firing `captureListeners` (`:1618`). Checks `propagationStopped` before each node.
3. Bubble: target→root (`for i = 0 .. path.length-1`) firing `listeners` (`:1622`). `if (!event.bubbles) return` after the target — non-bubbling events still run capture but only the target's bubble.
4. `fireListeners(node, map, event)` (`:1595`) snapshots `handlers.slice()` so a handler adding/removing listeners mid-dispatch does not disturb the pass, and honors `immediatePropagationStopped`.

Scene's a11y projection wires native DOM events into this tree: per-mirror listeners in `Scene.ts:3802` (`click`, `dblclick`, `pointerdown/up/cancel/move`, `wheel`, `keydown/keyup`) each do `node.dispatchEvent(new VectoJSEvent(type, node, nativeEvent))`. `scroll` (`:3912`) is special — it does not bubble in the DOM, so Scene does `node.emit('scroll', { scrollTop, scrollLeft, ... })` (`:3920`) directly to the owning entity.

Scene-level keyboard (`Scene.ts:3272` `on('keydown'|'keyup')`) is a separate channel — no entity target, `stopPropagation()` forwards to the native event (`scene/keyboard.ts:79`), and `registerShortcut(chord, handler)` matches on `keydown` only.

### 5.4 Pointer ownership

`pointerdown` on a shadow element captures the pointer (`Scene.ts:3851`):

```ts
if (e.target === capEl && typeof capEl.setPointerCapture === 'function')
  capEl.setPointerCapture(e.pointerId);
```

Guard `e.target === capEl` is load-bearing: a bubbled `pointerdown` whose target is a descendant must not re-capture — the descendant already owns it, and an ancestor overriding retargets `pointerup` + `click` to the common ancestor (measured as Dropdown options whose clicks landed on the listbox container, `Scene.ts:3844`). `pointerup`/`pointercancel` release via `releasePointer` (`:3831`) guarded by `hasPointerCapture(pointerId)` and catching `NotFoundError` DOMException. `pointerEvents: 'none'` (`Entity.ts:431` `a11yAttributes.pointerEvents`) opts a node out of hit-testing without affecting children — see §6.3.

## 6. Hit testing — two paths that must agree

`Scene.findEntityAt(x, y)` (`Scene.ts:2777`) delegates to `HitTester.findEntityAt(x, y, currentFrame, width, height)` (`HitTester.ts:121`):

1. Overlay root first — always `findHitRecursively` (overlays are few, never WASM-indexed).
2. Main tree — if `backends.hit` and `ensureHitGrid(frame, width, height)` (`:144`) succeed, `findEntityAtWasm` (`:185`); otherwise `findHitRecursively` (`:227`). The WASM path is conclusive — correct entity or `null`, never "inconclusive" — so no JS fallback follows a trustworthy grid.

`findHitRecursively(node, x, y, clip)` (`:227`):

- Skip `opacity <= 0` subtrees (accumulated opacity).
- `clipChildren` intersects into `childClip` via `intersectBounds` (`:32`) — passed down, node itself still testable against incoming clip.
- Children in reverse draw order (topmost first).
- Node is hit iff `isPointInside(x,y) && isInsideAllClippers(node,x,y) && !isPointerTransparent(node)`.

`isInsideAllClippers` (`:284`) is the authoritative rotation-aware gate — every `clipChildren` ancestor's `worldToLocal(x,y)` must lie inside `[0, width]×[0, height]`. The AABB clip stack in the walk is only a subtree-pruning pre-filter; both hit paths must re-apply the exact rect or a rotated clipper yields different answers per backend (#680).

`isHitEligible(node,x,y)` (`:326`, WASM path) reapplies the same gating flat: `!isPointerTransparent`, `opacity>0` on node and every ancestor, and `isInsideAllClippers`. `isPointerTransparent` (`:284`) is `attrs.disabled === true || attrs.pointerEvents === 'none'` (`Entity.ts:431`) — children of a transparent container are still walked.

## 7. Render scheduling — where dirty meets the loop

`Scene.loop(time)` (`Scene.ts:5569`) runs on `requestAnimationFrame`:

1. Bail if `!_canvasOnScreen` (IntersectionObserver) — `markDirty()` while hidden is harmless, flag persists.
2. Compute `isIdle = !dirty && !frameHadAnimation && !contentSemanticDeferred` (`:5594`) — drives both `onDemand` skip and `always` auto-throttle to `idleFPS`.
3. `effectiveMaxFPS()` (`:5556`) — explicit `maxFPS` lowered to `30` when `prefersReducedMotion` matches.
4. Frame-rate cap: `if (cap>0 && time - lastTime < 1000/cap -1) skip` (`:5605`).
5. Snap `dt` to nominal `1000/cap` when within 30% to remove compositor jitter; clamp to `MAX_FRAME_DT` to avoid spring explosion after a backgrounded tab (`:5630`).
6. `onDemand && isIdle → skip` (`:5640`).
7. `dirty = false` **before** `render()` (`:5650`) — see §3.2.
8. `render(renderer, dt, time)` (`:5730`) — bumps `currentFrame`, ticks batched drivers (`_tickBatchedDrivers`), advances particle simulation, walks entities.
9. A11y/content projection sync after render — skipped entirely while `frameHadAnimation` (prevents DOM reflow thrashing the canvas loop).

`Scene.step(dt)` (`Scene.ts:3420`) is the synchronous deterministic driver (video export, tests, benchmarks) — renders unconditionally without consulting `renderMode`/`dirty`/`maxFPS`, and clears `dirty` after. A benchmark driving `step()` cannot observe `onDemand` skipping (`Scene.ts:3406` doc).

## 8. Hard parts — with receipts

### 8.1 Ancestor walks are O(depth) and there are many of them

`getWorldTransform`, `getWorldScale`, `isInsideAllClippers`, `isHitEligible`, `dispatchEvent` path build, `Entity.scene` getter — each walks `parent` to the root. Depth is typically shallow (Stack → Card → RichText), so O(depth) is cheap per call, but hit-testing and the render walk call it per entity per frame. Three mitigations:

- **Per-frame cache** (`_worldFrame` / `currentFrame`, `:845`/`5806`) — O(1) invalidation, fast path when the render walk already stamped the matrix. `getWorldTransform` falls back to the walk only on miss.
- **Zero-allocation read** (`_readWorldCache`, `:1647`) for gathers like `gatherHitAABBs` — six scalar reads into a caller-owned object instead of one allocation per entity. The G2 integrated benchmark found per-entity closure allocation was a real cost (`DriverTicker.ts:40` header).
- **WASM SoA store** (G1) — one linear pass over typed arrays instead of per-entity walks; `ensureHitGrid` fused gather (`HitTester.ts:144`) reuses `transform.aabbView()` to avoid re-deriving four corners per entity (the JS gather was 11.2 ms vs 39 µs at 100 k entities, essentially all in front of the kernel).

Still, inserting a 500-deep chain and calling `getWorldTransform` in a tight loop will be O(n·depth). Keep trees broad, not deep.

### 8.2 Transform cost — the cos/sin trap

`Math.cos/sin` on V8 is a software libm call, ~2.5× slower than other engines (`Entity.ts:828` header). `Entity._getTrig()` (`:1746`) caches the pair and recomputes only on rotation change; both `getWorldTransform` and the render walk read it. Without this, a scene with many rotating particles (Danmaku) pays the libm cost per entity per frame for an unchanged angle. The `_hasTransitions` flag (`:812`) is the same class of micro-optimization — most entities never animate, so `x = v` must not touch transition/driver maps.

### 8.3 Lifecycle leaks — the three that recur

**Driver-subtree leak.** `DriverTicker.active: Set<Entity>` (`DriverTicker.ts:84`) is the batch candidate set. `Entity.add` registers the subtree (`:1087` mirror) and `remove` unregisters it (`:1130`). If either call is missed — e.g. a custom container that mutates `children` directly instead of via `add`/`remove` — drivers keep ticking off-tree every frame and pin entities in the Set. Audit: search for direct `children.push/splice` outside `Entity.ts`.

**Destroyed guard.** `Entity.destroy()` (`:1525`) sets `_destroyed` first, then recurses. A second `destroy()` is a no-op; a `destroy()` that re-enters via a child's `onMounted` or driver's `onDone` sees the flag and stops. `Scene.destroy()` (`:2957`) sets `destroyed` before tearing down children, and every async callback (WebGPU device recovery `:5813`, `requestAnimationFrame` loop `:5569`) checks `if (destroyed) return/newDevice.destroy()`. Missing the guard resurrects a half-torn scene or leaks a GPU device across SPA route changes.

**A11y / portal leak.** `remove` calls `detachA11y(child)` (`:1117`) and `destroy` calls `removeA11yRecursively` via `A11yProjectionManager.ts:227`. The projection's `contentSemanticBudget` and `contentViewportEpoch` ensure a removed entity's carriers/projection state are not retained across `syncA11y` walks. Forgetting `detachA11y` leaves a transparent shadow element that still captures pointer events and appears in `getA11yTree()`.

### 8.4 The render-scheduler decomposition trap

`Scene.ts` is ~6.5 k lines because four domains share mutable frame state: `DirtyTracker` (`DirtyTracker.ts:70`), `DriverTicker` (`DriverTicker.ts:57`), `HitTester` (`HitTester.ts:17`), and `WasmBackendFacade` (`WasmBackendFacade.ts:1`) have been extracted per `forge/decisions/file-decomposition-2026-08.md`, but `loop`/`render` and `a11yRoot`/`canvas` geometry stay on Scene. `Scene._updateWalkDt` (`:5806`) is published for `Entity._spawnDriver`'s mid-walk catch-up tick — a driver spawned after the batch pass claimed the entity would otherwise wait until next frame on the WASM path but tick same-frame on the JS path. Splitting `loop` without carrying `dt`/`currentFrame`/`frameHadAnimation` together violates `DEC-0019` rule 5.

## 9. Invariants developers must keep

1. **Never mutate `children` except via `add`/`remove`/`destroy`.** Direct array mutation skips `markStructureChanged`, `markDirty`, driver registration, and a11y detach — all four invariants break silently. Grep for `\.children\.push|\.children\.splice` outside `Entity.ts`.
2. **Check `destroyed` before scheduling work.** Any `requestAnimationFrame`, `setTimeout`, `ResizeObserver`, or WebGPU promise that touches `scene` or `entity.scene` must guard `if (destroyed) return`. The `destroy()` doc at `Scene.ts:3137` is explicit.
3. **Respect the dirty contract.** `onDemand` scenes sleep until `markDirty()` or an active driver. Mutating `x/y/scale/rotation/opacity/width/height` outside `Entity.animate`/`setTransition` without `markDirty({ reason })` leaves the change invisible. Conversely, a per-frame `markDirty` (e.g. `update()` re-arming itself) keeps `onDemand` awake — use `scene.dirtyReasons` (`:3489`) to find the `reason` that fires every frame.
4. **Keep hit-test gates in lockstep.** Any new visibility/input/clip condition must be added to both `findHitRecursively` (`HitTester.ts:227`) and `isHitEligible` (`:326`). A condition only in one makes the WASM and JS paths disagree — the accelerator becomes a bug generator.
5. **Pointer capture only on `e.target === capEl`.** The `Scene.ts:3851` guard is not optional. Removing it breaks every Dropdown/Select menu whose options are children of the capturing element.
6. **World-matrix consumers must handle the stale-cache case.** `getWorldTransform()` can only return a cached matrix for `currentFrame`; between frames or for an off-tree entity it walks. `_readWorldCache` callers must fall back to the full walk when it returns `false` (`HitTester.ts:144` fused-gather comment).
7. **Version metrics, don't sweep.** Font/DPR/viewport changes invalidate all `scaleX`/calibration via generation counters (`ContentProjectionManager.ts:524`), not by touching every carrier. Same pattern applies to `structureVersion` for shape caches.

## 10. Debug checklist — when the scene looks wrong

- **Nothing renders after a mutation in `onDemand` mode** → is `dirty` still `false`? Enable `scene.setDirtyTracking(true)`, mutate, read `scene.dirtyReasons`. Missing `markDirty` is the cause in ~90% of cases. Check `scene.frameStats.dirty` (`Scene.ts:3528`) in devtools.
- **Phantom hit targets after `remove()`** → was `children` mutated directly? Check `structureVersion` bump and `HitTester.ensureHitGrid` staleness (`hitGridStructureVersion` vs `structureVersion`). Stale grid with `hitGridOk=true` serves wrong candidates.
- **Driver keeps running after subtree removed** → `DriverTicker.active` size should drop. Inspect `scene._tickBatchedDrivers` gate — `unregisterSubtree` at `DriverTicker.ts:101` walks the whole subtree, so a very deep detached subtree pays O(subtree) at removal time, not per frame.
- **Transform diverges JS vs WASM** → compare `entity.getWorldTransform()` (JS walk) against `transform.aabbView()` slot. A stale `_storeSlot` (`Entity.ts:865`, `-1` when not in store) only causes a slow correct JS fallback, never a wrong matrix — if matrices differ, the topology rebuild missed a `markStructureChanged`.
- **Event fires twice or not at all** → check `bubbles` flag (`VectoJSEvent.ts:607`) and whether the listener is on `captureListeners` vs `listeners`. Non-bubbling `hover`/`pointerleave` only fire at the target in the bubble phase.
- **Spring explodes on tab refocus** → `loop` clamps `dt` to `MAX_FRAME_DT` (`Scene.ts:5630`). If a custom `step(dt)` feeds a huge `dt` directly to `tickDrivers`, the same clamp must be applied by the caller.

---

_Series: 00 Overview → 01 Selection → 02 Text+Layout → 03 Projection+Virtualization → 04 Streaming Markdown → 05 TeX → **06 VMT Runtime** → 07 Renderer → 08 WASM G1/G2/G3 → 09 Three/XR → 10 Video Export → 11 Graph Layout → 12 DevTools → 99 Synthesis._
