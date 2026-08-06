import { Scene } from '@vectojs/core';
import { Markdown } from '../src/Markdown';

/**
 * Real-browser fixture for the code-block / table copy and download controls.
 *
 * The jsdom suite (`test/blockAffordances.test.ts`) asserts the wiring and the
 * serialized payloads. It cannot assert what this does, for two reasons that are
 * structural rather than incidental:
 *
 * 1. **Keyboard reachability is a layout question.** A control is reachable only
 *    if its projected element is focusable *and* positioned where the canvas drew
 *    it. jsdom has no layout — `getContext` is stubbed to null — so the geometry
 *    that decides whether a Tab lands on a real target does not exist there.
 * 2. **The clipboard needs a gesture.** Both engines reject
 *    `navigator.clipboard.writeText` outside a user gesture, and Firefox's
 *    permission model differs from Chrome's. The acceptance criterion for this
 *    feature is explicitly both engines, so a Chrome-only pass is not evidence.
 *
 * The controls report through `window.__affordance` rather than the real
 * clipboard: reading the clipboard back requires a permission Firefox does not
 * grant headlessly, so the gesture is real and observed, while the payload is
 * captured at the boundary the gesture reaches.
 */

export interface AffordanceProbe {
  /** Accessible names of every projected button, in document order. */
  buttonNames: string[];
  /** Tag names of those projected elements, to prove they are real buttons. */
  buttonTags: string[];
  /** What a click on the code-block copy control delivered. */
  clickPayload: string | null;
  /** What a keyboard activation (Enter on the focused control) delivered. */
  keyboardPayload: string | null;
  /** Accessible name immediately after activation, for transient feedback. */
  labelAfterActivate: string | null;
  /** Whether the focused element after one Tab from the canvas is a button. */
  firstTabIsButton: boolean;
  /** Bounding boxes of the controls, to prove they sit inside the block. */
  boxes: Array<{ x: number; y: number; width: number; height: number }>;
}

declare global {
  interface Window {
    __affordance?: AffordanceProbe;
    __captured: string[];
  }
}

const DOC = [
  '# Heading',
  '',
  '```ts',
  "const greeting = 'hÉllo';",
  '```',
  '',
  '| name | qty |',
  '| --- | --- |',
  '| café | 2 |',
].join('\n');

const canvas = document.querySelector('canvas');
if (!canvas) throw new Error('Fixture needs a canvas');

const scene = new Scene(canvas as HTMLCanvasElement);
window.__captured = [];

const md = new Markdown(DOC, {
  maxWidth: 320,
  blockAffordances: true,
  // Captured rather than written to the real clipboard: reading it back needs a
  // permission Firefox does not grant headlessly. The click that reaches this is
  // nonetheless a real dispatched gesture.
  writeClipboard: (text: string) => {
    window.__captured.push(text);
  },
  saveFile: (filename: string) => {
    window.__captured.push(`saved:${filename}`);
  },
});
scene.add(md.setPosition(10, 10));
scene.start();
