// @vitest-environment jsdom
/**
 * Differential gate: the main-thread fallback must produce byte-identical
 * geometry to the worker.
 *
 * `computeMSDFLayout` was extracted out of the worker's `onmessage` so
 * `LayoutWorkerManager` can run it when no worker is available (CSP, SSR, a
 * crash). If the two ever diverge, text silently reflows depending on whether a
 * worker happened to be available — a difference no other test would notice,
 * because each path is exercised in isolation everywhere else.
 */
import { test, expect, beforeAll, beforeEach } from 'vitest';
import type { LayoutWorkerRequest, LayoutWorkerResponse } from '../src/LayoutWorker';
import { computeMSDFLayout } from '../src/msdfLayout';

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

const fontData = {
  atlas: {
    type: 'msdf',
    distanceRange: 4,
    size: 32,
    width: 256,
    height: 256,
    yOrigin: 'bottom',
  },
  metrics: { emSize: 1, lineHeight: 1, ascender: 0.8, descender: -0.2 },
  glyphs: [
    { unicode: 0x61, advance: 0.5 }, // 'a' → 5px at fontSize 10
    { unicode: 0x62, advance: 0.7 }, // 'b'
    { unicode: 0x20, advance: 0.25 }, // ' '
    { unicode: 0x4e2d, advance: 1 }, // '中'
    { unicode: 0x2d, advance: 0.5 }, // '-'
  ],
} as unknown as LayoutWorkerRequest['fontData'];

let seq = 0;
function request(over: Partial<LayoutWorkerRequest>): LayoutWorkerRequest {
  return {
    id: 'diff',
    seqId: ++seq,
    text: 'aaa',
    fontId: 'diff-font',
    fontData,
    maxWidth: 100,
    maxHeight: 1000,
    fontSize: 10,
    ...over,
  };
}

/** Run one request through the worker handler and through the direct call. */
function bothPaths(req: LayoutWorkerRequest): {
  worker: LayoutWorkerResponse;
  main: LayoutWorkerResponse;
} {
  responses = [];
  handler({ data: req, origin: '' });
  expect(responses.length).toBe(1);
  const worker = responses[0];
  // The worker transfers its buffers, so compute the main-thread result from a
  // fresh request object to be sure nothing is shared between the two.
  const main = computeMSDFLayout({ ...req }, fontData!);
  return { worker, main };
}

const cases: { name: string; req: Partial<LayoutWorkerRequest> }[] = [
  { name: 'single word', req: { text: 'aaa' } },
  {
    name: 'soft wrap between words',
    req: { text: 'aaa aaa aaa aaa', maxWidth: 40 },
  },
  { name: 'explicit newline', req: { text: 'aaa\naaa' } },
  {
    name: 'word longer than maxWidth',
    req: { text: 'aaaaaaaaaaaa', maxWidth: 20 },
  },
  {
    name: 'CJK per-glyph breaking',
    req: { text: '中中中中中中', maxWidth: 30 },
  },
  {
    name: 'soft hyphen break',
    req: { text: 'aa\u00adaa\u00adaa\u00adaa', maxWidth: 25 },
  },
  {
    name: 'justify',
    req: { text: 'aaa aaa aaa aaa', maxWidth: 45, textAlign: 'justify' },
  },
  {
    name: 'justify CJK (no spaces)',
    req: { text: '中中中中中中', maxWidth: 35, textAlign: 'justify' },
  },
  {
    name: 'letterSpacing',
    req: { text: 'aaa aaa', maxWidth: 40, letterSpacing: 2 },
  },
  { name: 'explicit lineHeight', req: { text: 'aaa\naaa', lineHeight: 24 } },
  { name: 'empty text', req: { text: '' } },
  { name: 'only spaces', req: { text: '   ' } },
  {
    name: 'unknown glyph falls back to 1em',
    req: { text: 'zzz', maxWidth: 25 },
  },
  {
    name: 'trailing space before wrap',
    req: { text: 'aaa aaa ', maxWidth: 40 },
  },
  { name: 'mixed latin and CJK', req: { text: 'aa中中aa中', maxWidth: 35 } },
];

for (const c of cases) {
  test(`worker and main thread agree: ${c.name}`, () => {
    const { worker, main } = bothPaths(request(c.req));

    expect(main.width).toBe(worker.width);
    expect(main.height).toBe(worker.height);
    // Array equality, element by element — Float32Array vs Float32Array.
    expect(Array.from(main.codePoints)).toEqual(Array.from(worker.codePoints));
    expect(Array.from(main.xCoords)).toEqual(Array.from(worker.xCoords));
    expect(Array.from(main.yCoords)).toEqual(Array.from(worker.yCoords));
    expect(Array.from(main.packedStyles)).toEqual(Array.from(worker.packedStyles));
  });
}

test('the differential cases actually exercise wrapping (guards the guard)', () => {
  // If every case collapsed to one line the comparison above would be vacuous.
  const wrapped = bothPaths(request({ text: 'aaa aaa aaa aaa', maxWidth: 40 })).main;
  const distinctY = new Set(Array.from(wrapped.yCoords));
  expect(distinctY.size).toBeGreaterThan(1);

  const hyphenated = bothPaths(request({ text: 'aa\u00adaa\u00adaa\u00adaa', maxWidth: 25 })).main;
  expect(Array.from(hyphenated.codePoints)).toContain(0x2d);
});

test('maxHeight truncates wrapped lines (main-thread mirror)', () => {
  // One line of height with text that wraps into several: only the first
  // line's glyphs are emitted and the reported height stays within maxHeight.
  const res = computeMSDFLayout(
    request({ text: 'aaa aaa aaa aaa', maxWidth: 40, maxHeight: 10 }),
    fontData,
  );

  expect(res.height).toBeLessThanOrEqual(10);
  // 'aaa aaa' = 8 glyphs; the wrapped third word is dropped, not moved down.
  expect(Array.from(res.yCoords)).toHaveLength(8);
  for (const y of res.yCoords) expect(y).toBeLessThan(10);
});
