import { ComputeParticleEntity } from '../tree/ComputeParticleEntity';
import type { Entity } from '../tree/Entity';
import { parseColorToRGBA } from './colorParse';

// Fallback definitions for GPUShaderStage and GPUBufferUsage if not present globally in standard DOM types
declare const GPUShaderStage: {
  readonly VERTEX: number;
  readonly FRAGMENT: number;
  readonly COMPUTE: number;
};

declare const GPUBufferUsage: {
  readonly MAP_READ: number;
  readonly MAP_WRITE: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly INDEX: number;
  readonly VERTEX: number;
  readonly UNIFORM: number;
  readonly STORAGE: number;
  readonly INDIRECT: number;
  readonly QUERY_RESOLVE: number;
};

const COMPUTE_SHADER = `
struct Particle {
  position: vec2<f32>,
  velocity: vec2<f32>,
  origin: vec2<f32>,
  size: f32,
  life: f32,
}

struct Params {
  base_color: vec4<f32>,
  mouse_pos: vec2<f32>,
  screen_size: vec2<f32>,
  explosion_pos: vec2<f32>,
  dt: f32,
  spring_k: f32,
  damping: f32,
  explosion_force: f32,
  bounce_damping: f32,
  max_particles: u32,
  max_velocity: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(256)
fn cs_main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let idx = global_id.x;
  if (idx >= params.max_particles) {
    return;
  }

  var p = particles[idx];
  let dt = clamp(params.dt, 0.0, 0.1);
  let safe_screen_size = max(params.screen_size, vec2<f32>(1.0, 1.0));
  
  let spring_k = clamp(params.spring_k, 0.0, 10.0);
  let damping = clamp(params.damping, 0.0, 1.0);
  let bounce_damping = clamp(params.bounce_damping, 0.0, 1.0);
  let max_velocity = max(params.max_velocity, 1.0);

  let to_origin = p.origin - p.position;
  let spring_force = to_origin * spring_k;

  var mouse_force = vec2<f32>(0.0, 0.0);
  let to_mouse = params.mouse_pos - p.position;
  let dist = length(to_mouse);
  if (dist < 120.0 && dist > 0.1) {
    let force_magnitude = (120.0 - dist) * 2.0;
    mouse_force = -normalize(to_mouse) * force_magnitude;
  }

  var expl_force = vec2<f32>(0.0, 0.0);
  if (params.explosion_force > 0.0) {
    let to_expl = params.explosion_pos - p.position;
    let expl_dist = length(to_expl);
    if (expl_dist < 150.0 && expl_dist > 0.1) {
      let f = (150.0 - expl_dist) * params.explosion_force;
      expl_force = -normalize(to_expl) * f;
    }
  }

  let accel = spring_force + mouse_force + expl_force;
  p.velocity = (p.velocity + accel * dt) * damping;

  let speed = length(p.velocity);
  if (speed > max_velocity) {
    p.velocity = normalize(p.velocity) * max_velocity;
  }

  p.position = p.position + p.velocity * dt;

  if (p.position.x <= 0.0 && p.velocity.x < 0.0) {
    p.velocity.x = -p.velocity.x * bounce_damping;
  } else if (p.position.x >= safe_screen_size.x && p.velocity.x > 0.0) {
    p.velocity.x = -p.velocity.x * bounce_damping;
  }

  if (p.position.y <= 0.0 && p.velocity.y < 0.0) {
    p.velocity.y = -p.velocity.y * bounce_damping;
  } else if (p.position.y >= safe_screen_size.y && p.velocity.y > 0.0) {
    p.velocity.y = -p.velocity.y * bounce_damping;
  }

  p.position = clamp(p.position, vec2<f32>(0.0, 0.0), safe_screen_size);

  if (p.life >= 0.0) {
    p.life = max(0.0, p.life - dt * 0.5);
  }

  particles[idx] = p;
}
`;

const RENDER_SHADER = `
struct Particle {
  position: vec2<f32>,
  velocity: vec2<f32>,
  origin: vec2<f32>,
  size: f32,
  life: f32,
}

struct Params {
  base_color: vec4<f32>,
  mouse_pos: vec2<f32>,
  screen_size: vec2<f32>,
  explosion_pos: vec2<f32>,
  dt: f32,
  spring_k: f32,
  damping: f32,
  explosion_force: f32,
  bounce_damping: f32,
  max_particles: u32,
  max_velocity: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

struct VertexOutput {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_idx: u32,
  @builtin(instance_index) instance_idx: u32
) -> VertexOutput {
  let p = particles[instance_idx];
  let uvs = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );

  let safe_screen_size = max(params.screen_size, vec2<f32>(1.0, 1.0));
  var life_scale = 1.0;
  if (p.life >= 0.0) {
    life_scale = clamp(p.life, 0.0, 1.0);
  }
  let visual_size = p.size * life_scale;
  let offset = uvs[vertex_idx] * visual_size;
  let world_pos = p.position + offset;

  let ndc_x = (world_pos.x / safe_screen_size.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (world_pos.y / safe_screen_size.y) * 2.0;

  var out: VertexOutput;
  out.pos = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
  out.uv = uvs[vertex_idx];
  out.color = vec4<f32>(params.base_color.rgb, params.base_color.a * life_scale);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(in.uv);
  if (dist > 1.0) {
    discard;
  }
  let alpha = 1.0 - smoothstep(0.85, 1.0, dist);
  return vec4<f32>(in.color.rgb, in.color.a * alpha);
}
`;

