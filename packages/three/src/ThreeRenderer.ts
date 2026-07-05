import { IRenderer, parseColorToRGBA } from '@vectojs/core';
import * as THREE from 'three';

function parseThreeColor(value: string): { color: THREE.Color; alpha: number } {
  const [r, g, b, alpha] = parseColorToRGBA(value);
  return { color: new THREE.Color(r, g, b), alpha };
}

export class WebGLGradient {
  public type = 'linear';
  constructor(
    public x0: number,
    public y0: number,
    public x1: number,
    public y1: number,
    public colorStops: { stop: number; color: string }[],
  ) {}
}

/**
 * A internal helper to wrap ThreeJS Path drawing logic using THREE.Shape.
 */
class ThreePath {
  private shapes: THREE.Shape[] = [];
  private currentShape: THREE.Shape | null = null;

  constructor() {
    this.moveTo(0, 0);
  }

  private getShape(): THREE.Shape {
    if (!this.currentShape) {
      this.currentShape = new THREE.Shape();
      this.shapes.push(this.currentShape);
    }
    return this.currentShape;
  }

  public moveTo(x: number, y: number): void {
    if (this.currentShape && this.currentShape.curves.length > 0) {
      this.currentShape = new THREE.Shape();
      this.shapes.push(this.currentShape);
    }
    this.getShape().moveTo(x, y);
  }

  public lineTo(x: number, y: number): void {
    this.getShape().lineTo(x, y);
  }

  public bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.getShape().bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  public closePath(): void {
    this.currentShape?.closePath();
  }

  public arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void {
    this.getShape().absarc(x, y, radius, startAngle, endAngle, counterclockwise);
  }

  public toShapes(): THREE.Shape[] {
    return this.shapes;
  }

  public getPoints(): THREE.Vector2[] {
    const allPoints: THREE.Vector2[] = [];
    for (const shape of this.shapes) {
      allPoints.push(...shape.getPoints());
    }
    return allPoints;
  }
}

/**
 * WebGL/Three.js implementation of {@link IRenderer}.
 *
 * Bridges VectoJS's 2D canvas API to Three.js for 3D hardware-accelerated rendering.
 */
export class ThreeRenderer implements IRenderer {
  public scene: THREE.Scene;
  public camera: THREE.OrthographicCamera;
  public renderer: THREE.WebGLRenderer;

  private width: number;
  private height: number;

  private matrix: THREE.Matrix4;
  private stack: THREE.Matrix4[] = [];

  private globalAlpha: number = 1;
  private alphaStack: number[] = [];

  private currentPath: ThreePath | null = null;
  private activeObjects: THREE.Object3D[] = [];
  private scissorStack: Array<{ enabled: boolean; box: THREE.Vector4 }> = [];

