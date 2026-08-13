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

  it('stroke() draws one Line per sub-path (no connectors across moveTo gaps)', () => {
    renderer.clear();
    renderer.beginPath();
    renderer.moveTo(0, 0);
    renderer.lineTo(10, 0);
    renderer.moveTo(50, 50); // second sub-path
    renderer.lineTo(60, 50);
    renderer.stroke('#ffffff', 1);
    const lines = renderer.scene.children.filter((o) => (o as THREE.Line).isLine);
    expect(lines).toHaveLength(2);
    // Each line has its own 2 points — nothing spans the (10,0)→(50,50) gap.
    for (const line of lines) {
      const pos = (line as THREE.Line).geometry.getAttribute('position');
      expect(pos.count).toBe(2);
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
});
