"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  CanvasRenderer: () => CanvasRenderer,
  Entity: () => Entity,
  GridTextEntity: () => GridTextEntity,
  LayoutEngine: () => LayoutEngine,
  LayoutResultBuffer: () => LayoutResultBuffer,
  Scene: () => Scene,
  SpatialHashGrid: () => SpatialHashGrid,
  TextEntity: () => TextEntity
});
module.exports = __toCommonJS(index_exports);

// src/renderer/CanvasRenderer.ts
var CanvasRenderer = class {
  ctx;
  width;
  height;
  constructor(canvas) {
    const dpr = window.devicePixelRatio || 1;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;
    this.ctx = canvas.getContext("2d");
    this.ctx.scale(dpr, dpr);
  }
  /**
   * Expose the underlying `CanvasRenderingContext2D` for operations not
   * covered by the {@link IRenderer} interface.
   *
   * @returns The raw 2D rendering context.
   */
  getContext() {
    return this.ctx;
  }
  /**
   * Resize the backing canvas buffer and re-apply DPR scaling.
   *
   * Called automatically by {@link Scene} on `window.resize` events.
   *
   * @param width - New logical width in CSS pixels.
   * @param height - New logical height in CSS pixels.
   */
  resize(width, height) {
    const dpr = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.ctx.canvas.width = width * dpr;
    this.ctx.canvas.height = height * dpr;
    this.ctx.canvas.style.width = `${width}px`;
    this.ctx.canvas.style.height = `${height}px`;
    this.ctx.scale(dpr, dpr);
  }
  /** @inheritdoc */
  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }
  /** @inheritdoc */
  save() {
    this.ctx.save();
  }
  /** @inheritdoc */
  restore() {
    this.ctx.restore();
  }
  /** @inheritdoc */
  translate(x, y) {
    this.ctx.translate(x, y);
  }
  /** @inheritdoc */
  scale(x, y) {
    this.ctx.scale(x, y);
  }
  /** @inheritdoc */
  rotate(angle) {
    this.ctx.rotate(angle);
  }
  /** @inheritdoc */
  setGlobalAlpha(alpha) {
    this.ctx.globalAlpha = alpha;
  }
  /** @inheritdoc */
  beginPath() {
    this.ctx.beginPath();
  }
  /** @inheritdoc */
  moveTo(x, y) {
    this.ctx.moveTo(x, y);
  }
  /** @inheritdoc */
  lineTo(x, y) {
    this.ctx.lineTo(x, y);
  }
  /** @inheritdoc */
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  /** @inheritdoc */
  closePath() {
    this.ctx.closePath();
  }
  /** @inheritdoc */
  arc(x, y, radius, startAngle, endAngle, counterclockwise) {
    this.ctx.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }
  /** @inheritdoc */
  roundRect(x, y, width, height, radii) {
    this.ctx.roundRect(x, y, width, height, radii);
  }
  /** @inheritdoc */
  drawImage(source, dx, dy, dw, dh) {
    this.ctx.drawImage(source, dx, dy, dw, dh);
  }
  /** @inheritdoc */
  fill(color) {
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }
  /** @inheritdoc */
  stroke(color, lineWidth = 1) {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.stroke();
  }
  /** @inheritdoc */
  fillText(text, x, y, font, color) {
    this.ctx.font = font;
    this.ctx.fillStyle = color;
    this.ctx.fillText(text, x, y);
  }
  /** @inheritdoc */
  createLinearGradient(x0, y0, x1, y1, colorStops) {
    const grad = this.ctx.createLinearGradient(x0, y0, x1, y1);
    for (const cs of colorStops) {
      grad.addColorStop(cs.stop, cs.color);
    }
    return grad;
  }
};

