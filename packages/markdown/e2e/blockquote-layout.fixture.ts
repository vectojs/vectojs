import { Scene } from '@vectojs/core';
import { RichText } from '@vectojs/ui';
import { Markdown } from '../src/Markdown';

export interface BlockquoteLayoutResult {
  outerWidth: number;
  outerWrapperRight: number;
  nestedWidth: number;
  nestedWrapperRight: number;
  paragraphMaxWidth: number;
}

declare global {
  interface Window {
    __blockquoteLayout?: BlockquoteLayoutResult;
    __ready?: boolean;
  }
}

const canvas = document.querySelector('canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing fixture canvas');

await document.fonts.ready;

const scene = new Scene(canvas, { disableWindowResize: true });
scene.resize(320, 240);
const markdown = new Markdown('> > A nested quoted paragraph that wraps across lines.', {
  maxWidth: 120,
});
scene.add(markdown);
scene.step(16.67);

const outer = markdown.content.children[0];
const outerStack = outer?.children[1];
const outerWrapper = outerStack?.children[0];
const nested = outerWrapper?.children[0];
const nestedStack = nested?.children[1];
const nestedWrapper = nestedStack?.children[0];
const paragraph = nestedWrapper?.children[0];

if (!outer || !outerWrapper || !nested || !nestedWrapper || !(paragraph instanceof RichText)) {
  throw new Error('Unexpected nested blockquote entity structure');
}

window.__blockquoteLayout = {
  outerWidth: outer.width,
  outerWrapperRight: outerWrapper.x + outerWrapper.width,
  nestedWidth: nested.width,
  nestedWrapperRight: nestedWrapper.x + nestedWrapper.width,
  paragraphMaxWidth: paragraph.maxWidth,
};
window.__ready = true;