export class WebGPUParticleSystemManager {
  private device: GPUDevice;
  private computePipeline: GPUComputePipeline | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private computeBindGroupLayout: GPUBindGroupLayout | null = null;
  private renderBindGroupLayout: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  public initPipelines(format: GPUTextureFormat): void {
    const computeModule = this.device.createShaderModule({ code: COMPUTE_SHADER });
    const renderModule = this.device.createShaderModule({ code: RENDER_SHADER });

    this.computeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
      ],
    });

    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    const computePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.computeBindGroupLayout],
    });

    const renderPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.renderBindGroupLayout],
    });

    this.computePipeline = this.device.createComputePipeline({
      layout: computePipelineLayout,
      compute: { module: computeModule, entryPoint: 'cs_main' },
    });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: renderPipelineLayout,
      vertex: { module: renderModule, entryPoint: 'vs_main' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  public setupEntityResources(entity: ComputeParticleEntity): void {
    const storageSize = entity.maxParticles * 32;
    entity.gpuStorageBuffer = this.device.createBuffer({
      size: storageSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    entity.gpuUniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    entity.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: entity.gpuUniformBuffer } },
        { binding: 1, resource: { buffer: entity.gpuStorageBuffer } },
      ],
    });

    entity.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: entity.gpuUniformBuffer } },
        { binding: 1, resource: { buffer: entity.gpuStorageBuffer } },
      ],
    });
  }

  public recordComputePass(
    pass: GPUComputePassEncoder,
    entity: ComputeParticleEntity,
    dt: number,
    mouseX: number,
    mouseY: number,
    width: number,
    height: number,
  ): void {
    if (!this.computePipeline || !entity.computeBindGroup) return;

    // Update uniform values securely
    const uniformArray = new Float32Array(20);
    const color = parseColorToRGBA(entity.baseColor);
    let opacity = 1;
    for (let current: Entity | null = entity; current; current = current.parent) {
      opacity *= current.opacity;
    }
    uniformArray[0] = color[0];
    uniformArray[1] = color[1];
    uniformArray[2] = color[2];
    uniformArray[3] = color[3] * opacity;

    // Mouse coordinates (Quiet zone if NaN or inactive)
    const mActive = !isNaN(mouseX) && !isNaN(mouseY) && mouseX > -9000 && mouseY > -9000;
    uniformArray[4] = mActive ? mouseX : -9999.0;
    uniformArray[5] = mActive ? mouseY : -9999.0;

    // Screen dimensions (Capped minimum 1.0)
    uniformArray[6] = Math.max(1.0, width);
    uniformArray[7] = Math.max(1.0, height);

    // Explosion center
    if (entity.pendingExplosion) {
      uniformArray[8] = entity.pendingExplosion.x;
      uniformArray[9] = entity.pendingExplosion.y;
      uniformArray[13] = entity.pendingExplosion.force;
      entity.pendingExplosion = null; // Clear CPU transient event immediately
    } else {
      uniformArray[8] = 0.0;
      uniformArray[9] = 0.0;
      uniformArray[13] = 0.0;
    }

    // Integrate parameters
    uniformArray[10] = isNaN(dt) ? 0.016 : dt;
    uniformArray[11] = Math.max(0, Math.min(10, entity.springK));
    uniformArray[12] = Math.max(0, Math.min(1, entity.damping));
    uniformArray[14] = Math.max(0, Math.min(1, entity.bounceDamping));
    uniformArray[16] = Math.max(1.0, entity.maxVelocity);

    // Cast raw arraybuffer to write maxParticles as u32
    new Uint32Array(uniformArray.buffer)[15] = entity.maxParticles;

    this.device.queue.writeBuffer(entity.gpuUniformBuffer!, 0, uniformArray);

    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, entity.computeBindGroup);
    const workgroups = Math.ceil(entity.maxParticles / 256);
    pass.dispatchWorkgroups(workgroups);
  }

  public recordRenderPass(pass: GPURenderPassEncoder, entity: ComputeParticleEntity): void {
    if (!this.renderPipeline || !entity.renderBindGroup) return;

    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, entity.renderBindGroup);
    pass.draw(6, entity.maxParticles);
  }

  public destroy(): void {
    this.computePipeline = null;
    this.renderPipeline = null;
    this.computeBindGroupLayout = null;
    this.renderBindGroupLayout = null;
  }
}
