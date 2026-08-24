import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Entity } from '../src/tree/Entity';
import { ComputeParticleEntity } from '../src/tree/ComputeParticleEntity';
import { WebGPUParticleSystemManager } from '../src/renderer/WebGPUParticleSystemManager';

class Group extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe('WebGPUParticleSystemManager', () => {
  beforeEach(() => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
  });

  it('multiplies particle color alpha by entity and ancestor opacity', () => {
    const writeBuffer = vi.fn();
    const device = {
      createShaderModule: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})),
      createBuffer: vi.fn(() => ({})),
      createBindGroup: vi.fn(() => ({})),
      queue: { writeBuffer },
    } as unknown as GPUDevice;
    const manager = new WebGPUParticleSystemManager(device);
    manager.initPipelines('rgba8unorm');
    const parent = new Group('parent');
    parent.opacity = 0.5;
    const entity = new ComputeParticleEntity({ maxParticles: 1, color: 'rgba(255, 0, 0, 0.5)' });
    entity.opacity = 0.4;
    parent.add(entity);
    manager.setupEntityResources(entity);
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
    } as unknown as GPUComputePassEncoder;

    manager.recordComputePass(pass, entity, 0.016, -9999, -9999, 800, 600);

    const uniform = writeBuffer.mock.calls.at(-1)?.[2] as Float32Array;
    expect(uniform[3]).toBeCloseTo(0.1);
  });
});

function makeRecordingDevice() {
  return {
    createShaderModule: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ destroy: vi.fn() })),
    createRenderPipeline: vi.fn(() => ({ destroy: vi.fn() })),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroup: vi.fn(() => ({})),
    queue: { writeBuffer: vi.fn() },
  } as unknown as GPUDevice & Record<string, ReturnType<typeof vi.fn>>;
}

describe('WebGPU resource lifecycle (#684)', () => {
  it('destroy() releases shader modules and pipelines, not just the JS refs', () => {
    const device = makeRecordingDevice();
    const manager = new WebGPUParticleSystemManager(device);
    manager.initPipelines('rgba8unorm');

    manager.destroy();

    for (const r of device.createShaderModule.mock.results) {
      expect(r.value.destroy).toHaveBeenCalledTimes(1);
    }
    expect(device.createComputePipeline.mock.results[0].value.destroy).toHaveBeenCalledTimes(1);
    expect(device.createRenderPipeline.mock.results[0].value.destroy).toHaveBeenCalledTimes(1);
    // Idempotent: a second destroy must not explode on nulled refs.
    expect(() => manager.destroy()).not.toThrow();
  });

  it('re-setup destroys the previous buffer generation instead of leaking it', () => {
    const device = makeRecordingDevice();
    const manager = new WebGPUParticleSystemManager(device);
    manager.initPipelines('rgba8unorm');
    const entity = new ComputeParticleEntity({ maxParticles: 4, color: 'red' });

    manager.setupEntityResources(entity);
    const firstStorage = entity.gpuStorageBuffer;
    const firstUniform = entity.gpuUniformBuffer;

    // Reconfiguring (e.g. maxParticles change) overwrites the handles.
    manager.setupEntityResources(entity);

    expect(firstStorage.destroy).toHaveBeenCalledTimes(1);
    expect(firstUniform.destroy).toHaveBeenCalledTimes(1);
    expect(entity.gpuStorageBuffer).not.toBe(firstStorage);
    expect(entity.gpuUniformBuffer).not.toBe(firstUniform);

    // Buffers created by this manager are released by manager.destroy() too
    // when their entity is gone — via the entity's own destroy path, so only
    // pipeline/module objects remain here.
    manager.destroy();
  });
});
