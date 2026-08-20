// Production scheduler benchmark for the homepage Hero workload.
//
// This deliberately uses Scene.start()/stop() and the browser's rAF loop. The
// synthetic scene.step() baseline remains a separate benchmark because step()
// renders unconditionally and cannot measure scheduler skips or idle work.
import { Entity, Scene, type IRenderer } from '@vectojs/core';
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const TRIALS = Number(p.get('trials') ?? 7);
const WIDTH = 800;
const HEIGHT = 450;

type Phase = {
  phase: string;
  totalMs: number;
  calls: number;
  avgMs: number;
  maxMs: number;
  share: number | null;
};

type ArmResult = {
  arm: string;
  trials: number;
  startupMs?: number;
  firstUsableFrameMs?: number;
  renderedFrames: number;
  skippedFrames: number;
  updateMs: number;
  updateCalls: number;
  eventMs?: number;
  frameTimeMs: number;
  phases: Phase[];
};

class HeroNode extends Entity {
  public updateTotalMs = 0;
  public updateCalls = 0;
  private velocity = 0.04;

  public constructor(interactive: boolean) {
    super('hero-node');
    this.width = 260;
    this.height = 96;
    this.interactive = interactive;
    this.setPosition(120, 130);
  }

  public isPointInside(x: number, y: number): boolean {
    return x >= 0 && x <= this.width && y >= 0 && y <= this.height;
  }

  public getA11yAttributes() {
    return { role: 'button', label: 'VectoJS hero', tabIndex: 0 };
  }

  public update(dt: number, time: number): void {
    const start = performance.now();
    super.update(dt, time);
    this.x += this.velocity * dt;
    if (this.x > 360 || this.x < 80) this.velocity = -this.velocity;
    this.updateTotalMs += performance.now() - start;
    this.updateCalls++;
  }

  public render(renderer: IRenderer): void {
    renderer.beginPath();
    renderer.roundRect(0, 0, this.width, this.height, 18);
    renderer.fill('#38bdf8');
  }
}

function waitForFrame(scene: Scene, predicate: () => boolean): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const deadline = started + 5000;
    const poll = (): void => {
      if (predicate()) {
        resolve(performance.now() - started);
        return;
      }
      if (performance.now() > deadline) {
        reject(new Error(`scheduler arm timed out at ${scene.frameStats.renderedFrames} frames`));
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

function makeScene(mode: 'always' | 'onDemand', interactive: boolean) {
  const host = document.createElement('div');
  host.style.width = `${WIDTH}px`;
  host.style.height = `${HEIGHT}px`;
  host.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.style.width = `${WIDTH}px`;
  canvas.style.height = `${HEIGHT}px`;
  host.appendChild(canvas);
  document.body.appendChild(host);
  const scene = new Scene(canvas, {
    disableWindowResize: true,
    renderMode: mode,
    contentProjection: false,
    maxFPS: 0,
  });
  scene.resize(WIDTH, HEIGHT);
  const node = new HeroNode(interactive);
  scene.add(node);
  scene.setPhaseTiming(true);
  return { host, scene, node };
}

async function runTrial(arm: string): Promise<ArmResult> {
  const startupStart = performance.now();
  const { host, scene, node } = makeScene(arm === 'idle' ? 'onDemand' : 'always', arm !== 'idle');
  const createdMs = performance.now() - startupStart;
  const firstUsableStart = performance.now();
  scene.start();
  await waitForFrame(
    scene,
    () =>
      scene.frameStats.renderedFrames >= 1 && (arm === 'idle' || scene.getA11yTree().length === 1),
  );
  const firstUsable = performance.now() - firstUsableStart;

  let eventMs: number | undefined;
  if (arm === 'pointer') {
    const eventStart = performance.now();
    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 180, clientY: 170 }),
    );
    eventMs = performance.now() - eventStart;
    await waitForFrame(scene, () => scene.frameStats.renderedFrames >= 2);
  } else if (arm === 'resize') {
    scene.resize(WIDTH + 40, HEIGHT + 20);
    await waitForFrame(scene, () => scene.frameStats.renderedFrames >= 2);
  } else if (arm === 'idle') {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } else {
    await waitForFrame(scene, () => scene.frameStats.renderedFrames >= 4);
  }

  const stats = scene.frameStats;
  const phases = scene.renderPhases;
  scene.stop();
  scene.destroy();
  host.remove();
  return {
    arm,
    trials: 1,
    startupMs: +createdMs.toFixed(3),
    firstUsableFrameMs: +firstUsable.toFixed(3),
    renderedFrames: stats.renderedFrames,
    skippedFrames: stats.skippedFrames,
    updateMs: +(node.updateTotalMs / Math.max(1, node.updateCalls)).toFixed(4),
    updateCalls: node.updateCalls,
    eventMs: eventMs === undefined ? undefined : +eventMs.toFixed(4),
    frameTimeMs: +stats.frameTimeMs.toFixed(4),
    phases: phases.map((entry) => ({ ...entry })),
  };
}

async function main() {
  await awaitStart();
  const startedAt = performance.now();
  const arms = ['startup', 'active', 'idle', 'pointer', 'resize'];
  const summaries: Record<string, ArmResult> = {};
  for (const arm of arms) {
    const trials: ArmResult[] = [];
    for (let trial = 0; trial < TRIALS; trial++) {
      trials.push(await runTrial(arm));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const representative = trials[Math.floor(trials.length / 2)]!;
    summaries[arm] = {
      ...representative,
      trials: TRIALS,
      startupMs: +median(trials.map((trial) => trial.startupMs!)).toFixed(3),
      firstUsableFrameMs: +median(trials.map((trial) => trial.firstUsableFrameMs!)).toFixed(3),
      updateMs: +median(trials.map((trial) => trial.updateMs)).toFixed(4),
      frameTimeMs: +median(trials.map((trial) => trial.frameTimeMs)).toFixed(4),
      eventMs:
        trials[0]!.eventMs === undefined
          ? undefined
          : +median(trials.map((trial) => trial.eventMs!)).toFixed(4),
    };
  }
  const result = await reportResult({
    name: 'hero-scheduler',
    params: { TRIALS, WIDTH, HEIGHT, scheduler: 'Scene.start/stop + requestAnimationFrame' },
    rows: [],
    summary: { productionScheduler: summaries, syntheticStepBaseline: 'separate benchmark' },
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('hero-scheduler', error));