// src/tree/Entity.ts
var Entity = class {
  id;
  children = [];
  parent = null;
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  opacity = 1;
  // A11y & Automation Agent Layer
  interactive = false;
  width = 0;
  height = 0;
  a11yOffsetX = 0;
  a11yOffsetY = 0;
  listeners = /* @__PURE__ */ new Map();
  animations = [];
  constructor(id) {
    this.id = id || `entity_${Math.random().toString(36).substring(2, 9)}`;
  }
  /**
   * Append a child entity to this node's children array.
   *
   * @param child - The entity to add as a child.
   * @returns `this` for method chaining.
   */
  add(child) {
    child.parent = this;
    this.children.push(child);
    return this;
  }
  /**
   * Remove a child entity from this node.
   *
   * @param child - The entity to remove.
   * @returns `this` for method chaining.
   */
  remove(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parent = null;
    }
    return this;
  }
  /**
   * Set the local position of this entity.
   *
   * @param x - Horizontal position in local space.
   * @param y - Vertical position in local space.
   * @returns `this` for method chaining.
   * @example entity.setPosition(100, 200);
   */
  setPosition(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  /**
   * Queue a tween animation toward the specified target property values.
   *
   * Multiple calls chain animations sequentially.  Only numeric properties
   * are interpolated; non-numeric values are ignored.
   *
   * @param targetProps - Partial set of numeric properties to tween to.
   * @param durationMs - Duration of the tween in milliseconds.
   * @returns `this` for method chaining.
   * @example entity.animate({ x: 400, opacity: 0 }, 500);
   */
  animate(targetProps, durationMs) {
    this.animations.push({
      target: targetProps,
      duration: durationMs,
      startTime: -1,
      startProps: {}
    });
    return this;
  }
  /**
   * Advance the entity's internal state for one frame.
   *
   * Called automatically by the {@link Scene} render loop — override in
   * subclasses to implement custom per-frame logic.
   *
   * @param dt - Elapsed time since the last frame in milliseconds.
   * @param time - Absolute timestamp from `performance.now()`.
   */
  update(_dt, time) {
    if (this.animations.length > 0) {
      const anim = this.animations[0];
      if (anim.startTime === -1) {
        anim.startTime = time;
        for (const key in anim.target) {
          anim.startProps[key] = this[key];
        }
      }
      const progress = Math.min((time - anim.startTime) / anim.duration, 1);
      for (const key in anim.target) {
        const start = anim.startProps[key];
        const end = anim.target[key];
        if (typeof start === "number" && typeof end === "number") {
          const easeOut = progress * (2 - progress);
          this[key] = start + (end - start) * easeOut;
        }
      }
      if (progress >= 1) {
        this.animations.shift();
      }
    }
  }
  /**
   * Register a listener for a {@link VectoEvent}.
   *
   * @param event - The event name to listen for.
   * @param callback - Handler invoked when the event is emitted.
   * @returns `this` for method chaining.
   * @example entity.on('click', (e) => console.log('clicked', e));
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return this;
  }
  /**
   * Remove a previously registered event listener.
   *
   * @param event - The event name to stop listening to.
   * @param callback - The exact handler reference passed to {@link on}.
   * @returns `this` for method chaining.
   */
  off(event, callback) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      const idx = handlers.indexOf(callback);
      if (idx !== -1) handlers.splice(idx, 1);
    }
    return this;
  }
  /**
   * Tear down this entity: clear all animations, event listeners, and detach
   * from parent. Call before discarding an entity to prevent memory leaks.
   */
  destroy() {
    this.animations = [];
    this.listeners.clear();
    if (this.parent) {
      this.parent.remove(this);
    }
  }
  /**
   * Dispatch a {@link VectoEvent} to all registered listeners on this entity.
   *
   * @param event - The event name to dispatch.
   * @param payload - Arbitrary data forwarded to each listener.
   */
  emit(event, payload) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((h) => h(payload));
    }
  }
  /**
   * Compute the entity's position in world/canvas space by accumulating
   * local offsets up the scene-graph hierarchy using affine transformations (scale and rotation).
   *
   * @returns World-space {@link Point} for this entity.
   */
  getGlobalPosition() {
    let px = this.x;
    let py = this.y;
    let curr = this.parent;
    while (curr && curr.id !== "root") {
      const cos = Math.cos(curr.rotation);
      const sin = Math.sin(curr.rotation);
      const rx = px * curr.scaleX * cos - py * curr.scaleY * sin;
      const ry = px * curr.scaleX * sin + py * curr.scaleY * cos;
      px = curr.x + rx;
      py = curr.y + ry;
      curr = curr.parent;
    }
    return { x: px, y: py };
  }
};

