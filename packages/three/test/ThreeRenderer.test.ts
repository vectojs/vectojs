// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreeRenderer } from '../src/ThreeRenderer';
import * as THREE from 'three';

// Mock WebGLRenderer to prevent crashing in headless jsdom environment
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class MockWebGLRenderer {
    domElement = document.createElement('canvas');
    private scissor = new actual.Vector4();
    private scissorTest = false;
    constructor(options: any = {}) {
      if (options.canvas) {
        this.domElement = options.canvas;
      }
    }
    private pixelRatio = 1;
    setSize = vi.fn();
    setPixelRatio = vi.fn((r: number) => {
      this.pixelRatio = r;
    });
    getPixelRatio = vi.fn(() => this.pixelRatio);
    clear = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
    forceContextLoss = vi.fn();
    setScissor = vi.fn((x: number | THREE.Vector4, y?: number, z?: number, w?: number) => {
      if (x instanceof actual.Vector4) this.scissor.copy(x);
      else this.scissor.set(x, y ?? 0, z ?? 0, w ?? 0);
    });
    setScissorTest = vi.fn((enabled: boolean) => {
      this.scissorTest = enabled;
    });
    getScissor = vi.fn((v: THREE.Vector4) => v.copy(this.scissor));
    getScissorTest = vi.fn(() => this.scissorTest);
  }

  return {
    ...actual,
    WebGLRenderer: MockWebGLRenderer as any,
  };
});

