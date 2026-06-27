// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreeRenderer } from '../src/ThreeRenderer';
import * as THREE from 'three';

// Mock WebGLRenderer to prevent crashing in headless jsdom environment
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class MockWebGLRenderer {
    domElement = document.createElement('canvas');
    constructor(options: any = {}) {
      if (options.canvas) {
        this.domElement = options.canvas;
      }
    }
    setSize = vi.fn();
    setPixelRatio = vi.fn();
    clear = vi.fn();
    render = vi.fn();
    setScissor = vi.fn();
    setScissorTest = vi.fn();
    getScissor = vi.fn((v: any) => v.set(0, 0, 0, 0));
    getScissorTest = vi.fn(() => false);
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
});