// src/tree/Scene.ts
var Scene = class {
  root;
  renderer;
  isRunning = false;
  lastTime = 0;
  canvas;
  // A11y / Automation Layer
  a11yRoot;
  a11yElements = /* @__PURE__ */ new Map();
  resizeHandler;
  constructor(canvas) {
    this.canvas = canvas;
    this.root = new class RootEntity extends Entity {
      isPointInside() {
        return false;
      }
      // Root renders nothing itself — renderNode() handles all child traversal.
      render(_r) {
      }
    }("root");
    this.renderer = new CanvasRenderer(canvas);
    this.a11yRoot = document.createElement("div");
    this.a11yRoot.style.position = "absolute";
    this.a11yRoot.style.top = "0";
    this.a11yRoot.style.left = "0";
    this.a11yRoot.style.width = "100vw";
    this.a11yRoot.style.height = "100vh";
    this.a11yRoot.style.pointerEvents = "none";
    this.a11yRoot.style.overflow = "hidden";
    this.a11yRoot.style.zIndex = "10";
    if (canvas.parentElement) {
      canvas.parentElement.appendChild(this.a11yRoot);
    }
    this.resizeHandler = () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
    };
    this.setupEvents();
  }
  /**
   * Expose the underlying {@link IRenderer} for advanced direct-draw operations.
   *
   * @returns The active renderer instance.
   */
  getRenderer() {
    return this.renderer;
  }
  /**
   * Add a top-level entity to the scene graph.
   *
   * @param entity - The entity to attach to the scene root.
   * @returns `this` for method chaining.
   * @example scene.add(new CircleEntity());
   */
  add(entity) {
    this.root.add(entity);
    return this;
  }
  removeA11yRecursively(node) {
    const el = this.a11yElements.get(node.id);
    if (el) {
      el.remove();
      this.a11yElements.delete(node.id);
    }
    for (const child of node.children) {
      this.removeA11yRecursively(child);
    }
  }
  /**
   * Remove a top-level entity from the scene graph and clean up its
   * accessibility shadow elements recursively.
   *
   * @param entity - The entity to detach from the scene root.
   * @returns `this` for method chaining.
   */
  remove(entity) {
    this.root.remove(entity);
    this.removeA11yRecursively(entity);
    return this;
  }
  /**
   * Tear down the Scene, halt the loop, and clean up event listeners and DOM elements.
   */
  destroy() {
    this.stop();
    window.removeEventListener("resize", this.resizeHandler);
    this.a11yRoot.remove();
    this.a11yElements.clear();
  }
  setupEvents() {
    window.addEventListener("resize", this.resizeHandler);
  }
  /**
   * Begin the `requestAnimationFrame` render loop.
   *
   * Idempotent — calling `start()` on an already-running scene is a no-op.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }
  /**
   * Halt the render loop after the current frame completes.
   *
   * Call {@link start} again to resume rendering.
   */
  stop() {
    this.isRunning = false;
  }
  syncA11y(node) {
    if (node.interactive && node.width > 0) {
      let el = this.a11yElements.get(node.id);
      if (!el) {
        el = document.createElement("div");
        el.setAttribute("data-vecto-id", node.id);
        el.style.position = "absolute";
        el.style.pointerEvents = "auto";
        el.style.cursor = "pointer";
        el.style.backgroundColor = "rgba(56, 189, 248, 0.05)";
        el.style.border = "1px dashed rgba(56, 189, 248, 0.4)";
        el.addEventListener("click", (e) => node.emit("click", e));
        el.addEventListener("mouseenter", (e) => {
          el.style.backgroundColor = "rgba(56, 189, 248, 0.2)";
          node.emit("hover", e);
        });
        el.addEventListener("mouseleave", (e) => {
          el.style.backgroundColor = "rgba(56, 189, 248, 0.05)";
          node.emit("pointerleave", e);
        });
        el.addEventListener("pointerdown", (e) => node.emit("pointerdown", e));
        el.addEventListener("pointerup", (e) => node.emit("pointerup", e));
        el.addEventListener("pointermove", (e) => node.emit("pointermove", e));
        this.a11yRoot.appendChild(el);
        this.a11yElements.set(node.id, el);
      }
      const pos = node.getGlobalPosition();
      el.style.left = `${pos.x + node.a11yOffsetX}px`;
      el.style.top = `${pos.y + node.a11yOffsetY}px`;
      el.style.width = `${node.width * node.scaleX}px`;
      el.style.height = `${node.height * node.scaleY}px`;
      el.style.transform = `rotate(${node.rotation}rad)`;
    }
    for (const child of node.children) this.syncA11y(child);
  }
  loop(time) {
    if (!this.isRunning) return;
    const dt = time - this.lastTime;
    this.lastTime = time;
    this.renderer.clear();
    const renderNode = (node) => {
      node.update(dt, time);
      this.renderer.save();
      this.renderer.translate(node.x, node.y);
      this.renderer.scale(node.scaleX, node.scaleY);
      this.renderer.rotate(node.rotation);
      this.renderer.setGlobalAlpha(node.opacity);
      node.render(this.renderer);
      for (const child of node.children) {
        renderNode(child);
      }
      this.renderer.restore();
    };
    renderNode(this.root);
    this.syncA11y(this.root);
    requestAnimationFrame((t) => this.loop(t));
  }
};