describe('ThreeRenderer', () => {
  let canvas: HTMLCanvasElement;
  let renderer: ThreeRenderer;

  beforeEach(() => {
    // Stub getContext('2d') to avoid returning null in jsdom without canvas package
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return {
          font: '',
          fillStyle: '',
          measureText: () => ({ width: 100 }),
          fillText: () => {},
          scale: () => {},
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };

    canvas = document.createElement('canvas');
    renderer = new ThreeRenderer(canvas);
  });

  it('is instantiable and has ThreeJS scene, camera and renderer', () => {
    expect(renderer).toBeDefined();
    expect(renderer.scene).toBeInstanceOf(THREE.Scene);
    expect(renderer.camera).toBeInstanceOf(THREE.OrthographicCamera);
    expect(renderer.renderer).toBeDefined();
  });

  it('can accumulate path operations and clear them', () => {
    renderer.beginPath();
    renderer.moveTo(10, 10);
    renderer.lineTo(20, 20);
    renderer.closePath();

    // Fill creates a mesh in the scene
    renderer.fill('#38bdf8');
    expect(renderer.scene.children.length).toBe(1);

    // Clear disposes and removes the mesh
    renderer.clear();
    expect(renderer.scene.children.length).toBe(0);
  });

  it('clear resets transient transform, alpha, and stack state', () => {
    renderer.save();
    renderer.translate(25, 40);
    renderer.setGlobalAlpha(0.25);

    renderer.clear();

    expect((renderer as any).matrix.equals(new THREE.Matrix4().identity())).toBe(true);
    expect((renderer as any).globalAlpha).toBe(1);
    expect((renderer as any).stack).toHaveLength(0);
    expect((renderer as any).alphaStack).toHaveLength(0);
    expect((renderer as any).scissorStack).toHaveLength(0);
  });

  it('handles transform matrices stack correctly', () => {
    // Initial identity matrix
    const mat1 = (renderer as any).matrix.clone();

    renderer.save();
    renderer.translate(50, 100);
    renderer.scale(2, 3);
    renderer.rotate(Math.PI / 2);

    const mat2 = (renderer as any).matrix.clone();
    expect(mat2.equals(mat1)).toBe(false);

    renderer.restore();
    const mat3 = (renderer as any).matrix.clone();
    expect(mat3.equals(mat1)).toBe(true);
  });

  it('uses a non-negative world AABB for rotated scissor clips', () => {
    renderer.rotate(Math.PI / 2);

    renderer.clip(0, 0, 100, 50);

    const call = vi.mocked(renderer.renderer.setScissor).mock.calls.at(-1)!;
    expect(call[2]).toBeCloseTo(50);
    expect(call[3]).toBeCloseTo(100);
  });

  it('intersects nested scissor clips instead of replacing the parent clip', () => {
    renderer.clip(0, 0, 100, 100);
    renderer.save();
    renderer.translate(50, 50);

    renderer.clip(0, 0, 100, 100);

    const call = vi.mocked(renderer.renderer.setScissor).mock.calls.at(-1)!;
    expect(call[2]).toBeCloseTo(50);
    expect(call[3]).toBeCloseTo(50);
  });

  it('can draw text using CanvasTexture', () => {
    renderer.beginPath();
    renderer.fillText('Hello World', 50, 50, '16px sans-serif', '#ffffff');
    expect(renderer.scene.children.length).toBe(1);
    const textMesh = renderer.scene.children[0];
    expect(textMesh).toBeInstanceOf(THREE.Mesh);
  });

  it('can draw circles via fillCircle', () => {
    renderer.fillCircle(100, 100, 20, '#ff0000');
    expect(renderer.scene.children.length).toBe(1);
    const circleMesh = renderer.scene.children[0];
    expect(circleMesh).toBeInstanceOf(THREE.Mesh);
  });

  it('multiplies solid CSS color alpha by the renderer alpha', () => {
    renderer.setGlobalAlpha(0.4);
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(20, 0);
    renderer.lineTo(20, 20);
    renderer.closePath();

    renderer.fill('rgba(255, 0, 0, 0.5)');

    const mesh = renderer.scene.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBeCloseTo(0.2);
    expect(material.transparent).toBe(true);
  });

  it('should support WebGLGradient shader creation and fallbacks', () => {
    const grad = renderer.createLinearGradient(0, 0, 100, 100, [
      { stop: 0, color: '#ff0000' },
      { stop: 1, color: '#0000ff' },
    ]);
    expect(grad.type).toBe('linear');

    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(100, 0);
    renderer.lineTo(100, 100);
    renderer.closePath();
    renderer.fill(grad);

    expect(renderer.scene.children.length).toBe(1);
    const mesh = renderer.scene.children[0] as THREE.Mesh;
    expect(mesh.material).toBeInstanceOf(THREE.ShaderMaterial);
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.u_grad_stops).toBeDefined();
  });

  it('flush() only marks the frame dirty; present() does the single GL render', () => {
    renderer.clear();
    for (let i = 0; i < 3; i++) {
      renderer.fillCircle(i * 10, 0, 5, '#ffffff');
      renderer.flush(); // Scene flushes around every non-batched node
    }
    expect(vi.mocked(renderer.renderer.render)).not.toHaveBeenCalled();
    renderer.present();
    expect(vi.mocked(renderer.renderer.render)).toHaveBeenCalledTimes(1);
  });

  it('flush() without present() still paints once via the microtask fallback', async () => {
    renderer.clear();
    renderer.fillCircle(0, 0, 5, '#ffffff');
    renderer.flush();
    renderer.flush();
    renderer.flush();
    await Promise.resolve(); // drain microtasks (older-core compatibility path)
    expect(vi.mocked(renderer.renderer.render)).toHaveBeenCalledTimes(1);
  });

  it('present() after an explicit present does not double-render via the fallback', async () => {
    renderer.clear();
    renderer.fillCircle(0, 0, 5, '#ffffff');
    renderer.flush();
    renderer.present(); // Scene's end-of-frame call
    await Promise.resolve();
    expect(vi.mocked(renderer.renderer.render)).toHaveBeenCalledTimes(1);
  });

  it('stroke() builds one ribbon mesh per sub-path (no geometry across moveTo gaps)', () => {
    renderer.clear();
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(10, 0);
    renderer.moveTo(50, 50); // second sub-path
    renderer.lineTo(60, 50);
    renderer.stroke('#ffffff', 1);
    const strokes = renderer.scene.children.filter((o) => o instanceof THREE.Mesh);
    expect(strokes).toHaveLength(2);
    // Each ribbon carries its own 4 corner vertices — nothing spans the
    // (10,0)→(50,50) gap.
    for (const mesh of strokes) {
      const pos = (mesh as THREE.Mesh).geometry.getAttribute('position');
      expect(pos.count).toBe(4);
    }
  });

  it('stroke() realizes the requested width as geometry (WebGL ignores linewidth)', () => {
    renderer.beginPath();
    renderer.moveTo(10, 0);
    renderer.lineTo(30, 0); // horizontal segment, width 4
    renderer.stroke('#ffffff', 4);

    const mesh = renderer.scene.children[0] as THREE.Mesh;
    expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const pos = mesh.geometry.getAttribute('position');
    // The ribbon must span ±halfWidth around y=0 instead of collapsing to
    // the hairline a Line would have drawn.
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    expect(minY).toBeCloseTo(-2);
    expect(maxY).toBeCloseTo(2);
  });

  it('stroke() ignores non-positive widths like Canvas2D', () => {
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(10, 0);
    renderer.stroke('#ffffff', 0);
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(10, 0);
    renderer.stroke('#ffffff', -3);
    expect(renderer.scene.children).toHaveLength(0);
  });

  it('stroke() samples gradients through the shared shader instead of the first stop', () => {
    const grad = renderer.createLinearGradient(0, 0, 100, 0, [
      { stop: 0, color: '#ff0000' },
      { stop: 1, color: '#0000ff' },
    ]);
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(100, 0);
    renderer.stroke(grad, 2);

    const material = (renderer.scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(material.uniforms.u_grad_stops).toBeDefined();
  });

  it('warns once per process when a gradient exceeds the 8-stop uniform table', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stops = Array.from({ length: 12 }, (_, i) => ({
        stop: i / 11,
        color: i % 2 ? '#ff0000' : '#0000ff',
      }));
      const grad = renderer.createLinearGradient(0, 0, 100, 100, stops);
      renderer.beginPath();
      renderer.moveTo(0, 0);
      renderer.lineTo(100, 0);
      renderer.lineTo(100, 100);
      renderer.closePath();
      renderer.fill(grad);
      renderer.beginPath();
      renderer.moveTo(0, 0);
      renderer.lineTo(100, 0);
      renderer.lineTo(100, 100);
      renderer.closePath();
      renderer.fill(grad); // same over-limit gradient again

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('resampled'));
    } finally {
      warn.mockRestore();
    }
  });

  it('fillText rasterizes a real gradient instead of the first stop color', () => {
    let createdWith: number[] | null = null;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === '2d') {
        return {
          font: '',
          fillStyle: '',
          measureText: () => ({ width: 100 }),
          fillText: () => {},
          scale: () => {},
          createLinearGradient: (...coords: number[]) => {
            createdWith = coords;
            return { addColorStop: () => {} };
          },
        } as any;
      }
      return originalGetContext.apply(this, arguments as any);
    };

    try {
      const grad = renderer.createLinearGradient(100, 20, 200, 20, [
        { stop: 0, color: '#ff0000' },
        { stop: 1, color: '#0000ff' },
      ]);
      renderer.fillText('grad', 100, 50, '16px sans-serif', grad);

      // The axis is translated into the raster's local space: baseline at
      // (100, 50) ↔ raster origin, fontSize 16 → offset y = 34.
      expect(createdWith).toEqual([0, -14, 100, -14]);
      // Distinct cache entry from any solid-color raster of the same text.
      const keys = [...(renderer as any).textTextureCache.keys()] as string[];
      expect(keys[0]).toContain('grad(100,20,200,20;');
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  it('clip() scales the scissor by the renderer pixel ratio, not window DPR', () => {
    renderer.renderer.setPixelRatio(2); // e.g. ThreeAdapter offscreen at fixed ratio
    (window as any).devicePixelRatio = 3; // must be ignored

    renderer.clip(0, 0, 100, 50);

    const call = vi.mocked(renderer.renderer.setScissor).mock.calls.at(-1)!;
    expect(call[2]).toBeCloseTo(200); // 100 × getPixelRatio()
    expect(call[3]).toBeCloseTo(100);
    (window as any).devicePixelRatio = 1;
  });

  describe('fillText font parsing and baseline placement', () => {
    it('parses the size out of a weight-first font shorthand (GH-486)', () => {
      renderer.fillText('Hi', 0, 50, '700 16px Inter', '#ffffff');
      const entry = [...(renderer as any).textTextureCache.values()][0];
      expect(entry.fontSize).toBe(16);
      expect(entry.height).toBe(24); // ceil(16 * 1.5), not ceil(700 * 1.5)
      const mesh = renderer.scene.children[0] as THREE.Mesh;
      expect(mesh.position.y).toBeCloseTo(50 - 16 + 24 / 2); // baseline at y=50
    });

    it('places the alphabetic baseline exactly at the requested y (GH-486)', () => {
      renderer.fillText('Hi', 0, 50, '16px Inter', '#ffffff');
      const entry = [...(renderer as any).textTextureCache.values()][0];
      expect(entry.fontSize).toBe(16);
      const mesh = renderer.scene.children[0] as THREE.Mesh;
      expect(mesh.position.y).toBeCloseTo(50 - entry.fontSize + entry.height / 2);
    });

    it('keeps the texture unflipped and double-sided so the glyphs stay upright and visible', () => {
      renderer.fillText('Hi', 0, 50, '16px Inter', '#ffffff');
      const mesh = renderer.scene.children[0] as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial;
      expect(material.side).toBe(THREE.DoubleSide);
      expect((material.map as THREE.CanvasTexture).flipY).toBe(false);
    });
  });

  describe('fillText texture cache', () => {
    it('reuses one texture for repeated (text, font, color) across frames', () => {
      renderer.fillText('fps: 60', 0, 0, '16px sans-serif', '#fff');
      const first = renderer.scene.children[0] as THREE.Mesh;
      const firstMap = (first.material as THREE.MeshBasicMaterial).map!;
      const mapDispose = vi.spyOn(firstMap, 'dispose');

      renderer.clear(); // next frame
      renderer.fillText('fps: 60', 0, 0, '16px sans-serif', '#fff');
      const second = renderer.scene.children[0] as THREE.Mesh;

      expect((second.material as THREE.MeshBasicMaterial).map).toBe(firstMap);
      expect(mapDispose).not.toHaveBeenCalled(); // clear() must not kill the cache
    });

    it('different text gets a different texture', () => {
      renderer.fillText('fps: 60', 0, 0, '16px sans-serif', '#fff');
      renderer.fillText('fps: 59', 0, 20, '16px sans-serif', '#fff');
      const [a, b] = renderer.scene.children as THREE.Mesh[];
      expect((a.material as THREE.MeshBasicMaterial).map).not.toBe(
        (b.material as THREE.MeshBasicMaterial).map,
      );
    });

    it('evicts least-recently-used textures past the cache limit', () => {
      (renderer as any).textTextureCacheLimit = 2;
      renderer.fillText('a', 0, 0, '16px sans-serif', '#fff');
      const oldest = (renderer.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      const oldestDispose = vi.spyOn(oldest.map!, 'dispose');

      renderer.fillText('b', 0, 0, '16px sans-serif', '#fff');
      renderer.fillText('a', 0, 0, '16px sans-serif', '#fff'); // refresh 'a'
      renderer.fillText('c', 0, 0, '16px sans-serif', '#fff'); // evicts 'b', not 'a'

      expect(oldestDispose).not.toHaveBeenCalled();
      expect((renderer as any).textTextureCache.size).toBe(2);

      renderer.fillText('d', 0, 0, '16px sans-serif', '#fff'); // evicts 'a'
      expect(oldestDispose).toHaveBeenCalledOnce();
    });

    it('dispose() releases cached text textures', () => {
      renderer.fillText('bye', 0, 0, '16px sans-serif', '#fff');
      const map = ((renderer.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial)
        .map!;
      const mapDispose = vi.spyOn(map, 'dispose');

      renderer.dispose();

      expect(mapDispose).toHaveBeenCalledOnce();
      expect((renderer as any).textTextureCache.size).toBe(0);
    });

    it('rasterizes at the renderer pixel ratio and keys the cache on DPR', () => {
      renderer.renderer.setPixelRatio(1);
      renderer.fillText('hi-dpi', 0, 0, '16px sans-serif', '#fff');
      const sd = (renderer.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      expect((sd.map!.image as HTMLCanvasElement).width).toBe(100); // CSS-px width at DPR 1

      renderer.clear();
      renderer.renderer.setPixelRatio(2);
      renderer.fillText('hi-dpi', 0, 0, '16px sans-serif', '#fff');
      const hd = (renderer.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;

      // A DPR change must produce a fresh, 2x-resolution texture — not reuse
      // the DPR-1 raster (which is why the cache key includes the DPR).
      expect(hd.map).not.toBe(sd.map);
      expect((hd.map!.image as HTMLCanvasElement).width).toBe(200);
      // Two distinct cache entries: one per DPR.
      expect((renderer as any).textTextureCache.size).toBe(2);
    });

    it('keeps CSS-pixel plane dimensions even when rasterizing at DPR', () => {
      renderer.renderer.setPixelRatio(2);
      renderer.fillText('Hi', 0, 50, '16px Inter', '#ffffff');
      const entry = [...(renderer as any).textTextureCache.values()][0];
      // Plane geometry stays in CSS pixels (100 × 24); only the backing store
      // is scaled, so the glyphs render at their layout size, sharp.
      expect(entry.width).toBe(100);
      expect(entry.height).toBe(24);
    });
  });

  describe('drawImage texture cache', () => {
    it('reuses one texture per source across frames until invalidated', () => {
      const img = document.createElement('canvas');
      renderer.drawImage(img, 0, 0, 32, 32);
      const first = renderer.scene.children[0] as THREE.Mesh;
      const firstMap = (first.material as THREE.MeshBasicMaterial).map!;
      const mapDispose = vi.spyOn(firstMap, 'dispose');

      renderer.clear(); // next frame
      renderer.drawImage(img, 10, 10, 32, 32);
      const second = renderer.scene.children[0] as THREE.Mesh;
      expect((second.material as THREE.MeshBasicMaterial).map).toBe(firstMap);
      expect(mapDispose).not.toHaveBeenCalled();

      // Mutated source: caller invalidates, next draw uploads fresh.
      renderer.invalidateImage(img);
      expect(mapDispose).toHaveBeenCalledOnce();
      renderer.clear();
      renderer.drawImage(img, 0, 0, 32, 32);
      const third = renderer.scene.children[0] as THREE.Mesh;
      expect((third.material as THREE.MeshBasicMaterial).map).not.toBe(firstMap);
    });

    it('dispose() releases cached image textures', () => {
      const img = document.createElement('canvas');
      renderer.drawImage(img, 0, 0, 16, 16);
      const map = ((renderer.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial)
        .map!;
      const mapDispose = vi.spyOn(map, 'dispose');
      renderer.dispose();
      expect(mapDispose).toHaveBeenCalledOnce();
    });

    it('evicts least-recently-used image textures past the cache limit', () => {
      (renderer as any).imageTextureCacheLimit = 2;
      const a = document.createElement('canvas');
      const b = document.createElement('canvas');
      const c = document.createElement('canvas');
      const d = document.createElement('canvas');

      renderer.drawImage(a, 0, 0, 8, 8);
      const aMap = (renderer.scene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      const aDispose = vi.spyOn(aMap.map!, 'dispose');

      renderer.drawImage(b, 0, 0, 8, 8);
      renderer.drawImage(a, 0, 0, 8, 8); // touch 'a' → most-recently-used
      renderer.drawImage(c, 0, 0, 8, 8); // over cap → evicts 'b', not 'a'

      expect(aDispose).not.toHaveBeenCalled();
      expect((renderer as any).imageTextureCache.size).toBe(2);

      renderer.drawImage(d, 0, 0, 8, 8); // evicts 'a' (now the oldest)
      expect(aDispose).toHaveBeenCalledOnce();
      expect((renderer as any).imageTextureCache.has(a)).toBe(false);
    });
  });

  describe('mirrored y-down projection: DoubleSide materials (GH-516)', () => {
    it('fillCircle mesh is double-sided', () => {
      renderer.fillCircle(50, 50, 10, '#ffffff');
      const material = (renderer.scene.children[0] as THREE.Mesh)
        .material as THREE.MeshBasicMaterial;
      expect(material.side).toBe(THREE.DoubleSide);
    });

    it('solid path fill mesh is double-sided', () => {
      renderer.beginPath();
      renderer.moveTo(0, 0);
      renderer.lineTo(20, 0);
      renderer.lineTo(20, 20);
      renderer.closePath();
      renderer.fill('#38bdf8');
      const material = (renderer.scene.children[0] as THREE.Mesh)
        .material as THREE.MeshBasicMaterial;
      expect(material.side).toBe(THREE.DoubleSide);
    });

    it('linear-gradient path fill mesh is double-sided', () => {
      const grad = renderer.createLinearGradient(0, 0, 100, 100, [
        { stop: 0, color: '#ff0000' },
        { stop: 1, color: '#0000ff' },
      ]);
      renderer.beginPath();
      renderer.moveTo(0, 0);
      renderer.lineTo(100, 0);
      renderer.lineTo(100, 100);
      renderer.closePath();
      renderer.fill(grad);
      const material = (renderer.scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
      expect(material.side).toBe(THREE.DoubleSide);
    });

    it('drawImage mesh is double-sided', () => {
      const img = document.createElement('canvas');
      renderer.drawImage(img, 0, 0, 32, 32);
      const material = (renderer.scene.children[0] as THREE.Mesh)
        .material as THREE.MeshBasicMaterial;
      expect(material.side).toBe(THREE.DoubleSide);
    });
  });

  it('disposes active objects and renderer exactly once', () => {
    const geometry = new THREE.PlaneGeometry(10, 10);
    const firstMap = new THREE.Texture();
    const secondMap = new THREE.Texture();
    const materials = [
      new THREE.MeshBasicMaterial({ map: firstMap }),
      new THREE.MeshBasicMaterial({ map: secondMap }),
    ];
    const mesh = new THREE.Mesh(geometry, materials);
    renderer.scene.add(mesh);
    (renderer as any).activeObjects.push(mesh);

    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDisposes = materials.map((material) => vi.spyOn(material, 'dispose'));
    const mapDisposes = [vi.spyOn(firstMap, 'dispose'), vi.spyOn(secondMap, 'dispose')];

    renderer.dispose();
    renderer.dispose();

    expect(renderer.scene.children).not.toContain(mesh);
    expect(geometryDispose).toHaveBeenCalledOnce();
    for (const dispose of materialDisposes) expect(dispose).toHaveBeenCalledOnce();
    for (const dispose of mapDisposes) expect(dispose).toHaveBeenCalledOnce();
    expect(renderer.renderer.dispose).toHaveBeenCalledOnce();
  });

  it('forces GL context loss on dispose so SPA cycles do not accumulate contexts', () => {
    renderer.dispose();
    renderer.dispose(); // idempotent
    expect(renderer.renderer.forceContextLoss).toHaveBeenCalledTimes(1);
  });

  it('does not dispose frame resources twice after clear then dispose', () => {
    renderer.fillCircle(10, 10, 5, '#fff');
    const mesh = renderer.scene.children[0] as THREE.Mesh;
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(mesh.material as THREE.Material, 'dispose');

    renderer.clear();
    renderer.dispose();

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(renderer.renderer.dispose).toHaveBeenCalledOnce();
  });

  describe('GPU context-loss recovery', () => {
    it('preventDefaults webglcontextlost and reports the lost state', () => {
      const event = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(renderer.isContextLost()).toBe(true);
    });

    it('skips present() while the context is lost, resumes after restore', () => {
      const render = renderer.renderer.render as ReturnType<typeof vi.fn>;

      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      render.mockClear();
      renderer.present();
      expect(render).not.toHaveBeenCalled();

      canvas.dispatchEvent(new Event('webglcontextrestored'));
      expect(renderer.isContextLost()).toBe(false);
      // Restore forces a present, and further presents work again.
      render.mockClear();
      renderer.present();
      expect(render).toHaveBeenCalled();
    });

    it('re-applies pixel ratio + size on context restore', () => {
      const setPixelRatio = renderer.renderer.setPixelRatio as ReturnType<typeof vi.fn>;
      setPixelRatio.mockClear();

      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      canvas.dispatchEvent(new Event('webglcontextrestored'));

      expect(setPixelRatio).toHaveBeenCalled();
    });

    it('detaches context listeners on dispose (no resurrection)', () => {
      renderer.dispose();
      const event = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(event);
      // Listener removed → default not prevented, state untouched.
      expect(event.defaultPrevented).toBe(false);
      expect(renderer.isContextLost()).toBe(false);
    });
  });

  describe('runtime devicePixelRatio change', () => {
    it('arms a resolution query and re-applies pixel ratio when DPR changes', () => {
      // jsdom has no matchMedia; install a controllable one, then build a fresh
      // renderer so its constructor arms the DPR watcher.
      const originalMatchMedia = (window as any).matchMedia;
      const lists: Array<{ handler: () => void }> = [];
      (window as any).matchMedia = (media: string) => ({
        media,
        matches: false,
        addEventListener: (_t: string, h: () => void) => lists.push({ handler: h }),
        removeEventListener: (_t: string, h: () => void) => {
          const i = lists.findIndex((l) => l.handler === h);
          if (i >= 0) lists.splice(i, 1);
        },
      });
      try {
        const dprCanvas = document.createElement('canvas');
        const dprRenderer = new ThreeRenderer(dprCanvas);
        expect((dprRenderer as any).dprMediaQuery).toBeTruthy();

        const setPixelRatio = dprRenderer.renderer.setPixelRatio as ReturnType<typeof vi.fn>;
        (window as any).devicePixelRatio = 2;
        setPixelRatio.mockClear();
        // Fire the armed change handler (a real DPR change).
        for (const l of lists.slice()) l.handler();

        expect(setPixelRatio).toHaveBeenCalledWith(2);
        dprRenderer.dispose();
      } finally {
        (window as any).matchMedia = originalMatchMedia;
        (window as any).devicePixelRatio = 1;
      }
    });
  });

  describe('IRenderer.pixelRatio contract and maxDPR clamping', () => {
    it('reports the backing store ratio, not a live window lookup', () => {
      renderer.renderer.setPixelRatio(2);
      expect(renderer.pixelRatio).toBe(2);
      (window as any).devicePixelRatio = 3; // must not leak into the read
      expect(renderer.pixelRatio).toBe(2);
      (window as any).devicePixelRatio = 1;
      renderer.renderer.setPixelRatio(1);
    });

    it('clamps the applied ratio to maxDPR at construction', () => {
      (window as any).devicePixelRatio = 3;
      try {
        const clamped = new ThreeRenderer(document.createElement('canvas'));
        clamped.maxDPR = 2;
        // Scene syncs maxDPR then calls resize(); replicate that handshake.
        clamped.resize(100, 100);
        expect(clamped.pixelRatio).toBe(2);
        expect(vi.mocked(clamped.renderer.setPixelRatio)).toHaveBeenLastCalledWith(2);
        clamped.dispose();
      } finally {
        (window as any).devicePixelRatio = 1;
      }
    });

    it('uses the uncapped window DPR when maxDPR is undefined', () => {
      (window as any).devicePixelRatio = 3;
      try {
        const uncapped = new ThreeRenderer(document.createElement('canvas'));
        uncapped.resize(100, 100);
        expect(uncapped.pixelRatio).toBe(3);
        uncapped.dispose();
      } finally {
        (window as any).devicePixelRatio = 1;
      }
    });

    it('keeps the clamp across a runtime DPR change (zoom past maxDPR)', () => {
      const originalMatchMedia = (window as any).matchMedia;
      const lists: Array<{ handler: () => void }> = [];
      (window as any).matchMedia = (media: string) => ({
        media,
        matches: false,
        addEventListener: (_t: string, h: () => void) => lists.push({ handler: h }),
        removeEventListener: (_t: string, h: () => void) => {
          const i = lists.findIndex((l) => l.handler === h);
          if (i >= 0) lists.splice(i, 1);
        },
      });
      try {
        (window as any).devicePixelRatio = 2;
        const clamped = new ThreeRenderer(document.createElement('canvas'));
        clamped.maxDPR = 1.5;
        clamped.resize(100, 100);

        // A zoom lands (DPR rises to 3): the re-armed watcher fires.
        (window as any).devicePixelRatio = 3;
        for (const l of lists.slice()) l.handler();

        expect(clamped.pixelRatio).toBe(1.5);
        clamped.dispose();
      } finally {
        (window as any).matchMedia = originalMatchMedia;
        (window as any).devicePixelRatio = 1;
      }
    });
  });
});
