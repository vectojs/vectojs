// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CanvasRenderer, Entity, Scene } from '@vectojs/core';
import { auditGpu, formatGpuInspection, inspectGpu } from '../src/gpuInspect';

class Box extends Entity {
  constructor(id: string, w = 40, h = 20) {
    super(id);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

/** Shaped like a ComputeParticleEntity, which is what the GPU path keys on. */
class Particles extends Box {
  public maxParticles = 1000;
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return new Scene(canvas, { disableWindowResize: true });
}

function renderer(scene: Scene): CanvasRenderer {
  return scene.getRenderer() as CanvasRenderer;
}

describe('CanvasRenderer draw counters', () => {
  it('reports null until counting is enabled', () => {
    const scene = makeScene();
    expect(renderer(scene).getDrawCounters()).toBeNull();
    scene.destroy();
  });

  it('counts fills, strokes, text and images', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);

    r.beginPath();
    r.fill('#fff');
    r.beginPath();
    r.stroke('#000', 2);
    r.fillText('hi', 0, 0, '12px monospace', '#fff');

    const c = r.getDrawCounters()!;
    expect(c.fills).toBe(1);
    expect(c.strokes).toBe(1);
    expect(c.texts).toBe(1);
    scene.destroy();
  });

  it('counts save/restore and clips', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);
    r.save();
    r.clip(0, 0, 10, 10);
    r.restore();

    const c = r.getDrawCounters()!;
    expect(c.saves).toBe(1);
    expect(c.restores).toBe(1);
    expect(c.clips).toBe(1);
    scene.destroy();
  });

  it('counts only style switches that were not elided', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);

    r.beginPath();
    r.fill('#aaa');
    r.beginPath();
    r.fill('#aaa'); // same colour: elided, so it must not count
    r.beginPath();
    r.fill('#bbb'); // a real switch

    const c = r.getDrawCounters()!;
    expect(c.fills).toBe(3);
    expect(c.stateSwitches).toBe(2);
    scene.destroy();
  });

  it('counts circles separately from the fills they batch into', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);

    for (let i = 0; i < 10; i++) r.fillCircle(i * 5, 5, 2, '#fff');
    r.flush();

    const c = r.getDrawCounters()!;
    // Ten circles, one batch commit: exactly the amortisation the batch exists
    // for, and it is only visible because the two are counted separately.
    expect(c.circles).toBe(10);
    expect(c.flushes).toBe(1);
    scene.destroy();
  });

  it('derives overdrawRatio against the current surface area', () => {
    const scene = makeScene();
    scene.resize(100, 100);
    const r = renderer(scene);
    r.setDrawCounters(true);

    // A circle of radius 50 is pi*2500 ~= 7854 over a 10000px surface.
    r.fillCircle(50, 50, 50, '#fff');
    const c = r.getDrawCounters()!;
    expect(c.overdrawRatio).toBeGreaterThan(0.7);
    expect(c.overdrawRatio).toBeLessThan(0.9);
    scene.destroy();
  });

  it('clearDrawCounters zeroes totals but keeps counting on', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);
    r.beginPath();
    r.fill('#fff');
    r.clearDrawCounters();
    expect(r.getDrawCounters()!.fills).toBe(0);

    r.beginPath();
    r.fill('#fff');
    expect(r.getDrawCounters()!.fills).toBe(1);
    scene.destroy();
  });

  it('setDrawCounters(false) discards the counters entirely', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);
    r.beginPath();
    r.fill('#fff');
    r.setDrawCounters(false);
    expect(r.getDrawCounters()).toBeNull();
    scene.destroy();
  });

  it('exposes a stable kind discriminator', () => {
    const scene = makeScene();
    // Not constructor.name, which minifies to something unusable in production.
    expect(renderer(scene).kind).toBe('canvas2d');
    scene.destroy();
  });
});

