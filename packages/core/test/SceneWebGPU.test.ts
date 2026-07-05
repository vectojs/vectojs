// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scene, ComputeParticleEntity } from '../src';

function recorderCtx() {
  const calls: string[] = [];
  const rec = (op: string) => () => calls.push(op);
  return {
    calls,
    scale: rec('scale'),
    clearRect: rec('clearRect'),
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    arc: rec('arc'),
    fill: rec('fill'),
    fillText: rec('fillText'),
    stroke: rec('stroke'),
    lineTo: rec('lineTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    closePath: rec('closePath'),
    roundRect: rec('roundRect'),
    drawImage: rec('drawImage'),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    set globalAlpha(_v: number) {},
    set fillStyle(_v: unknown) {},
    set strokeStyle(_v: unknown) {},
    set lineWidth(_v: number) {},
    set lineCap(_v: string) {},
    set lineJoin(_v: string) {},
    set font(_v: string) {},
    canvas: null as unknown,
  };
}

describe('Scene WebGPU Orchestration & lost Recovery Integration', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;
  let mockDevice: any;
  let mockAdapter: any;
  let mockGpu: any;
  let deviceLostResolve: any;
  let deviceLostPromise: Promise<any>;

  beforeEach(() => {
    // Stub global WebGPU staging constants
    vi.stubGlobal('GPUShaderStage', {
      VERTEX: 1,
      FRAGMENT: 2,
      COMPUTE: 4,
    });
    vi.stubGlobal('GPUBufferUsage', {
      MAP_READ: 1,
      MAP_WRITE: 2,
      COPY_SRC: 4,
      COPY_DST: 8,
      INDEX: 16,
      VERTEX: 32,
      UNIFORM: 64,
      STORAGE: 128,
      INDIRECT: 256,
      QUERY_RESOLVE: 512,
    });

    // Mock requestAnimationFrame and window
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 16),
    );
    vi.stubGlobal('window', {
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    // Spy on document.createElement to inject canvas mocks
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'canvas') {
        const c = realCreateElement('canvas');
        const ctx = recorderCtx();
        ctx.canvas = c;
        c.getContext = ((type: string) => {
          if (type === '2d') return ctx;
          if (type === 'webgpu') {
            return {
              configure: vi.fn(),
              getCurrentTexture: vi.fn(() => ({
                createView: vi.fn(() => ({})),
              })),
            };
          }
          return null;
        }) as any;
        return c;
      }
      return realCreateElement(tag);
    }) as any);

    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);

    // Setup device lost promise mock
    deviceLostPromise = new Promise((resolve) => {
      deviceLostResolve = resolve;
    });

    mockDevice = {
      lost: deviceLostPromise,
      createShaderModule: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})),
      createBuffer: vi.fn(() => ({
        destroy: vi.fn(),
      })),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginComputePass: vi.fn(() => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          dispatchWorkgroups: vi.fn(),
          end: vi.fn(),
        })),
        beginRenderPass: vi.fn(() => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          draw: vi.fn(),
          end: vi.fn(),
        })),
        finish: vi.fn(),
      })),
      queue: {
        writeBuffer: vi.fn(),
        submit: vi.fn(),
      },
      destroy: vi.fn(),
    };

    mockAdapter = {
      requestDevice: vi.fn(async () => mockDevice),
    };

    mockGpu = {
      requestAdapter: vi.fn(async () => mockAdapter),
      getPreferredCanvasFormat: vi.fn(() => 'rgba8unorm'),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (scene) {
      scene.destroy();
    }
    canvas.remove();
    vi.useRealTimers();
  });

  it('should fall back to CPU rendering if WebGPU is not supported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Ensure navigator.gpu is undefined
    const originalGpu = (navigator as any).gpu;
    Object.defineProperty(navigator, 'gpu', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      scene = new Scene(canvas);
      const entity = new ComputeParticleEntity({ maxParticles: 10 });
      scene.add(entity);

      const updateCPUSpy = vi.spyOn(entity, 'updateCPU');

      // Force render
      scene.render(scene.getRenderer(), 16, 0);

      // Wait for async init / catch handler to execute
      await new Promise(process.nextTick);

      expect(updateCPUSpy).toHaveBeenCalled();
      expect((scene as any).webgpuDisabled).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        'WebGPU unavailable; using CPU particle fallback.',
        expect.any(Error),
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'gpu', {
        value: originalGpu,
        configurable: true,
        writable: true,
      });
    }
  });

  it('reports explicit WebGPU initialization failure as an error before falling back', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalGpu = (navigator as any).gpu;
    Object.defineProperty(navigator, 'gpu', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      scene = new Scene(canvas, { particleBackend: 'webgpu' });
      scene.add(new ComputeParticleEntity({ maxParticles: 1 }));

      scene.render(scene.getRenderer(), 16, 0);
      await new Promise(process.nextTick);

      expect(error).toHaveBeenCalledWith('Failed to initialize WebGPU:', expect.any(Error));
      expect((scene as any).webgpuDisabled).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'gpu', {
        value: originalGpu,
        configurable: true,
        writable: true,
      });
    }
  });

  it('should initialize WebGPU and dispatch compute/render passes if WebGPU is supported', async () => {
    const originalGpu = (navigator as any).gpu;
    Object.defineProperty(navigator, 'gpu', {
      value: mockGpu,
      configurable: true,
      writable: true,
    });

    try {
      scene = new Scene(canvas);
      const entity = new ComputeParticleEntity({ maxParticles: 10 });
      scene.add(entity);

      const updateCPUSpy = vi.spyOn(entity, 'updateCPU');

      // First render will trigger async initialization
      scene.render(scene.getRenderer(), 16, 0);

      // Wait for async init
      await new Promise(process.nextTick);

      // WebGPU should be initialized now, device and manager set up
      expect((scene as any).device).toBe(mockDevice);
      expect((scene as any).manager).toBeDefined();

      // Clear the mock history from the first frame CPU fallback
      updateCPUSpy.mockClear();

      // Second render runs the actual GPU passes
      scene.render(scene.getRenderer(), 16, 16);

      expect(updateCPUSpy).not.toHaveBeenCalled();
      expect(mockDevice.createCommandEncoder).toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'gpu', {
        value: originalGpu,
        configurable: true,
        writable: true,
      });
    }
  });

  it('passes logical scene coordinates to WebGPU compute when the canvas is CSS-scaled', async () => {
    const originalGpu = (navigator as any).gpu;
    Object.defineProperty(navigator, 'gpu', {
      value: mockGpu,
      configurable: true,
      writable: true,
    });
    canvas.width = 800;
    canvas.height = 600;
    canvas.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 400, height: 300 }) as DOMRect;

    try {
      scene = new Scene(canvas, { disableWindowResize: true });
      const entity = new ComputeParticleEntity({ maxParticles: 1 });
      scene.add(entity);
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }));

      scene.render(scene.getRenderer(), 16, 0);
      await new Promise(process.nextTick);
      const manager = (scene as any).manager;
      const recordComputePass = vi.spyOn(manager, 'recordComputePass');

      scene.render(scene.getRenderer(), 16, 16);

      expect(recordComputePass).toHaveBeenCalled();
      expect(recordComputePass.mock.calls[0][3]).toBe(400);
      expect(recordComputePass.mock.calls[0][4]).toBe(300);
    } finally {
      Object.defineProperty(navigator, 'gpu', {
        value: originalGpu,
        configurable: true,
        writable: true,
      });
    }
  });

  it('should handle device lost and trigger exponential backoff recovery loop', async () => {
    vi.useFakeTimers();

    const originalGpu = (navigator as any).gpu;
    Object.defineProperty(navigator, 'gpu', {
      value: mockGpu,
      configurable: true,
      writable: true,
    });

    try {
      scene = new Scene(canvas);
      const entity = new ComputeParticleEntity({ maxParticles: 10 });
      scene.add(entity);

      // Trigger initialization
      scene.render(scene.getRenderer(), 16, 0);
      await vi.runAllTimersAsync();

      // Resolve device lost promise
      const recreateSpy = vi.spyOn(scene as any, 'recreateWebGPUDeviceWithRetry');
      deviceLostResolve({ reason: 'other', message: 'GPU crashed' });

      // Wait for device lost handler to trigger
      await new Promise(process.nextTick);

      expect((scene as any).deviceLost).toBe(true);
      expect((scene as any).device).toBeNull();
      expect(recreateSpy).toHaveBeenCalled();

      // Check exponential backoffs:
      // Attempt 0: delay should be 1000ms
      expect((scene as any).recoveryTimerId).toBeDefined();

      // Advance by 1000ms to trigger first recovery attempt
      await vi.advanceTimersByTimeAsync(1000);

      // Wait for next tick to process async promise chain
      await new Promise(process.nextTick);

      // First retry succeeds since we resolved the init promise to the mock device again
      expect((scene as any).device).toBe(mockDevice);
      expect((scene as any).deviceLost).toBe(false);
    } finally {
      Object.defineProperty(navigator, 'gpu', {
        value: originalGpu,
        configurable: true,
        writable: true,
      });
    }
  });

  it('should disable WebGPU after 3 failed recovery attempts', async () => {
    vi.useFakeTimers();

    // Mock requestDevice to fail during recovery
    mockAdapter.requestDevice = vi.fn().mockRejectedValue(new Error('Failed to request device'));

    const originalGpu = (navigator as any).gpu;
    Object.defineProperty(navigator, 'gpu', {
      value: mockGpu,
      configurable: true,
      writable: true,
    });

    try {
      scene = new Scene(canvas);
      const entity = new ComputeParticleEntity({ maxParticles: 10 });
      scene.add(entity);

      // Trigger initialization which will fail
      scene.render(scene.getRenderer(), 16, 0);

      // Wait for first attempt (immediately fails initWebGPUContext)
      await vi.runAllTimersAsync();

      // Let's manually trigger recreateWebGPUDeviceWithRetry with attempt = 0
      (scene as any).recreateWebGPUDeviceWithRetry([entity], 0);

      // Attempt 0: backoff = 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise(process.nextTick);

      // Attempt 1: backoff = 2000ms
      await vi.advanceTimersByTimeAsync(2000);
      await new Promise(process.nextTick);

      // Attempt 2: backoff = 4000ms
      await vi.advanceTimersByTimeAsync(4000);
      await new Promise(process.nextTick);

      // Attempt 3: reached limits, should set webgpuDisabled = true
      expect((scene as any).webgpuDisabled).toBe(true);
      expect((scene as any).deviceLost).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'gpu', {
        value: originalGpu,
        configurable: true,
        writable: true,
      });
    }
  });
});
