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