// src/layout/LayoutEngine.ts
var LayoutEngine = class {
  maxWidth;
  maxHeight;
  wordSegmenter;
  charSegmenter;
  wordCache = /* @__PURE__ */ new Map();
  graphemeCache = /* @__PURE__ */ new Map();
  constructor(maxWidth, maxHeight) {
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    const locale = typeof navigator !== "undefined" ? navigator.language : "en-US";
    this.wordSegmenter = new Intl.Segmenter(locale, { granularity: "word" });
    this.charSegmenter = new Intl.Segmenter(locale, { granularity: "grapheme" });
  }
  getWordSegments(paragraph) {
    const cached = this.wordCache.get(paragraph);
    if (cached) return cached;
    const fresh = Array.from(this.wordSegmenter.segment(paragraph)).map((s) => ({
      segment: s.segment,
      isWordLike: s.isWordLike
    }));
    if (this.wordCache.size > 500) this.wordCache.clear();
    this.wordCache.set(paragraph, fresh);
    return fresh;
  }
  getGraphemes(word) {
    const cached = this.graphemeCache.get(word);
    if (cached) return cached;
    const fresh = Array.from(this.charSegmenter.segment(word)).map((g) => g.segment);
    if (this.graphemeCache.size > 2e3) this.graphemeCache.clear();
    this.graphemeCache.set(word, fresh);
    return fresh;
  }
  /**
   * Lay out a Unicode string into a list of positioned {@link LayoutNode} glyphs.
   *
   * Uses `Intl.Segmenter` to correctly handle CJK, emoji, and Western word
   * boundaries.  An optional `exclusionMask` callback allows glyphs to flow
   * around arbitrary shapes (e.g. physics bodies or video regions).
   *
   * @param text - The raw text string to lay out (newlines force paragraph breaks).
   * @param fontAtlas - Pre-measured glyph metrics keyed by grapheme character.
   * @param fontSize - Target font size in pixels (default: `32`).
   * @param exclusionMask - Optional callback returning `true` when a candidate
   *   glyph bounding box overlaps a forbidden region; the engine skips that
   *   position and advances horizontally.
   * @returns A {@link LayoutResult} with all positioned glyph nodes and total dimensions.
   * @example
   * const result = engine.layoutText('Hello 世界', atlas, 24);
   * result.nodes.forEach(n => console.log(n.char, n.x, n.y));
   */
  layoutText(text, fontAtlas, fontSize = 32, exclusionMask) {
    const layoutNodes = [];
    let currentX = 0;
    let currentY = 0;
    const lineHeight = fontSize * 1.5;
    const paragraphs = text.split("\n");
    for (const paragraph of paragraphs) {
      if (paragraph.length === 0) {
        currentY += lineHeight;
        currentX = 0;
        continue;
      }
      const segments = this.getWordSegments(paragraph);
      for (const segment of segments) {
        const word = segment.segment;
        let wordWidth = 0;
        const graphemes = this.getGraphemes(word);
        for (const char of graphemes) {
          const glyphInfo = fontAtlas[char];
          wordWidth += glyphInfo ? glyphInfo.width * (fontSize / glyphInfo.baseSize) : fontSize * 0.5;
        }
        if (currentX + wordWidth > this.maxWidth && currentX > 0) {
          if (segment.isWordLike === false && word.trim().length === 0) {
            continue;
          }
          currentX = 0;
          currentY += lineHeight;
        }
        for (const char of graphemes) {
          const glyphInfo = fontAtlas[char];
          const charWidth = glyphInfo ? glyphInfo.width * (fontSize / glyphInfo.baseSize) : fontSize * 0.5;
          let foundSpot = false;
          while (currentY < this.maxHeight) {
            if (currentX + charWidth > this.maxWidth && currentX > 0) {
              currentX = 0;
              currentY += lineHeight;
              continue;
            }
            if (exclusionMask && exclusionMask(currentX, currentY, charWidth, fontSize)) {
              currentX += charWidth;
              continue;
            }
            foundSpot = true;
            break;
          }
          if (!foundSpot || currentY >= this.maxHeight) break;
          if (currentX === 0 && char.trim().length === 0) {
            continue;
          }
          layoutNodes.push({
            char,
            x: currentX,
            y: currentY,
            width: charWidth,
            height: fontSize
          });
          currentX += charWidth;
        }
      }
      currentX = 0;
      currentY += lineHeight;
    }
    return {
      nodes: layoutNodes,
      totalWidth: this.maxWidth,
      totalHeight: currentY
    };
  }
  /**
   * Lay out a Unicode string directly into a pre-allocated {@link LayoutResultBuffer}.
   *
   * Avoids GC allocations by writing results directly to flat typed arrays in the buffer.
   *
   * @param text - The raw text string to lay out.
   * @param fontAtlas - Pre-measured glyph metrics keyed by grapheme character.
   * @param fontSize - Target font size in pixels.
   * @param buffer - The pre-allocated buffer to write layout results into.
   * @param exclusionMask - Optional collision-detection callback.
   */
  layoutTextIntoBuffer(text, fontAtlas, fontSize, buffer, exclusionMask) {
    buffer.reset();
    let currentX = 0;
    let currentY = 0;
    const lineHeight = fontSize * 1.5;
    const paragraphs = text.split("\n");
    for (const paragraph of paragraphs) {
      if (paragraph.length === 0) {
        currentY += lineHeight;
        currentX = 0;
        continue;
      }
      const segments = this.getWordSegments(paragraph);
      for (const segment of segments) {
        const word = segment.segment;
        let wordWidth = 0;
        const graphemes = this.getGraphemes(word);
        for (const char of graphemes) {
          const glyphInfo = fontAtlas[char];
          wordWidth += glyphInfo ? glyphInfo.width * (fontSize / glyphInfo.baseSize) : fontSize * 0.5;
        }
        if (currentX + wordWidth > this.maxWidth && currentX > 0) {
          if (segment.isWordLike === false && word.trim().length === 0) {
            continue;
          }
          currentX = 0;
          currentY += lineHeight;
        }
        for (const char of graphemes) {
          if (buffer.count >= LayoutResultBuffer.CAPACITY) break;
          const glyphInfo = fontAtlas[char];
          const charWidth = glyphInfo ? glyphInfo.width * (fontSize / glyphInfo.baseSize) : fontSize * 0.5;
          let foundSpot = false;
          while (currentY < this.maxHeight) {
            if (currentX + charWidth > this.maxWidth && currentX > 0) {
              currentX = 0;
              currentY += lineHeight;
              continue;
            }
            if (exclusionMask && exclusionMask(currentX, currentY, charWidth, fontSize)) {
              currentX += charWidth;
              continue;
            }
            foundSpot = true;
            break;
          }
          if (!foundSpot || currentY >= this.maxHeight) break;
          if (currentX === 0 && char.trim().length === 0) {
            continue;
          }
          const idx = buffer.count;
          buffer.chars[idx] = char;
          buffer.xs[idx] = currentX;
          buffer.ys[idx] = currentY;
          buffer.ws[idx] = charWidth;
          buffer.hs[idx] = fontSize;
          buffer.count++;
          currentX += charWidth;
        }
      }
      currentX = 0;
      currentY += lineHeight;
    }
  }
};
var LayoutResultBuffer = class _LayoutResultBuffer {
  static CAPACITY = 16384;
  /** X positions of each glyph. */
  xs = new Float32Array(_LayoutResultBuffer.CAPACITY);
  /** Y positions of each glyph. */
  ys = new Float32Array(_LayoutResultBuffer.CAPACITY);
  /** Widths of each glyph. */
  ws = new Float32Array(_LayoutResultBuffer.CAPACITY);
  /** Heights of each glyph. */
  hs = new Float32Array(_LayoutResultBuffer.CAPACITY);
  /** Character for each glyph slot. */
  chars = Array.from({ length: _LayoutResultBuffer.CAPACITY });
  /** Number of valid glyphs written in this buffer. */
  count = 0;
  /** Reset the buffer for reuse. Does NOT free memory. */
  reset() {
    this.count = 0;
  }
  /** Convert to the standard LayoutResult format (allocates — use sparingly). */
  toLayoutResult() {
    const nodes = [];
    for (let i = 0; i < this.count; i++) {
      nodes.push({
        char: this.chars[i],
        x: this.xs[i],
        y: this.ys[i],
        width: this.ws[i],
        height: this.hs[i]
      });
    }
    return { nodes, totalWidth: 0, totalHeight: 0 };
  }
};

