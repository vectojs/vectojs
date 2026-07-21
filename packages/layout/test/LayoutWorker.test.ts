// @vitest-environment jsdom
import { test, expect, beforeAll, beforeEach } from 'vitest';
import type { LayoutWorkerRequest, LayoutWorkerResponse } from '../src/LayoutWorker';

// The worker module registers `self.onmessage` and replies via `self.postMessage`.
// Drive it directly: capture the handler, stub postMessage, feed requests.
let handler: (e: { data: unknown; origin: string }) => void;
let responses: LayoutWorkerResponse[] = [];

beforeAll(async () => {
  (self as unknown as { postMessage: (msg: unknown) => void }).postMessage = (msg: unknown) => {
    responses.push(msg as LayoutWorkerResponse);
  };
  await import('../src/LayoutWorker');
  handler = (self as unknown as { onmessage: typeof handler }).onmessage;
});

beforeEach(() => {
  responses = [];
});

// ascender 0.8 / descender -0.2 → line height = fontSize at lineHeight undefined.
const fontData = {
  atlas: { type: 'msdf', distanceRange: 4, size: 32, width: 256, height: 256, yOrigin: 'bottom' },
  metrics: { emSize: 1, lineHeight: 1, ascender: 0.8, descender: -0.2 },
  glyphs: [
    { unicode: 0x61, advance: 0.5 }, // 'a' → 5px at fontSize 10
    { unicode: 0x20, advance: 0.25 }, // ' ' → 2.5px
    { unicode: 0x4e2d, advance: 1 }, // '中' → 10px
  ],
};

let seq = 0;
function layout(text: string, maxWidth: number): LayoutWorkerResponse {
  const request: LayoutWorkerRequest = {
    id: 'w',
    seqId: ++seq,
    text,
    fontId: 'test-font',
    fontData: fontData as LayoutWorkerRequest['fontData'],
    maxWidth,
    maxHeight: 1000,
    fontSize: 10,
  };
  handler({ data: request, origin: '' });
  expect(responses.length).toBe(1);
  return responses[0];
}

function lineOf(res: LayoutWorkerResponse, i: number): number {
  // nodeY = lineIndex * lineHeight(10) + ascender*fontSize(8)
  return Math.round((res.yCoords[i] - 8) / 10);
}

test('reports the widest line, not the last line', () => {
  // 'aaaa' (20) + ' ' (2.5) fits in 25; the next 'aa' (10) wraps.
  const res = layout('aaaa aa', 25);
  expect(res.height).toBe(20); // two lines
  expect(res.width).toBeCloseTo(22.5); // line 0 incl. the space — NOT line 1's 10
});

test('keeps a word intact when it overflows mid-word', () => {
  // 'aaa ' ends at 17.5; 'aaaa' (20) cannot fit in the remaining 12.5 —
  // the whole word moves to line 1 instead of splitting after 2 glyphs.
  const res = layout('aaa aaaa', 30);
  const chars = Array.from(res.codePoints).map((c) => String.fromCodePoint(c));
  const wordStart = 4; // index of the second word's first glyph
  expect(chars[wordStart]).toBe('a');
  expect(lineOf(res, wordStart)).toBe(1);
  expect(res.xCoords[wordStart]).toBe(0); // starts at the new line's origin
  expect(lineOf(res, wordStart + 3)).toBe(1); // whole word on line 1
  expect(res.width).toBeCloseTo(20); // widest line is the moved word
});

test('swallows the space it wraps at (no leading space on the next line)', () => {
  // 'aaaa' = 20 fills the line; the space would end at 22.5 > 20 → wrap.
  const res = layout('aaaa aaa', 20);
  const chars = Array.from(res.codePoints).map((c) => String.fromCodePoint(c));
  expect(chars).not.toContain(' '); // wrapping space is not emitted
  expect(lineOf(res, 4)).toBe(1);
  expect(res.xCoords[4]).toBe(0);
});

test('honors explicit newlines', () => {
  const res = layout('aa\naaa', 100);
  expect(res.codePoints.length).toBe(5); // \n emits no glyph
  expect(lineOf(res, 1)).toBe(0);
  expect(lineOf(res, 2)).toBe(1);
  expect(res.xCoords[2]).toBe(0);
  expect(res.height).toBe(20);
  expect(res.width).toBeCloseTo(15); // widest line = 'aaa'
});

test('breaks long unbreakable words per glyph instead of overflowing', () => {
  const res = layout('aaaaaaaa', 10); // 2 glyphs of 5px per 10px line
  for (let i = 0; i < 8; i++) {
    expect(lineOf(res, i)).toBe(Math.floor(i / 2));
    expect(res.xCoords[i]).toBe((i % 2) * 5);
  }
  expect(res.width).toBeCloseTo(10);
});

test('breaks CJK runs per glyph (no space boundaries)', () => {
  const res = layout('中中中', 25); // 10px each; two fit per 25px line
  expect(lineOf(res, 0)).toBe(0);
  expect(lineOf(res, 1)).toBe(0);
  expect(lineOf(res, 2)).toBe(1);
  expect(res.xCoords[2]).toBe(0);
});