  constructor(canvas: HTMLCanvasElement) {
    // Prefer the canvas's own backing-store size for non-fullscreen embedding
    // (offscreen framebuffers, WebXR render targets, embedded demo apps).
    // Fall back to window dimensions only when the canvas has no intrinsic size.
    const cw =
      canvas.width > 0 ? canvas.width : typeof window !== 'undefined' ? window.innerWidth : 1024;
    const ch =
      canvas.height > 0 ? canvas.height : typeof window !== 'undefined' ? window.innerHeight : 1024;
    this.width = cw;
    this.height = ch;

    this.scene = new THREE.Scene();
    // Set up orthographic camera where y-axis points down (top is 0, bottom is height)
    this.camera = new THREE.OrthographicCamera(0, this.width, 0, this.height, 0.1, 1000);
    this.camera.position.z = 1;

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    this.matrix = new THREE.Matrix4().identity();
  }

  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height);
    this.camera.right = width;
    this.camera.bottom = height;
    this.camera.updateProjectionMatrix();
  }

  clear(): void {
    this.disposeActiveObjects();
    this.currentPath = null;
    this.matrix.identity();
    this.stack.length = 0;
    this.globalAlpha = 1;
    this.alphaStack.length = 0;
    this.scissorStack.length = 0;
    this.renderer.clear();
    this.renderer.setScissorTest(false);
  }

  private disposeActiveObjects(): void {
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();
    const disposedTextures = new Set<THREE.Texture>();

    for (const object of this.activeObjects) {
      this.scene.remove(object);
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) continue;

      const geometry = object.geometry;
      if (!disposedGeometries.has(geometry)) {
        disposedGeometries.add(geometry);
        geometry.dispose();
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const map = (material as THREE.Material & { map?: THREE.Texture | null }).map;
        if (map && !disposedTextures.has(map)) {
          disposedTextures.add(map);
          map.dispose();
        }
        if (!disposedMaterials.has(material)) {
          disposedMaterials.add(material);
          material.dispose();
        }
      }
    }
    this.activeObjects.length = 0;
  }

  save(): void {
    this.stack.push(this.matrix.clone());
    this.alphaStack.push(this.globalAlpha);

    const box = new THREE.Vector4();
    this.renderer.getScissor(box);
    this.scissorStack.push({
      enabled: this.renderer.getScissorTest(),
      box,
    });
  }

  restore(): void {
    if (this.stack.length > 0) this.matrix.copy(this.stack.pop()!);
    if (this.alphaStack.length > 0) this.globalAlpha = this.alphaStack.pop()!;

    if (this.scissorStack.length > 0) {
      const state = this.scissorStack.pop()!;
      this.renderer.setScissorTest(state.enabled);
      this.renderer.setScissor(state.box);
    }
  }

  translate(x: number, y: number): void {
    const m = new THREE.Matrix4().makeTranslation(x, y, 0);
    this.matrix.multiply(m);
  }

  scale(x: number, y: number): void {
    const m = new THREE.Matrix4().makeScale(x, y, 1);
    this.matrix.multiply(m);
  }

  rotate(angle: number): void {
    const m = new THREE.Matrix4().makeRotationZ(angle);
    this.matrix.multiply(m);
  }

  setGlobalAlpha(alpha: number): void {
    this.globalAlpha = alpha;
  }

  clip(x: number, y: number, width: number, height: number): void {
    const corners = [
      new THREE.Vector3(x, y, 0),
      new THREE.Vector3(x + width, y, 0),
      new THREE.Vector3(x, y + height, 0),
      new THREE.Vector3(x + width, y + height, 0),
    ].map((point) => point.applyMatrix4(this.matrix));
    const minX = Math.min(...corners.map((point) => point.x));
    const minY = Math.min(...corners.map((point) => point.y));
    const maxX = Math.max(...corners.map((point) => point.x));
    const maxY = Math.max(...corners.map((point) => point.y));

    // Convert to bottom-left origin for Three.js scissor test
    const dpr = window.devicePixelRatio || 1;
    const canvasHeight = this.renderer.domElement.height / dpr;
    let scissorX = minX * dpr;
    let scissorY = (canvasHeight - maxY) * dpr;
    let scissorWidth = (maxX - minX) * dpr;
    let scissorHeight = (maxY - minY) * dpr;

    if (this.renderer.getScissorTest()) {
      const current = new THREE.Vector4();
      this.renderer.getScissor(current);
      const right = Math.min(scissorX + scissorWidth, current.x + current.z);
      const top = Math.min(scissorY + scissorHeight, current.y + current.w);
      scissorX = Math.max(scissorX, current.x);
      scissorY = Math.max(scissorY, current.y);
      scissorWidth = Math.max(0, right - scissorX);
      scissorHeight = Math.max(0, top - scissorY);
    }

    this.renderer.setScissor(scissorX, scissorY, scissorWidth, scissorHeight);
    this.renderer.setScissorTest(true);
  }

  beginPath(): void {
    this.currentPath = new ThreePath();
  }

  moveTo(x: number, y: number): void {
    this.currentPath?.moveTo(x, y);
  }

  lineTo(x: number, y: number): void {
    this.currentPath?.lineTo(x, y);
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.currentPath?.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  closePath(): void {
    this.currentPath?.closePath();
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void {
    this.currentPath?.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }

  roundRect(x: number, y: number, width: number, height: number, radii: number | number[]): void {
    if (!this.currentPath) return;

    if (width < 0) {
      x += width;
      width = -width;
    }
    if (height < 0) {
      y += height;
      height = -height;
    }

    let r_tl = 0,
      r_tr = 0,
      r_br = 0,
      r_bl = 0;
    if (typeof radii === 'number') {
      r_tl = r_tr = r_br = r_bl = radii;
    } else if (Array.isArray(radii)) {
      if (radii.length === 1) {
        r_tl = r_tr = r_br = r_bl = radii[0];
      } else if (radii.length === 2) {
        r_tl = r_br = radii[0];
        r_tr = r_bl = radii[1];
      } else if (radii.length === 3) {
        r_tl = radii[0];
        r_tr = r_bl = radii[1];
        r_br = radii[2];
      } else if (radii.length >= 4) {
        r_tl = radii[0];
        r_tr = radii[1];
        r_br = radii[2];
        r_bl = radii[3];
      }
    }

    const tl_tr = r_tl + r_tr;
    const bl_br = r_bl + r_br;
    const tl_bl = r_tl + r_bl;
    const tr_br = r_tr + r_br;
    let factor = 1.0;
    if (tl_tr > width) factor = Math.min(factor, width / tl_tr);
    if (bl_br > width) factor = Math.min(factor, width / bl_br);
    if (tl_bl > height) factor = Math.min(factor, height / tl_bl);
    if (tr_br > height) factor = Math.min(factor, height / tr_br);
    if (factor < 1.0) {
      r_tl *= factor;
      r_tr *= factor;
      r_br *= factor;
      r_bl *= factor;
    }

    this.currentPath.moveTo(x + r_tl, y);
    this.currentPath.lineTo(x + width - r_tr, y);
    this.currentPath.arc(x + width - r_tr, y + r_tr, r_tr, -Math.PI / 2, 0, false);
    this.currentPath.lineTo(x + width, y + height - r_br);
    this.currentPath.arc(x + width - r_br, y + height - r_br, r_br, 0, Math.PI / 2, false);
    this.currentPath.lineTo(x + r_bl, y + height);
    this.currentPath.arc(x + r_bl, y + height - r_bl, r_bl, Math.PI / 2, Math.PI, false);
    this.currentPath.lineTo(x, y + r_tl);
    this.currentPath.arc(x + r_tl, y + r_tl, r_tl, Math.PI, -Math.PI / 2, false);
  }

  drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
    let texture: THREE.Texture;
    if (
      source instanceof HTMLImageElement ||
      source instanceof HTMLCanvasElement ||
      (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap)
    ) {
      texture = new THREE.CanvasTexture(source as any);
    } else {
      texture = new THREE.Texture(source as any);
      texture.needsUpdate = true;
    }
    texture.minFilter = THREE.LinearFilter;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: this.globalAlpha,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(dw, dh);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(dx + dw / 2, dy + dh / 2, 0);
    mesh.applyMatrix4(this.matrix);

    this.scene.add(mesh);
    this.activeObjects.push(mesh);
  }

  fill(colorOrGradient: string | any): void {
    if (!this.currentPath) return;

    if (colorOrGradient && colorOrGradient.type === 'linear') {
      const grad = colorOrGradient as WebGLGradient;
      const sortedStops = [...grad.colorStops].sort((a, b) => a.stop - b.stop);

      if (sortedStops.length < 2) {
        const fallbackColor = sortedStops.length === 1 ? sortedStops[0].color : '#ffffff';
        this.fillSolidShape(fallbackColor);
        return;
      }

      const finalColors: THREE.Vector4[] = [];
      const finalStops: number[] = [];

      if (sortedStops.length > 8) {
        const lerpColor = (c1: string, c2: string, f: number) => {
          const rgba1 = parseColorToRGBA(c1);
          const rgba2 = parseColorToRGBA(c2);
          return new THREE.Vector4(
            rgba1[0] + (rgba2[0] - rgba1[0]) * f,
            rgba1[1] + (rgba2[1] - rgba1[1]) * f,
            rgba1[2] + (rgba2[2] - rgba1[2]) * f,
            rgba1[3] + (rgba2[3] - rgba1[3]) * f,
          );
        };

        for (let k = 0; k < 8; k++) {
          const t = k / 7;
          if (t <= sortedStops[0].stop) {
            const rgba = parseColorToRGBA(sortedStops[0].color);
            finalColors.push(new THREE.Vector4(rgba[0], rgba[1], rgba[2], rgba[3]));
          } else if (t >= sortedStops[sortedStops.length - 1].stop) {
            const rgba = parseColorToRGBA(sortedStops[sortedStops.length - 1].color);
            finalColors.push(new THREE.Vector4(rgba[0], rgba[1], rgba[2], rgba[3]));
          } else {
            let i = 0;
            for (let idx = 0; idx < sortedStops.length - 1; idx++) {
              if (t >= sortedStops[idx].stop && t <= sortedStops[idx + 1].stop) {
                i = idx;
                break;
              }
            }
            const gap = sortedStops[i + 1].stop - sortedStops[i].stop;
            const f = gap > 0.0001 ? (t - sortedStops[i].stop) / gap : 0.0;
            finalColors.push(lerpColor(sortedStops[i].color, sortedStops[i + 1].color, f));
          }
          finalStops.push(t);
        }
      } else {
        for (let i = 0; i < 8; i++) {
          const stopIdx = Math.min(i, sortedStops.length - 1);
          const stop = sortedStops[stopIdx];
          const rgba = parseColorToRGBA(stop.color);
          finalColors.push(new THREE.Vector4(rgba[0], rgba[1], rgba[2], rgba[3]));
          finalStops.push(stop.stop);
        }
      }

      const u_grad_start = new THREE.Vector3(grad.x0, grad.y0, 0).applyMatrix4(this.matrix);
      const u_grad_end = new THREE.Vector3(grad.x1, grad.y1, 0).applyMatrix4(this.matrix);

      const shapes = this.currentPath.toShapes();
      for (const shape of shapes) {
        const geometry = new THREE.ShapeGeometry(shape);
        const material = new THREE.ShaderMaterial({
          uniforms: {
            u_grad_start: { value: new THREE.Vector2(u_grad_start.x, u_grad_start.y) },
            u_grad_end: { value: new THREE.Vector2(u_grad_end.x, u_grad_end.y) },
            u_grad_colors: { value: finalColors },
            u_grad_stops: { value: finalStops },
            u_global_alpha: { value: this.globalAlpha },
          },
          vertexShader: `
            varying vec2 v_world_pos;
            void main() {
              vec4 worldPos = modelMatrix * vec4(position, 1.0);
              v_world_pos = worldPos.xy;
              gl_Position = projectionMatrix * viewMatrix * worldPos;
            }
          `,
          fragmentShader: `
            varying vec2 v_world_pos;
            uniform vec2 u_grad_start;
            uniform vec2 u_grad_end;
            uniform vec4 u_grad_colors[8];
            uniform float u_grad_stops[8];
            uniform float u_global_alpha;

            void main() {
              vec2 d = u_grad_end - u_grad_start;
              float d_len_sq = dot(d, d);
              float t = 0.0;
              if (d_len_sq > 0.0001) {
                t = clamp(dot(v_world_pos - u_grad_start, d) / d_len_sq, 0.0, 1.0);
              }
              vec4 finalColor = u_grad_colors[7];
              if (t <= u_grad_stops[0]) {
                finalColor = u_grad_colors[0];
              } else {
                for (int i = 0; i < 7; i++) {
                  if (t >= u_grad_stops[i] && t <= u_grad_stops[i+1]) {
                    float gap = u_grad_stops[i+1] - u_grad_stops[i];
                    float factor = gap > 0.0001 ? (t - u_grad_stops[i]) / gap : 0.0;
                    finalColor = mix(u_grad_colors[i], u_grad_colors[i+1], factor);
                    break;
                  }
                }
              }
              gl_FragColor = vec4(finalColor.rgb, finalColor.a * u_global_alpha);
            }
          `,
          transparent: true,
          depthWrite: false,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.applyMatrix4(this.matrix);
        this.scene.add(mesh);
        this.activeObjects.push(mesh);
      }
    } else {
      this.fillSolidShape(colorOrGradient);
    }
  }

  private fillSolidShape(colorOrGradient: any): void {
    if (!this.currentPath) return;
    const color = typeof colorOrGradient === 'string' ? colorOrGradient : '#ffffff';
    const parsed = parseThreeColor(color);
    const shapes = this.currentPath.toShapes();

    for (const shape of shapes) {
      const geometry = new THREE.ShapeGeometry(shape);
      const opacity = this.globalAlpha * parsed.alpha;
      const material = new THREE.MeshBasicMaterial({
        color: parsed.color,
        transparent: opacity < 1,
        opacity,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.applyMatrix4(this.matrix);

      this.scene.add(mesh);
      this.activeObjects.push(mesh);
    }
  }

  stroke(colorOrGradient: string | any, lineWidth: number = 1): void {
    if (!this.currentPath) return;
    let color = '#ffffff';
    if (typeof colorOrGradient === 'string') {
      color = colorOrGradient;
    } else if (colorOrGradient && colorOrGradient.type === 'linear') {
      const grad = colorOrGradient as WebGLGradient;
      if (grad.colorStops && grad.colorStops.length > 0) {
        color = grad.colorStops[0].color;
      }
    }

    const points = this.currentPath.getPoints();
    if (points.length === 0) return;

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const parsed = parseThreeColor(color);
    const opacity = this.globalAlpha * parsed.alpha;
    const material = new THREE.LineBasicMaterial({
      color: parsed.color,
      transparent: opacity < 1,
      opacity,
      linewidth: lineWidth,
    });
    const line = new THREE.Line(geometry, material);
    line.applyMatrix4(this.matrix);

    this.scene.add(line);
    this.activeObjects.push(line);
  }

  fillText(text: string, x: number, y: number, font: string, color: string | any): void {
    if (typeof document === 'undefined') return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = font;

    const width = Math.max(1, Math.ceil(ctx.measureText(text).width));
    const fontSize = parseInt(font) || 16;
    const height = Math.max(1, Math.ceil(fontSize * 1.5));
    canvas.width = width;
    canvas.height = height;

    ctx.font = font;

    let fillCol = '#ffffff';
    if (typeof color === 'string') {
      fillCol = color;
    } else if (color && color.type === 'linear') {
      const grad = color as WebGLGradient;
      if (grad.colorStops && grad.colorStops.length > 0) {
        fillCol = grad.colorStops[0].color;
      }
    }

    ctx.fillStyle = fillCol;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, 0, fontSize);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: this.globalAlpha,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(width, height);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x + width / 2, y - height / 2 + fontSize, 0);
    mesh.applyMatrix4(this.matrix);

    this.scene.add(mesh);
    this.activeObjects.push(mesh);
  }

  fillCircle(cx: number, cy: number, radius: number, color: string, alpha: number = 1): void {
    const geometry = new THREE.CircleGeometry(radius, 32);
    const parsed = parseThreeColor(color);
    const opacity = this.globalAlpha * alpha * parsed.alpha;
    const material = new THREE.MeshBasicMaterial({
      color: parsed.color,
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx, cy, 0);
    mesh.applyMatrix4(this.matrix);

    this.scene.add(mesh);
    this.activeObjects.push(mesh);
  }

  flush(): void {
    this.renderer.render(this.scene, this.camera);
  }

  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colorStops: { stop: number; color: string }[],
  ): any {
    return new WebGLGradient(x0, y0, x1, y1, colorStops);
  }

  private disposed = false;
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeActiveObjects();
    this.currentPath = null;
    this.stack.length = 0;
    this.alphaStack.length = 0;
    this.scissorStack.length = 0;
    this.renderer.setScissorTest(false);
    // The WebGLRenderer holds the actual GL context — release it.
    this.renderer.dispose();
  }
}
