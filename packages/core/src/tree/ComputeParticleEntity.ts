import { Entity } from './Entity';
import { IRenderer } from '../renderer/IRenderer';

/**
 * Options for configuring a {@link ComputeParticleEntity}.
 */
export interface ComputeParticleOptions {
  /** Maximum number of particles to simulate. Defaults to 10000. */
  maxParticles?: number;
  /** Spring stiffness coefficient for returning to origin. Defaults to 0.05. */
  springK?: number;
  /** Velocity damping factor in `[0, 1]`. Defaults to 0.95. */
  damping?: number;
  /** Bounce damping factor for boundary collisions in `[0, 1]`. Defaults to 0.5. */
  bounceDamping?: number;
  /** Speed limit for particles. Defaults to 500.0. */
  maxVelocity?: number;
  /** Base particle size in pixels. Defaults to 4. */
  size?: number;
  /** CSS color string for the particles. Defaults to '#00f0ff'. */
  color?: string;
  /** Whether the particle layer captures pointer/hit events. Defaults to false. */
  pointerEvents?: boolean;
}

/**
 * An entity representing a high-performance WebGPU/CPU particle simulation layer.
 *
 * Each particle consists of 8 floats in `particleData`:
 * - 0: position.x
 * - 1: position.y
 * - 2: velocity.x
 * - 3: velocity.y
 * - 4: origin.x
 * - 5: origin.y
 * - 6: size
 * - 7: life (remaining lifetime, -1.0 for perpetual particles)
 */
export class ComputeParticleEntity extends Entity {
  public maxParticles: number;
  public springK: number;
  public damping: number;
  public bounceDamping: number;
  public maxVelocity: number;
  public size: number;
  public baseColor: string;
  public pointerEvents: boolean;

  /** Flat array containing layout of all particles: position, velocity, origin, size, life. */
  public particleData: Float32Array;
  /** Flag indicating whether the particle coordinates need to be initialized. */
  public needsInit: boolean = true;
  /** Active explosion impulse to apply in the next simulation step. */
  public pendingExplosion: { x: number; y: number; force: number } | null = null;

  /** WebGPU storage buffer containing particle states. */
  public gpuStorageBuffer: any = null;
  /** WebGPU uniform buffer containing simulation parameters. */
  public gpuUniformBuffer: any = null;
  /** WebGPU bind group for the compute shader pass. */
  public computeBindGroup: any = null;
  /** WebGPU bind group for the render pass (usually same as compute). */
  public renderBindGroup: any = null;

  constructor(options: ComputeParticleOptions = {}) {
    super();
    this.maxParticles = options.maxParticles ?? 10000;
    this.springK = options.springK ?? 0.05;
    this.damping = options.damping ?? 0.95;
    this.bounceDamping = options.bounceDamping ?? 0.5;
    this.maxVelocity = options.maxVelocity ?? 500.0;
    this.size = options.size ?? 4;
    this.baseColor = options.color ?? '#00f0ff';
    this.pointerEvents = options.pointerEvents ?? false;

    this.particleData = new Float32Array(this.maxParticles * 8);
    this.interactive = true;
  }

  /**
   * Disperses all particles randomly across the specified screen bounds.
   * Sets initial positions, velocities, origins, and sizes.
   *
   * @param width - Simulation zone width.
   * @param height - Simulation zone height.
   */
  public initRandomParticles(width: number, height: number): void {
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);
    for (let i = 0; i < this.maxParticles; i++) {
      const idx = i * 8;
      const x = Math.random() * safeW;
      const y = Math.random() * safeH;
      this.particleData[idx] = x;
      this.particleData[idx + 1] = y;
      this.particleData[idx + 2] = 0; // vx
      this.particleData[idx + 3] = 0; // vy
      this.particleData[idx + 4] = x; // ox
      this.particleData[idx + 5] = y; // oy
      this.particleData[idx + 6] = this.size;
      this.particleData[idx + 7] = -1.0; // perpetual
    }
    this.needsInit = false;
  }

  /**
   * Triggers an explosion force center.
   *
   * @param x - Explosion center x-coordinate.
   * @param y - Explosion center y-coordinate.
   * @param force - Magnitude force scalar.
   */
  public triggerExplosion(x: number, y: number, force: number): void {
    this.pendingExplosion = { x, y, force };
  }

  public override isPointInside(x: number, y: number): boolean {
    return this.pointerEvents;
  }

  public override render(r: IRenderer): void {
    // Canvas2D / WebGL Fallback pipeline handled inside scene
  }

  public override destroy(): void {
    this.destroyGPUResources();
    super.destroy();
  }

  /**
   * Frees all GPU resources allocated for WebGPU simulation.
   */
  public destroyGPUResources(): void {
    if (this.gpuStorageBuffer) {
      if (typeof this.gpuStorageBuffer.destroy === 'function') {
        this.gpuStorageBuffer.destroy();
      }
      this.gpuStorageBuffer = null;
    }
    if (this.gpuUniformBuffer) {
      if (typeof this.gpuUniformBuffer.destroy === 'function') {
        this.gpuUniformBuffer.destroy();
      }
      this.gpuUniformBuffer = null;
    }
    this.computeBindGroup = null;
    this.renderBindGroup = null;
  }
}
