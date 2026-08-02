// @vitest-environment jsdom
// The rAF loop pauses when the canvas scrolls fully off-screen (an
// IntersectionObserver reports it) and resumes on re-entry, instead of running
// the full update/render every frame for a scene nobody can see.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene } from '../src';

// A controllable IntersectionObserver: records the observed element + callback
// and lets a test flip intersection on/off.
function installIntersectionObserver() {
  const instances: Array<{
    cb: IntersectionObserverCallback;
    el: Element;
    io: any;
  }> = [];
  (globalThis as any).IntersectionObserver = class {
    constructor(public cb: IntersectionObserverCallback) {}
    observe(el: Element) {
      instances.push({ cb: this.cb, el, io: this });
      // A real IntersectionObserver always delivers an initial callback, and
      // for a detached element it reports isIntersecting=false (verified in
      // real Chromium). Modelling that is what makes the detached-canvas tests
      // meaningful rather than tautological.
      this.cb([{ isIntersecting: el.isConnected } as IntersectionObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {
      const i = instances.findIndex((x) => x.io === this);
      if (i >= 0) instances.splice(i, 1);
    }
  } as never;
  return {
    instances,
    set(onScreen: boolean) {
      // Snapshot not needed: the loop body doesn't add/remove observers.
      for (const inst of instances) {
        inst.cb([{ isIntersecting: onScreen } as IntersectionObserverEntry], inst.io);
      }
    },
  };
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

describe('off-screen rAF pause (IntersectionObserver)', () => {
  let rafCbs: FrameRequestCallback[] = [];
  let origRaf: typeof requestAnimationFrame;
  let origIO: typeof IntersectionObserver;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    rafCbs = [];
    origRaf = globalThis.requestAnimationFrame;
    origIO = globalThis.IntersectionObserver;
    // Manual rAF pump: record callbacks; a test flushes them one "frame" at a time.
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    }) as never;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.IntersectionObserver = origIO;
  });

  const pump = (t: number) => {
    const batch = rafCbs;
    rafCbs = [];
    for (const cb of batch) cb(t);
  };

  it('observes the canvas and keeps looping while on-screen', () => {
    const io = installIntersectionObserver();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    scene.start();
    expect(io.instances.length).toBe(1);
    expect(io.instances[0].el).toBe(canvas);

    // On-screen: each pumped frame schedules the next.
    pump(16);
    expect(rafCbs.length).toBe(1);
    pump(32);
    expect(rafCbs.length).toBe(1);
    scene.stop();
  });

  it('pauses the loop (stops rescheduling) once the canvas goes off-screen', () => {
    const io = installIntersectionObserver();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    scene.start();
    pump(16);
    expect(rafCbs.length).toBe(1); // running

    io.set(false); // scrolled off-screen
    pump(32); // this frame sees off-screen → does NOT reschedule
    expect(rafCbs.length).toBe(0); // loop paused
    pump(48); // nothing queued → still nothing
    expect(rafCbs.length).toBe(0);
    scene.stop();
  });

  it('resumes the loop when the canvas returns on-screen', () => {
    const io = installIntersectionObserver();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    scene.start();
    pump(16);
    io.set(false);
    pump(32);
    expect(rafCbs.length).toBe(0); // paused

    io.set(true); // back on-screen → observer re-schedules
    expect(rafCbs.length).toBe(1);
    pump(64);
    expect(rafCbs.length).toBe(1); // looping again
    scene.stop();
  });

  // A canvas used purely as a texture source (@vectojs/three's ThreeAdapter
  // wraps one in a CanvasTexture) is never appended to the document. An
  // IntersectionObserver reports a detached element as not intersecting, which
  // would pause the loop with no possible resume path — verified in real
  // Chromium: a detached element's first callback is isIntersecting=false.
  it('does not observe a canvas that is not in the document', () => {
    const io = installIntersectionObserver();
    const canvas = document.createElement('canvas'); // deliberately not appended
    const scene = new Scene(canvas);
    scene.start();
    expect(io.instances.length).toBe(0);
    scene.stop();
  });

  it('keeps looping forever for a detached canvas', () => {
    installIntersectionObserver();
    const canvas = document.createElement('canvas'); // deliberately not appended
    const scene = new Scene(canvas);
    scene.start();
    // Without the guard the observer's first callback would set
    // _canvasOnScreen = false and this loop would die after one frame.
    for (let i = 1; i <= 5; i++) {
      pump(i * 16);
      expect(rafCbs.length).toBe(1);
    }
    scene.stop();
  });

  it('disconnects the observer on stop', () => {
    const io = installIntersectionObserver();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const scene = new Scene(canvas);
    scene.start();
    expect(io.instances.length).toBe(1);
    scene.stop();
    expect(io.instances.length).toBe(0);
  });
});
