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
    setSize = vi.fn();
    setPixelRatio = vi.fn();
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
});
