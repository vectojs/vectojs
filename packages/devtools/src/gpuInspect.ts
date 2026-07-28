import type { DrawCounters, Entity, Scene } from '@vectojs/core';
import type {
  PluginAudit,
  PluginCommand,
  PluginFinding,
  PluginInspector,
  PluginRow,
} from './plugin';

/**
 * Per-backend rendering counters.
 *
 * Three separate sources, because the backends are not one interface: Canvas2D
 * and SVG are `IRenderer` implementations, while the WebGL point layer and the
 * WebGPU particle manager are stacked surfaces the Scene drives directly. A
 * single `IRenderer`-level shim would report Canvas2D and miss both GPU paths.
 */
export interface GpuInspection {
  /** The `IRenderer` backend in use, from its `kind` discriminator. */
  rendererKind: string;
  /** Canvas2D draw counters, or null when counting is off or unsupported. */
  canvas: DrawCounters | null;
  /** WebGL point-layer accounting, or null when that layer is not running. */
  webgl: {
    drawCalls: number;
    totalDrawCalls: number;
    atlasSwitches: number;
    programs: number;
    textures: number;
    circleQuadFallbacks: number;
    circlePoints: number;
  } | null;
  /** WebGPU state. Absent activity and zero activity are reported differently. */
  webgpu: {
    active: boolean;
    /**
     * Pipelines created, a fixed pair (one compute, one render) built once.
     * Reported as a capability, not a counter.
     */
    pipelines: number;
    /** Bind groups, two per compute-particle entity. */
    bindGroups: number;
    /** Compute-particle entities driving the WebGPU path. */
    particleEntities: number;
  };
  /** Render phase timings, when `Scene.setPhaseTiming(true)` is on. */
  phases: Array<{
    phase: string;
    totalMs: number;
    calls: number;
    avgMs: number;
    maxMs: number;
  }>;
  /** Frame telemetry, always available. */
  frame: {
    fps: number;
    frameTimeMs: number;
    renderedFrames: number;
    skippedFrames: number;
  };
  /** Capabilities that cannot be reported here, each with the reason. */
  unavailable: Array<{ capability: string; reason: string }>;
}

/** How many bind groups the WebGPU particle path allocates per entity. */
const BIND_GROUPS_PER_ENTITY = 2;
/** Compute + render, created once. */
const WEBGPU_PIPELINES = 2;

/**
 * Count entities that drive the WebGPU particle path.
 *
 * Identified by shape rather than constructor name, which minifies away. A
 * compute-particle entity is the only thing carrying `maxParticles`.
 */
function countParticleEntities(scene: Scene): number {
  let count = 0;
  const walk = (entity: Entity): void => {
    if (typeof (entity as unknown as { maxParticles?: unknown }).maxParticles === 'number') {
      count++;
    }
    for (const child of entity.children) walk(child);
  };
  walk(scene.rootEntity);
  return count;
}

/**
 * Read every rendering counter available for this scene.
 *
 * Nothing here is enabled as a side effect of reading: Canvas2D counting and
 * phase timing are both opt-in, and a readout that silently switched them on
 * would change the cost of the frame it is measuring.
 */
