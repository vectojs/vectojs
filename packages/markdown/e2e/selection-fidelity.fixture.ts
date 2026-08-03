import { Scene } from '@vectojs/core';
import { Markdown } from '../src/Markdown';

/**
 * Real-browser Markdown selection fixture.
 *
 * `packages/markdown/test/selection-fidelity.test.ts` already covers the
 * *intent* side of this in jsdom: it asserts what `getContentProjection()`
 * returns. That test cannot cover selection *behavior*, for two structural
 * reasons — jsdom has no layout (its line 8 stubs `getContext` to null, so the
 * x/y/baseline numbers it checks come from the fallback estimator rather than
 * real font metrics) and jsdom has no usable `getSelection()` over positioned
 * text.
 *
 * What only a real engine can answer is what a user actually gets on the
 * clipboard when dragging across a *composed document*. `Markdown` projects one
 * transparent DOM node per leaf entity, and a selection that starts in the
 * heading and ends in a table cell walks every node in between, so **document
 * order is load-bearing** — and it is not the scene-graph insertion order.
 * `Scene` re-sorts content mirrors into visual reading order
 * (`sortNormalElementsVisually`) and only then does the browser's selection walk
 * agree with the reading order of the canvas.
 *
 * That is exactly what this suite caught: the table cells were ordered
 * column-major, so copying a two-column table returned one whole column and then
 * the other. See the regression test in
 * `packages/core/test/A11yNesting.test.ts`.
 */
export interface SelectionCaseResult {
  /** `getSelection().toString()` after the drag. */
  text: string;
  /** Text content of the anchor and focus nodes, for direction assertions. */
  anchor: string | null;
  focus: string | null;
}

export interface SelectionFidelityResult {
  /**
   * Document order of the projected content mirrors, one entry per node.
   *
   * The e2e asserts this against an explicit literal rather than against an
   * order recomputed here. Recomputing would reuse the same banding rule the
   * engine uses, so a defect in that rule would appear on both sides and the
   * comparison would pass — which is precisely how the column-major defect
   * survived: the one pre-existing ordering test had a single row, where no
   * order can disagree with any other.
   */
  documentOrder: string[];
  /** Number of materialized content mirrors. */
  nodeCount: number;
  /** Per-node computed `user-select`; every selectable node must allow text. */
  userSelect: string[];
  /** Select-all across the whole projection layer. */
  selectAll: string;
  /** Drag from inside the heading to inside the last table cell. */
  crossBlock: SelectionCaseResult;
  /** The same drag driven bottom-up, to prove direction independence. */
  crossBlockReversed: SelectionCaseResult;
  /** Drag confined to the fenced code block. */
  codeBlock: SelectionCaseResult;
}

declare global {
  interface Window {
    __selectionFidelity?: SelectionFidelityResult;
    __ready?: boolean;
    __vectoSelection?: { scene: Scene; markdown: Markdown };
  }
}

const canvas = document.querySelector('canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing fixture canvas');

await document.fonts.ready;

/**
 * A document spanning every block kind whose selection behavior differs:
 * heading (its own font size), body paragraph, fenced code (a grid projection
 * carrying source line breaks), and a table (each cell is a separate leaf
 * entity, and the table also projects a `role=grid` container that spans all of
 * them). Mixed font sizes are deliberate — CTX-0025 is specifically about
 * mixed-font-size documents, where one shared line height would misplace the
 * transparent overlay against the drawn glyphs.
 */
const SOURCE = [
  '# Alpha Heading',
  '',
  'Beta body paragraph.',
  '',
  // Inline math, so the suite covers what a `Range` copy yields for a reserved
  // inline object. The layout engine reserves ONE U+FFFC per object, and that
  // sentinel used to reach the projection verbatim: a copy read
  // `Iota \ufffc kappa` while the accessible name was already correct.
  'Iota $E = mc^2$ kappa.',
  '',
  '```ts',
  'const gamma = 1;',
  'const delta = 2;',
  '```',
  '',
  '| Epsilon | Zeta |',
  '| --- | --- |',
  '| Eta | Theta |',
].join('\n');

const scene = new Scene(canvas, { disableWindowResize: true });
scene.resize(360, 520);
const markdown = new Markdown(SOURCE, { maxWidth: 340, selectable: true });
scene.add(markdown);

// `scene.start()`, not `scene.step()`. Content projection is synced from the
// private rAF `loop()`, which `step()` never reaches — `step()` calls only
// `render()`. A fixture driving frames with `step()` therefore paints the canvas
// correctly and materializes **zero** DOM mirrors, so every selection assertion
// would vacuously pass against an empty document. Measured while writing this
// suite: `nodeCount: 0` after two `step()` calls, 7 after `start()`.
scene.start();

window.__vectoSelection = { scene, markdown };

window.__ready = true;
