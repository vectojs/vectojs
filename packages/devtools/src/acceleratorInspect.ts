/**
 * Report which invisible accelerators actually ran, and why the others did not.
 *
 * VectoJS ships four optional accelerators — WASM world-transform composition,
 * batched property drivers, the hit-test broad phase, and particle simulation
 * (WebGPU compute or a WASM CPU kernel). Each is designed to be invisible: the
 * JS path is the permanent fallback, so nothing breaks when one declines.
 *
 * That invisibility is exactly what makes them hard to reason about. The Scene's
 * older per-accelerator getters report only that a backend is INSTALLED, so
 * reading `'wasm'` and concluding the accelerator is doing work is wrong whenever
 * a gate never opens, a kernel rejects its arguments, or a faster backend takes
 * the pass instead. A scene can hold four WASM backends and run every frame
 * entirely in JS.
 *
 * This turns `Scene.accelerators` into a verdict: what ran, what did not, and
 * which of those declines is a tuning outcome versus a fault worth chasing.
 *
 * Headless on purpose — usable from Vitest, Playwright, CI, or an agent, with no
 * panel and no `@vectojs/ui` dependency.
 */
import type { AcceleratorReason, Scene } from '@vectojs/core';

import type { PluginAudit, PluginFinding, PluginInspector, PluginRow } from './plugin';

/** One accelerator's verdict, flattened for reporting. */
export interface AcceleratorFinding {
  /** Which accelerator: `transform`, `animation`, `hitTest`, or `particle`. */
  accelerator: string;
  /** A backend is installed and could run. */
  available: boolean;
  /** It ran on the most recent frame (or, for hit-test, the most recent build). */
  activeThisFrame: boolean;
  /** Machine-readable reason code, straight from the Scene. */
  reason: AcceleratorReason;
  /** Which implementation did the work. */
  path: string;
  /**
   * True when the reason indicates a FAULT rather than a design decision.
   * `'rejected'` is the only such state: the accelerator was installed, gated in,
   * and then refused its own arguments, which means something upstream sized or
   * built the call wrong.
   */
  faulted: boolean;
  /** Why, in a sentence, with what to do about it. */
  explanation: string;
}

export interface AcceleratorInspection {
  /** Every accelerator, in a stable order. */
  accelerators: AcceleratorFinding[];
  /** How many ran. */
  activeCount: number;
  /** How many are installed. */
  availableCount: number;
  /** Accelerators whose reason is a fault, not a tuning outcome. */
  faulted: AcceleratorFinding[];
  /** One-line human-readable verdict. */
  summary: string;
}

/** Per-reason explanation, phrased as "what happened, and what to do". */
function explain(accelerator: string, reason: AcceleratorReason, path: string): string {
  switch (reason) {
    case 'active':
      return `running on ${path}`;
    case 'not-installed':
      return `no backend installed; running the JS fallback. Enable it with the matching enableWasm* call on the Scene`;
    case 'below-gate':
      return `installed but the workload is below its measured break-even, so the JS path is genuinely faster this frame. Working as designed — not a fault`;
    case 'rejected':
      return `installed and gated in, but the kernel refused its arguments and wrote nothing, so this frame fell back to JS. This is a fault: check the count against the capacity the backend was sized for`;
    case 'springs-rejected':
      return `installed and gated in, but the spring kernel refused this frame's call, so springs fell back to JS while tweens still stepped through the kernel. Partial acceleration; a persistent pattern is a fault: check the spring count against the capacity the backend was sized for`;
    case 'tweens-rejected':
      return `installed and gated in, but the tween kernel refused this frame's call, so tweens fell back to JS while springs still stepped through the kernel. Partial acceleration; a persistent pattern is a fault: check the tween count against the capacity the backend was sized for`;
    case 'not-applicable':
      return `nothing for it to do this frame${
        accelerator === 'hitTest' ? ' (the grid is built lazily, on a pointer query)' : ''
      }`;
    default:
      return `unrecognized reason`;
  }
}

/**
 * Read every accelerator's per-frame verdict off the Scene.
 *
 * Cheap and side-effect free: the Scene records these during its own frame, so
 * this only reads them back. Safe to call every frame from a panel.
 */
export function inspectAccelerators(scene: Scene): AcceleratorInspection {
  const report = scene.accelerators;
  const order: Array<keyof typeof report> = ['transform', 'animation', 'hitTest', 'particle'];

  const accelerators: AcceleratorFinding[] = order.map((key) => {
    const status = report[key];
    return {
      accelerator: String(key),
      available: status.available,
      activeThisFrame: status.activeThisFrame,
      reason: status.reason,
      path: status.path,
      faulted:
        status.reason === 'rejected' ||
        status.reason === 'springs-rejected' ||
        status.reason === 'tweens-rejected',
      explanation: explain(String(key), status.reason, status.path),
    };
  });

  const activeCount = accelerators.filter((a) => a.activeThisFrame).length;
  const availableCount = accelerators.filter((a) => a.available).length;
  const faulted = accelerators.filter((a) => a.faulted);

  let summary: string;
  if (faulted.length > 0) {
    summary = `${faulted.length} of ${accelerators.length} accelerators FAULTED (${faulted
      .map((a) => a.accelerator)
      .join(', ')}): installed and gated in, but the kernel refused the call`;
  } else if (availableCount === 0) {
    summary = 'no accelerators installed; the scene runs entirely on the JS fallback paths';
  } else if (activeCount === 0) {
    summary = `${availableCount} installed, none active this frame — every one is below its gate or had nothing to do, so this frame ran in JS`;
  } else {
    summary = `${activeCount} of ${availableCount} installed accelerators active this frame (${accelerators
      .filter((a) => a.activeThisFrame)
      .map((a) => `${a.accelerator}:${a.path}`)
      .join(', ')})`;
  }

  return { accelerators, activeCount, availableCount, faulted, summary };
}

/** Render an accelerator inspection as readout rows. */
export function formatAcceleratorInspection(info: AcceleratorInspection): PluginRow[] {
  const rows: PluginRow[] = info.accelerators.map((a) => ({
    label: a.accelerator,
    value: a.activeThisFrame ? a.path : a.reason,
    note: a.faulted ? 'FAULT: kernel refused the call' : a.available ? undefined : 'not installed',
  }));
  rows.push({
    label: 'active',
    value: `${info.activeCount}/${info.availableCount}`,
    note: 'ran this frame / installed',
  });
  return rows;
}

/**
 * Flag any accelerator that faulted.
 *
 * Only `'rejected'` is reported. A gate that stays shut is the system working as
 * intended, and reporting it would train readers to ignore this audit.
 */
export function auditAccelerators(scene: Scene): PluginFinding[] {
  return inspectAccelerators(scene).faulted.map((a) => ({
    kind: 'accelerator-rejected',
    severity: 'warn' as const,
    message: `The ${a.accelerator} accelerator was installed and gated in, but its kernel refused the call and the frame fell back to ${a.path}. ${a.explanation}`,
  }));
}

/** The accelerator readout, as a plugin inspector. */
export const acceleratorInspector: PluginInspector = {
  id: 'accelerators',
  label: 'Accelerators',
  // Scene-wide, so it applies regardless of what is selected.
  rows: ({ scene }) => formatAcceleratorInspection(inspectAccelerators(scene)),
};

/** The accelerator fault audit, as a plugin audit. */
export const acceleratorAudit: PluginAudit = {
  id: 'accelerators',
  run: ({ scene }) => auditAccelerators(scene),
};