export function inspectGpu(scene: Scene): GpuInspection {
  const renderer = scene.getRenderer() as {
    kind?: string;
    getDrawCounters?: () => DrawCounters | null;
  };
  const unavailable: Array<{ capability: string; reason: string }> = [];

  const canvas = renderer.getDrawCounters ? (renderer.getDrawCounters() ?? null) : null;
  if (!renderer.getDrawCounters) {
    unavailable.push({
      capability: 'draw counters',
      reason: `the ${renderer.kind ?? 'active'} backend does not implement getDrawCounters`,
    });
  } else if (!canvas) {
    unavailable.push({
      capability: 'draw counters',
      reason: 'counting is off; enable with setDrawCounters(true)',
    });
  }

  const webgl = scene.webglDrawStats ?? null;
  const particleEntities = countParticleEntities(scene);
  const phases = scene.phaseTiming
    ? scene.renderPhases.map((p) => ({
        phase: String(p.phase),
        totalMs: round(p.totalMs),
        calls: p.calls,
        avgMs: round(p.avgMs),
        maxMs: round(p.maxMs),
      }))
    : [];
  if (!scene.phaseTiming) {
    unavailable.push({
      capability: 'phase timings',
      reason: 'phase timing is off; enable with setPhaseTiming(true)',
    });
  }

  unavailable.push({
    capability: 'GPU timestamp queries',
    reason:
      'no query sets exist and the device is requested without the timestamp-query feature; GPU timings would also arrive out-of-band, needing their own buffered surface',
  });
  unavailable.push({
    capability: 'exact overdraw',
    reason:
      'Canvas2D has no pixel-coverage readback; overdrawRatio is submitted-area over surface-area and overstates',
  });
  unavailable.push({
    capability: 'deep WebGL frame capture',
    reason: 'use Spector.js against the canvas; it is not vendored here',
  });

  const frameStats = scene.frameStats;
  return {
    rendererKind: renderer.kind ?? 'unknown',
    canvas,
    webgl,
    webgpu: {
      active: scene.webgpuActive,
      pipelines: scene.webgpuActive ? WEBGPU_PIPELINES : 0,
      bindGroups: scene.webgpuActive ? particleEntities * BIND_GROUPS_PER_ENTITY : 0,
      particleEntities,
    },
    phases,
    frame: {
      fps: round(frameStats.fps),
      frameTimeMs: round(frameStats.frameTimeMs),
      renderedFrames: frameStats.renderedFrames,
      skippedFrames: frameStats.skippedFrames,
    },
    unavailable,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Render a GPU inspection as readout rows. */
export function formatGpuInspection(info: GpuInspection): PluginRow[] {
  const rows: PluginRow[] = [
    { label: 'backend', value: info.rendererKind },
    {
      label: 'frame',
      value: `${info.frame.fps.toFixed(0)} fps  ${info.frame.frameTimeMs.toFixed(1)}ms`,
      note: `${info.frame.renderedFrames} drawn / ${info.frame.skippedFrames} skipped`,
    },
  ];

  if (info.canvas) {
    const c = info.canvas;
    rows.push({
      label: 'fills',
      value: String(c.fills),
      note: `${c.strokes} strokes`,
    });
    rows.push({
      label: 'text',
      value: String(c.texts),
      note: `${c.images} images`,
    });
    rows.push({
      label: 'circles',
      value: String(c.circles),
      note: `${c.flushes} batch commits`,
    });
    rows.push({
      label: 'save/restore',
      value: `${c.saves}/${c.restores}`,
      note: `${c.clips} clips`,
    });
    rows.push({ label: 'state switches', value: String(c.stateSwitches) });
    rows.push({
      label: 'overdraw',
      value: `${c.overdrawRatio}x`,
      note: 'proxy, overstates',
    });
  }

  if (info.webgl) {
    const w = info.webgl;
    rows.push({
      label: 'gl draws',
      value: `${w.drawCalls} last frame`,
      note: `${w.totalDrawCalls} total`,
    });
    rows.push({
      label: 'gl circles',
      value: `${w.circlePoints} points / ${w.circleQuadFallbacks} quads`,
      note: w.circleQuadFallbacks > w.circlePoints ? 'mostly on the slow path' : undefined,
    });
    rows.push({
      label: 'gl resources',
      value: `${w.programs} programs, ${w.textures} textures`,
      note: w.atlasSwitches > 0 ? `${w.atlasSwitches} atlas switches` : undefined,
    });
  } else {
    rows.push({ label: 'webgl', value: 'not running' });
  }

  rows.push({
    label: 'webgpu',
    value: info.webgpu.active ? 'active' : 'inactive',
    note: info.webgpu.active
      ? `${info.webgpu.pipelines} pipelines, ${info.webgpu.bindGroups} bind groups`
      : `${info.webgpu.particleEntities} particle entities`,
  });

  for (const phase of info.phases.slice(0, 6)) {
    rows.push({
      label: phase.phase,
      value: `${phase.avgMs}ms avg`,
      note: `max ${phase.maxMs} over ${phase.calls}`,
    });
  }

  for (const item of info.unavailable) {
    rows.push({ label: `no ${item.capability}`, value: item.reason });
  }
  return rows;
}

/**
 * Above this ratio, the batch is not amortising anything.
 *
 * One flush per circle means every circle paid a full path commit, which is the
 * shape the batch exists to avoid.
 */
const FLUSH_PER_CIRCLE_LIMIT = 0.5;
/** Overdraw proxy above which the same pixels are being painted many times. */
const OVERDRAW_LIMIT = 4;

/** Audit rendering counters for shapes that indicate wasted work. */
export function auditGpu(scene: Scene): PluginFinding[] {
  const info = inspectGpu(scene);
  const findings: PluginFinding[] = [];

  if (info.canvas) {
    const c = info.canvas;
    if (c.circles > 20 && c.flushes / c.circles > FLUSH_PER_CIRCLE_LIMIT) {
      findings.push({
        kind: 'batch-not-amortising',
        severity: 'warn',
        message: `${c.flushes} batch commits for ${c.circles} circles: the circle batch is being broken up, usually by alternating colours or interleaved non-circle draws`,
      });
    }
    if (c.overdrawRatio > OVERDRAW_LIMIT) {
      findings.push({
        kind: 'high-overdraw',
        severity: 'info',
        message: `submitted area is ${c.overdrawRatio}x the surface. This is a proxy that ignores clipping and off-screen rejection, so treat it as a trend, not a measurement`,
      });
    }
    if (c.saves !== c.restores) {
      findings.push({
        kind: 'unbalanced-save-restore',
        severity: 'warn',
        message: `${c.saves} saves against ${c.restores} restores; an unmatched save leaks transform state into later draws`,
      });
    }
  }

  if (info.webgl && info.webgl.circleQuadFallbacks > info.webgl.circlePoints) {
    findings.push({
      kind: 'circle-quad-fallback',
      severity: 'info',
      message: `${info.webgl.circleQuadFallbacks} circles took the quad path vs ${info.webgl.circlePoints} on gl.POINTS, so most cost four vertices instead of one — usually circles near the viewport edge or larger than the driver's point-size cap`,
    });
  }

  return findings;
}

/** The GPU inspector, as a plugin inspector. Applies to the scene, not a selection. */
export const gpuInspector: PluginInspector = {
  id: 'gpu',
  label: 'GPU',
  // Scene-wide, so it applies regardless of what is selected.
  rows: ({ scene }) => formatGpuInspection(inspectGpu(scene)),
};

/** The GPU audit, as a plugin audit. */
export const gpuAudit: PluginAudit = {
  id: 'render',
  run: ({ scene }) => auditGpu(scene),
};

/** Turn Canvas2D draw counting on. Off by default; a counter costs a test per op. */
export const enableDrawCountersCommand: PluginCommand = {
  id: 'enable-draw-counters',
  label: 'Enable draw counters',
  run: ({ scene }) => {
    const renderer = scene.getRenderer() as {
      setDrawCounters?: (on: boolean) => void;
    };
    if (!renderer.setDrawCounters) return 'this backend cannot count draws';
    renderer.setDrawCounters(true);
    return 'draw counting enabled';
  },
};

/** Zero the Canvas2D totals, so the next window is measured on its own. */
export const resetDrawCountersCommand: PluginCommand = {
  id: 'reset-draw-counters',
  label: 'Reset draw counters',
  run: ({ scene }) => {
    const renderer = scene.getRenderer() as { clearDrawCounters?: () => void };
    if (!renderer.clearDrawCounters) return 'this backend cannot count draws';
    renderer.clearDrawCounters();
    return 'draw counters reset';
  },
};

/** Turn render-phase timing on, which the inspector reports when available. */
export const enablePhaseTimingCommand: PluginCommand = {
  id: 'enable-phase-timing',
  label: 'Enable phase timing',
  run: ({ scene }) => {
    scene.setPhaseTiming(true);
    return 'phase timing enabled';
  },
};
