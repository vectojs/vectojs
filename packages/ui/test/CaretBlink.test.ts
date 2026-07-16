// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scene, VectoJSEvent } from '@vectojs/core';
import { Input } from '../src/Input';
import { TextArea } from '../src/TextArea';

// Input/TextArea derive the caret-blink phase from Date.now() inside render(),
// which the Scene's idle throttle cannot see — nothing marks the scene dirty
// when the phase flips, so an onDemand scene would freeze the caret solid
// (the ScrollView 0.2.x regression class). These tests pin the focus-scoped
// wake-up that keeps the blink rendering.

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  return new Scene(canvas);
}

const isDirty = (scene: Scene) => (scene as unknown as { dirty: boolean }).dirty;
const clearDirty = (scene: Scene) => {
  (scene as unknown as { dirty: boolean }).dirty = false;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  ['Input', () => new Input({ width: 200 })],
  ['TextArea', () => new TextArea({ width: 200 })],
])('%s caret blink visibility', (_name, make) => {
  it('marks the scene dirty at each 500ms blink boundary while focused', () => {
    const scene = makeScene();
    const field = make();
    scene.add(field);

    clearDirty(scene);
    field.dispatchEvent(new VectoJSEvent('focus', field, undefined, true));
    expect(field.focused).toBe(true);
    expect(isDirty(scene)).toBe(true); // caret appears promptly

    for (let i = 0; i < 3; i++) {
      clearDirty(scene);
      vi.advanceTimersByTime(500);
      expect(isDirty(scene)).toBe(true); // every phase flip re-renders
    }
  });

  it('stops waking the scene on blur', () => {
    const scene = makeScene();
    const field = make();
    scene.add(field);

    field.dispatchEvent(new VectoJSEvent('focus', field, undefined, true));
    field.dispatchEvent(new VectoJSEvent('blur', field, undefined, true));
    expect(field.focused).toBe(false);

    clearDirty(scene);
    vi.advanceTimersByTime(5000);
    expect(isDirty(scene)).toBe(false); // idle again — no timer left running
  });

  it('clears its timer on destroy', () => {
    const scene = makeScene();
    const field = make();
    scene.add(field);

    const timersBefore = vi.getTimerCount();
    field.dispatchEvent(new VectoJSEvent('focus', field, undefined, true));
    expect(vi.getTimerCount()).toBe(timersBefore + 1);

    field.destroy();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});
