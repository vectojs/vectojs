# Milestone 2: `@vecto-ui/three` Adapter Progress Log

## 1. Technical Direction & Scope

The objective of Milestone 2 is to bridge the VectoUI 2D UI engine with the Three.js 3D library. 
It enables rendering high-fidelity interactive user interfaces onto 3D surfaces in WebGL/WebXR.

### Key Decisions:
- **Canvas Texture Mapping**: Render VectoUI scene to an offscreen canvas and pipe it into a single `THREE.CanvasTexture` applied to a `THREE.Mesh`.
- **Render Intercept Hook**: Override `Scene.render` to dynamically toggle `texture.needsUpdate = true` only when VectoUI repaints a frame. Keeps GPU uploads completely idle (0 bandwidth) when the UI is static.
- **Universal Raycast Event Propagation**: Listen to pointer coordinates, project them into UV coordinates [0, 1] on the mesh, map them to canvas pixels, and dispatch simulated DOM events on the offscreen canvas.
- **Hover Leave Sanitation**: If the pointer moves off the Mesh, dispatch a `pointerleave` event to ensure all hover styles (such as button highlight colors) are cleared.

---

## 2. Test Specifications

Since the unit test environment runs in Node/JSDOM, headless environments do not support real WebGL/Three.js renderers. We implement a clean mock system matching Claude Code's testing style:

1. **Instantiation Test**: Verify `ThreeAdapter` instantiates the Vecto Scene and successfully creates a `THREE.CanvasTexture` with the correct dimensions.
2. **Update Check**: Verify `update()` or triggering a scene paint updates the texture version.
3. **Raycast / UV Translation Test**: Mock raycaster intersects, verify UV positions are translated into pixel positions correctly, and verify DOM events are received on the target canvas.
4. **Hover Exit Sanitation Test**: Simulate raycasting off the mesh, and verify a `pointerleave` event is dispatched.
5. **Memory Leak Guard Test**: Verify `dispose()` is clean, disposes of Three.js materials/geometries, destroys the Vecto scene, and wipes out canvas width/height.

---

## 3. Technical Challenges & Solutions (Postmortem)

During the implementation and Spec Review loop, we encountered several critical technical challenges and resolved them:

### 1) Event Routing to Transparent DOM Overlay
- **Problem**: Dispatching pointer events directly to the `canvas` element using `canvas.dispatchEvent` resulted in Vecto ignoring them, because Vecto UI event listeners are bound to transparent, absolute-positioned sibling DOM elements in the `a11yRoot` overlay container.
- **Solution**: We exposed two new public APIs on Vecto core `Scene`:
  - `findEntityAt(x, y): Entity | null` (performs mathematical post-order tree hit-testing using `isPointInside`).
  - `getA11yElement(entityId: string): HTMLElement | undefined` (retrieves the projected shadow DOM node for the entity).
  In `ThreeAdapter`, we perform hit-testing on raycast, fetch the target element, and dispatch the event directly to it. If it is an input/textarea, we call `.focus()` on `pointerdown` to trigger the browser IME. If no DOM element is projected, we fallback to direct Vecto tree event bubbling using `node.dispatchEvent(vectoEvent)`.

### 2) Viewport Culling & Resize Listener Window Coupling
- **Problem**: Vecto `Scene` originally hardcoded `window.innerWidth`/`window.innerHeight` for viewport culling boundaries and registered a global window `resize` handler that forced canvas sizes. This caused elements drawn on custom-sized offscreen canvases (e.g. `1024x768`) to be clipped out if they were outside the browser window bounds.
- **Solution**: We added `disableWindowResize?: boolean` to `SceneOptions` and added a public `Scene.resize(w, h)` method. This allows offscreen adapters to fully bypass window resize bindings and manually control the canvas rendering viewport. Viewport culling was updated to strictly utilize `this.width` and `this.height` instead of `window` bounds.

### 3) JSDOM Default Canvas Dimensions
- **Problem**: In JSDOM unit tests, default canvases are created with `300x150` dimensions. Our initial constructor logic used `canvas.width` / `canvas.height` first, which caused culling tests in `Scene.test.ts` (which expect a default size of `800x600`) to fail.
- **Solution**: We refactored `Scene` constructor's dimension setup: if `disableWindowResize` is true (for ThreeJS / custom adapters), it uses the canvas dimensions. Otherwise, it defaults to window inner bounds.

### 4) Multi-Pointer / WebXR State Isolation
- **Problem**: The initial design tracked hover states using single instance variables (`isHovering`, `lastUv`). In multi-touch or WebXR environments (dual controllers), this caused hover state conflicts and erroneous event fires.
- **Solution**: We introduced a `pointerId`-keyed `Map<number, PointerState>` to track hover state, last UV, and last hit target ID separately for each pointer.

### 5) Click & Wheel Event Fallbacks
- **Problem**: VectoUI components rely on standard click events, which aren't automatically fired by the browser when we only dispatch `pointerdown` and `pointerup` on transparent overlay elements in 3D.
- **Solution**: We added `'click'` to the supported raycast types and created a standard PointerEvent for clicks. We also ensured `WheelEvent` is always constructed for scroll wheels, using a default delta fallback of `0` to prevent runtime errors when `originalEvent` is absent.