describe('inspectGpu', () => {
  it('names the backend and reports frame telemetry', () => {
    const scene = makeScene();
    const info = inspectGpu(scene);
    expect(info.rendererKind).toBe('canvas2d');
    expect(info.frame.renderedFrames).toBeGreaterThanOrEqual(0);
    scene.destroy();
  });

  it('says counting is off rather than reporting zeros', () => {
    const scene = makeScene();
    const info = inspectGpu(scene);
    expect(info.canvas).toBeNull();
    expect(info.unavailable.map((u) => u.capability)).toContain('draw counters');
    scene.destroy();
  });

  it('reports counters once enabled', () => {
    const scene = makeScene();
    renderer(scene).setDrawCounters(true);
    renderer(scene).beginPath();
    renderer(scene).fill('#fff');

    const info = inspectGpu(scene);
    expect(info.canvas?.fills).toBe(1);
    expect(info.unavailable.map((u) => u.capability)).not.toContain('draw counters');
    scene.destroy();
  });

  it('does not enable anything as a side effect of reading', () => {
    const scene = makeScene();
    inspectGpu(scene);
    // Reading must not change the cost of the frame being measured.
    expect(renderer(scene).getDrawCounters()).toBeNull();
    expect(scene.phaseTiming).toBe(false);
    scene.destroy();
  });

  it('reports webgl as not running when the layer is absent', () => {
    const scene = makeScene();
    expect(inspectGpu(scene).webgl).toBeNull();
    scene.destroy();
  });

  it('distinguishes an inactive WebGPU backend from zero work', () => {
    const scene = makeScene();
    const info = inspectGpu(scene);
    expect(info.webgpu.active).toBe(false);
    // Inactive means zero pipelines reported, not "2 pipelines that did nothing".
    expect(info.webgpu.pipelines).toBe(0);
    expect(info.webgpu.particleEntities).toBe(0);
    scene.destroy();
  });

  it('counts compute-particle entities by shape, not constructor name', () => {
    const scene = makeScene();
    scene.add(new Particles('p1'));
    const nested = new Box('wrap');
    nested.add(new Particles('p2'));
    scene.add(nested);

    expect(inspectGpu(scene).webgpu.particleEntities).toBe(2);
    scene.destroy();
  });

  it('includes phase timings only when phase timing is on', () => {
    const scene = makeScene();
    expect(inspectGpu(scene).phases).toEqual([]);
    expect(inspectGpu(scene).unavailable.map((u) => u.capability)).toContain('phase timings');

    scene.setPhaseTiming(true);
    scene.step(16);
    const info = inspectGpu(scene);
    expect(info.phases.length).toBeGreaterThan(0);
    expect(info.unavailable.map((u) => u.capability)).not.toContain('phase timings');
    scene.destroy();
  });

  it('names timestamp queries, exact overdraw and frame capture as unavailable', () => {
    const scene = makeScene();
    const caps = inspectGpu(scene).unavailable.map((u) => u.capability);
    expect(caps).toContain('GPU timestamp queries');
    expect(caps).toContain('exact overdraw');
    expect(caps).toContain('deep WebGL frame capture');
    scene.destroy();
  });
});

describe('formatGpuInspection', () => {
  it('renders the backend, frame line and webgpu state', () => {
    const scene = makeScene();
    const rows = formatGpuInspection(inspectGpu(scene));
    const text = rows.map((r) => `${r.label}|${r.value}`).join('\n');
    expect(text).toContain('backend|canvas2d');
    expect(text).toContain('webgl|not running');
    expect(text).toContain('webgpu|inactive');
    scene.destroy();
  });

  it('labels the overdraw figure as a proxy', () => {
    const scene = makeScene();
    renderer(scene).setDrawCounters(true);
    const row = formatGpuInspection(inspectGpu(scene)).find((r) => r.label === 'overdraw');
    expect(row?.note).toContain('overstates');
    scene.destroy();
  });
});

describe('auditGpu', () => {
  it('is quiet when counting is off', () => {
    const scene = makeScene();
    expect(auditGpu(scene)).toEqual([]);
    scene.destroy();
  });

  it('is quiet for a well-amortised batch', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);
    for (let i = 0; i < 40; i++) r.fillCircle(i, 5, 2, '#fff');
    r.flush();
    expect(auditGpu(scene).map((f) => f.kind)).not.toContain('batch-not-amortising');
    scene.destroy();
  });

  it('flags a batch broken up by alternating colours', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);
    // Alternating colours force a flush per circle: the batch buys nothing.
    for (let i = 0; i < 40; i++) r.fillCircle(i, 5, 2, i % 2 ? '#fff' : '#000');
    r.flush();

    const finding = auditGpu(scene).find((f) => f.kind === 'batch-not-amortising');
    expect(finding?.severity).toBe('warn');
    expect(finding?.message).toContain('circles');
    scene.destroy();
  });

  it('flags unbalanced save/restore', () => {
    const scene = makeScene();
    const r = renderer(scene);
    r.setDrawCounters(true);
    r.save();
    r.save();
    r.restore();

    const finding = auditGpu(scene).find((f) => f.kind === 'unbalanced-save-restore');
    expect(finding?.message).toContain('2 saves against 1 restores');
    scene.destroy();
  });

  it('flags high overdraw as info, not a warning', () => {
    const scene = makeScene();
    scene.resize(50, 50);
    const r = renderer(scene);
    r.setDrawCounters(true);
    // Many large circles over a small surface.
    for (let i = 0; i < 20; i++) r.fillCircle(25, 25, 25, '#fff');

    const finding = auditGpu(scene).find((f) => f.kind === 'high-overdraw');
    // Info rather than warn: it is a proxy, so it cannot justify a warning.
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('proxy');
    scene.destroy();
  });
});