// src/components/TextEntity.ts
var TextEntity = class extends Entity {
  text;
  atlas;
  layout;
  nodes = [];
  fontSize;
  fillStyle = "#94a3b8";
  strokeStyle = null;
  hoveredFillStyle = "#ffffff";
  lineWidth = 1;
  isHovered = false;
  constructor(text, atlas, maxWidth, fontSize = 24) {
    super();
    this.text = text;
    this.atlas = atlas;
    this.fontSize = fontSize;
    this.layout = new LayoutEngine(maxWidth, 1e4);
    this.updateLayout();
    this.interactive = true;
    this.on("hover", () => this.isHovered = true);
    this.on("pointerleave", () => this.isHovered = false);
  }
  updateLayout() {
    const result = this.layout.layoutText(this.text, this.atlas, this.fontSize);
    this.nodes = result.nodes;
    this.width = result.totalWidth;
    this.height = result.totalHeight;
    this.a11yOffsetY = 0;
  }
  isPointInside(globalX, globalY) {
    const pos = this.getGlobalPosition();
    const lx = globalX - pos.x;
    const ly = globalY - pos.y;
    return lx >= 0 && lx <= this.width && ly >= 0 && ly <= this.height;
  }
  render(renderer) {
    const currentFill = this.isHovered ? this.hoveredFillStyle : this.fillStyle;
    for (const node of this.nodes) {
      const glyph = this.atlas[node.char];
      if (!glyph) {
        renderer.save();
        renderer.translate(node.x, node.y + this.fontSize * 0.8);
        renderer.fillText(node.char, 0, 0, `${this.fontSize}px sans-serif`, currentFill);
        renderer.restore();
        continue;
      }
      renderer.save();
      renderer.translate(node.x, node.y);
      const scale = this.fontSize / glyph.baseSize;
      renderer.scale(scale, scale);
      for (const path of glyph.ast.paths) {
        renderer.beginPath();
        for (const cmd of path.commands) {
          if (cmd.type === "M") renderer.moveTo(cmd.x, cmd.y);
          else if (cmd.type === "L") renderer.lineTo(cmd.x, cmd.y);
          else if (cmd.type === "C")
            renderer.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          else if (cmd.type === "Z") renderer.closePath();
        }
        if (currentFill) {
          renderer.fill(currentFill);
        }
        if (this.strokeStyle) {
          renderer.stroke(this.strokeStyle, this.lineWidth / scale);
        }
      }
      renderer.restore();
    }
  }
};

