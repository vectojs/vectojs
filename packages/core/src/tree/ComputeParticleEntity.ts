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

  public override isPointInside(_x: number, _y: number): boolean {
    return this.pointerEvents;
  }

  public override render(_r: IRenderer): void {
    // Canvas2D / WebGL Fallback pipeline handled inside scene
  }

  /**
   * Updates particle simulation on the CPU.
   * Handles spring forces, mouse repulsion, explosion impulses, velocity capping, and bounds bouncing/clamping.
   *
   * @param dt - Delta time in seconds.
   * @param mouseX - Mouse x-coordinate, or a value below -9000 if inactive.
   * @param mouseY - Mouse y-coordinate, or a value below -9000 if inactive.
   * @param width - Boundary width.
   * @param height - Boundary height.
   */
  public updateCPU(
    dt: number,
    mouseX: number,
    mouseY: number,
    width: number,
    height: number,
  ): void {
    const safeDt = isNaN(dt) ? 0.016 : Math.max(0.0, Math.min(dt, 0.1));
    const explosion = this.pendingExplosion;
    const safeWidth = Math.max(1.0, width);
    const safeHeight = Math.max(1.0, height);

    const springK = Math.max(0.0, Math.min(1.0, this.springK));
    const damping = Math.max(0.0, Math.min(1.0, this.damping));
    const bounceDamping = Math.max(0.0, Math.min(1.0, this.bounceDamping));
    const maxVelocity = Math.max(1.0, this.maxVelocity);

    for (let i = 0; i < this.maxParticles; i++) {
      const offset = i * 8;
      let px = this.particleData[offset];
      let py = this.particleData[offset + 1];
      let vx = this.particleData[offset + 2];
      let vy = this.particleData[offset + 3];
      const ox = this.particleData[offset + 4];
      const oy = this.particleData[offset + 5];
      const life = this.particleData[offset + 7];

      // NaN protection
      if (isNaN(px)) px = ox;
      if (isNaN(py)) py = oy;
      if (isNaN(vx)) vx = 0.0;
      if (isNaN(vy)) vy = 0.0;

      // 1. Spring force
      const fx_spring = (ox - px) * springK;
      const fy_spring = (oy - py) * springK;

      // 2. Mouse Repulsion
      let fx_mouse = 0;
      let fy_mouse = 0;
      if (!isNaN(mouseX) && !isNaN(mouseY) && mouseX > -9000 && mouseY > -9000) {
        const dx = mouseX - px;
        const dy = mouseY - py;
        const dist = Math.hypot(dx, dy);
        if (dist < 120 && dist > 0.1) {
          const forceMag = (120 - dist) * 2.0;
          fx_mouse = -(dx / dist) * forceMag;
          fy_mouse = -(dy / dist) * forceMag;
        }
      }

      // 3. Explosion Force
      let fx_expl = 0;
      let fy_expl = 0;
      if (explosion) {
        const ex = explosion.x - px;
        const ey = explosion.y - py;
        const edist = Math.hypot(ex, ey);
        if (edist < 150 && edist > 0.1) {
          const forceMag = (150 - edist) * explosion.force;
          fx_expl = -(ex / edist) * forceMag;
          fy_expl = -(ey / edist) * forceMag;
        }
      }

      // 4. Integrate acceleration
      const ax = fx_spring + fx_mouse + fx_expl;
      const ay = fy_spring + fy_mouse + fy_expl;

      let nvx = (vx + ax * safeDt) * damping;
      let nvy = (vy + ay * safeDt) * damping;

      const speed = Math.hypot(nvx, nvy);
      if (speed > maxVelocity) {
        nvx = (nvx / speed) * maxVelocity;
        nvy = (nvy / speed) * maxVelocity;
      }

      let npx = px + nvx * safeDt;
      let npy = py + nvy * safeDt;

      // 5. Boundary Bounce (Elastic collision)
      if (npx <= 0 && nvx < 0) {
        nvx = -nvx * bounceDamping;
      } else if (npx >= safeWidth && nvx > 0) {
        nvx = -nvx * bounceDamping;
      }

      if (npy <= 0 && nvy < 0) {
        nvy = -nvy * bounceDamping;
      } else if (npy >= safeHeight && nvy > 0) {
        nvy = -nvy * bounceDamping;
      }

      npx = Math.max(0, Math.min(safeWidth, npx));
      npy = Math.max(0, Math.min(safeHeight, npy));

      // 6. Life decay
      let nlife = life;
      if (life >= 0.0) {
        nlife = Math.max(0.0, life - safeDt * 0.5);
      }

      this.particleData[offset] = npx;
      this.particleData[offset + 1] = npy;
      this.particleData[offset + 2] = nvx;
      this.particleData[offset + 3] = nvy;
      this.particleData[offset + 7] = nlife;
    }

    this.pendingExplosion = null;
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