// src/components/GridTextEntity.ts
var GridTextEntity = class extends Entity {
  fontSize;
  fillStyle = "#ffffff";
  grid = [];
  // Array of rows
  cols = 0;
  rows = 0;
  charWidth;
  charHeight;
  constructor(_atlas, fontSize = 10) {
    super();
    this.fontSize = fontSize;
    this.charWidth = fontSize * 1;
    this.charHeight = fontSize * 1.1;
    this.interactive = false;
  }
  updateGrid(ascii) {
    this.grid = ascii;
    this.rows = ascii.length;
    this.cols = ascii[0]?.length || 0;
  }
  isPointInside(_globalX, _globalY) {
    return false;
  }
  render(renderer) {
    if (this.rows === 0) return;
    for (let r = 0; r < this.rows; r++) {
      const row = this.grid[r];
      if (!row) continue;
      for (let c = 0; c < this.cols; c++) {
        const char = row[c];
        if (char === " ") continue;
        const x = c * this.charWidth;
        const y = r * this.charHeight;
        renderer.save();
        renderer.translate(x, y + this.fontSize * 0.8);
        renderer.fillText(char, 0, 0, `bold ${this.fontSize}px monospace`, this.fillStyle);
        renderer.restore();
      }
    }
  }
};

// src/math/SpatialHashGrid.ts
var SpatialHashGrid = class {
  cellSize;
  grid = /* @__PURE__ */ new Map();
  entityCells = /* @__PURE__ */ new Map();
  constructor(cellSize = 64) {
    this.cellSize = cellSize;
  }
  hash(cx, cy) {
    const x = cx < 0 ? -2 * cx - 1 : 2 * cx;
    const y = cy < 0 ? -2 * cy - 1 : 2 * cy;
    return (x + y) * (x + y + 1) / 2 + y;
  }
  cellsForAABB(x, y, w, h) {
    const minCx = Math.floor(x / this.cellSize);
    const minCy = Math.floor(y / this.cellSize);
    const maxCx = Math.floor((x + w) / this.cellSize);
    const maxCy = Math.floor((y + h) / this.cellSize);
    const keys = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        keys.push(this.hash(cx, cy));
      }
    }
    return keys;
  }
  /**
   * Insert or update an entity's axis-aligned bounding box in the grid.
   *
   * If the entity is already registered its old cell memberships are removed
   * before the new ones are computed, so this method is safe to call every
   * frame.
   *
   * @param id - Unique string identifier for the entity.
   * @param x - Left edge of the AABB in world space.
   * @param y - Top edge of the AABB in world space.
   * @param w - Width of the AABB.
   * @param h - Height of the AABB.
   */
  insert(id, x, y, w, h) {
    this.remove(id);
    const keys = this.cellsForAABB(x, y, w, h);
    this.entityCells.set(id, keys);
    for (const key of keys) {
      if (!this.grid.has(key)) this.grid.set(key, /* @__PURE__ */ new Set());
      this.grid.get(key).add(id);
    }
  }
  /**
   * Remove an entity from all grid cells it currently occupies.
   *
   * Silently does nothing if the entity is not registered.
   *
   * @param id - Unique string identifier of the entity to remove.
   */
  remove(id) {
    const keys = this.entityCells.get(id);
    if (!keys) return;
    for (const key of keys) {
      this.grid.get(key)?.delete(id);
    }
    this.entityCells.delete(id);
  }
  /**
   * Return all entity IDs whose grid cells overlap the given AABB.
   *
   * Time complexity: O(k) where k is the number of cells the query AABB spans
   * plus the number of results — O(1) average for small, similarly-sized entities.
   *
   * @param x - Left edge of the query AABB.
   * @param y - Top edge of the query AABB.
   * @param w - Width of the query AABB.
   * @param h - Height of the query AABB.
   * @returns A `Set` of entity ID strings whose cells intersect the query region.
   */
  query(x, y, w, h) {
    const result = /* @__PURE__ */ new Set();
    for (const key of this.cellsForAABB(x, y, w, h)) {
      const cell = this.grid.get(key);
      if (cell) for (const id of cell) result.add(id);
    }
    return result;
  }
  /**
   * Clear all cells and entity registrations, resetting the grid to an empty state.
   *
   * Call once per frame before re-inserting all dynamic entities.
   */
  clear() {
    this.grid.clear();
    this.entityCells.clear();
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CanvasRenderer,
  Entity,
  GridTextEntity,
  LayoutEngine,
  LayoutResultBuffer,
  Scene,
  SpatialHashGrid,
  TextEntity
});
