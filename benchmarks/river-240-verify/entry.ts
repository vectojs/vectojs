import { Scene } from '@vectojs/core';
import { Markdown } from '@vectojs/markdown';
import { ScrollView, DOCUMENT_SCROLL_PHYSICS } from '@vectojs/ui';
import { awaitStart, calibrateRefreshRate, reportFailure, reportResult } from '../_shared/client';
import { percentile, summarize } from '../_shared/stats';

const params = new URLSearchParams(location.search);
const TARGET_KIB = Number(params.get('documentKiB') ?? 81);
const TOKEN_RATE = Number(params.get('tokenRate') ?? 2000);

function makeDocument(targetChars: number): string {
  const sections: string[] = [];
  let length = 0;
  for (let index = 0; length < targetChars; index++) {
    const section = `
## Streaming section ${index}

This paragraph exercises **incremental Markdown**, inline \`code\`, a [link](https://vectojs.org), and enough prose to wrap across several lines in the reader viewport. Section ${index} keeps the source unique for the streaming benchmark.

> The retained document should reuse stable blocks while drawing only the visible block range.

- item ${index}.1 with descriptive text
- item ${index}.2 with **emphasis** and \`const value = ${index}\`
- item ${index}.3 with a continuation that wraps naturally

| Metric | Value | Note |
| --- | ---: | --- |
| section | ${index} | streamed incrementally |
| parity | ${index % 2 === 0 ? 'even' : 'odd'} | deterministic corpus |

\`\`\`ts
export function section${index}(input: number): number {
  return input * ${index + 1};
}
\`\`\`

`;
    sections.push(section);
    length += section.length;
  }
  return sections.join('').slice(0, targetChars);
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// River-like Scene options after fix: uncapped 240Hz, no idle throttle, always
const RIVER_SCENE_OPTIONS = {
  disableWindowResize: true,
  maxDPR: 3,
  maxFPS: 0,
  autoThrottle: false,
  idleFPS: 60,
  renderMode: 'always' as const,
};

async function main(): Promise<void> {
  await awaitStart();
  const refreshHz = await calibrateRefreshRate(1000);
  const budgetMs = refreshHz > 0 ? 1000 / refreshHz : 4.1667;
  const started = performance.now();
  const source = makeDocument(TARGET_KIB * 1024);

  // Simple tokenization: one char ≈ one token for 2000 tok/s fidelity check
  // Use river-core tokenize approximation: split by char for high rate accuracy
  const tokens = source.split('');
  let cursor = 0;
  let accumulator = 0;

  const canvas = document.createElement('canvas');
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas as unknown as HTMLCanvasElement, RIVER_SCENE_OPTIONS);
  // Manual size like River mount: use innerWidth/innerHeight
  scene.resize(innerWidth, innerHeight);

  const markdown = new Markdown('', { maxWidth: Math.min(860, innerWidth - 64), selectable: true });
  const scroll = new ScrollView({
    width: Math.min(860, innerWidth - 32),
    height: innerHeight - 32,
    scrollPhysics: DOCUMENT_SCROLL_PHYSICS,
  });
  scroll.add(markdown);
  scroll.x = Math.round((innerWidth - scroll.width) / 2);
  scroll.y = 16;
  scene.add(scroll);

  const stream = markdown.createStream({
    incompleteMode: 'optimistic',
    maxBufferedChars: Math.max(64 * 1024, source.length),
  });

  const costs: number[] = [];
  const intervals: number[] = [];
  let previousTimestamp = await nextFrame();
  let frames = 0;
  let delivered = 0;
  const frameStartedAt: number[] = [];

  // Streaming loop: one tick per rAF, like River StreamTicker.update(dt)
  const t0 = performance.now();
  while (cursor < tokens.length) {
    const timestamp = await nextFrame();
    const interval = timestamp - previousTimestamp;
    intervals.push(interval);
    previousTimestamp = timestamp;

    const dt = interval || budgetMs;
    const tokensPerMs = TOKEN_RATE / 1000;
    accumulator += tokensPerMs * dt;
    const toAdd = Math.floor(accumulator);
    accumulator -= toAdd;
    let chunk = '';
    if (toAdd > 0) {
      const end = Math.min(cursor + toAdd, tokens.length);
      chunk = tokens.slice(cursor, end).join('');
      cursor = end;
      delivered += chunk.length;
    }

    if (chunk) {
      stream.write(chunk);
      // River does scrollToBottom when autoScroll true
      scroll.scrollToBottom();
    }

    const frameStarted = performance.now();
    scene.step(dt);
    costs.push(performance.now() - frameStarted);
    frames++;
    frameStartedAt.push(performance.now());
  }

  // Close stream and settle 0.5s like gallery-chat-large
  await stream.close();
  for (let f = 0; f < Math.ceil(refreshHz / 2); f++) {
    const timestamp = await nextFrame();
    intervals.push(timestamp - previousTimestamp);
    previousTimestamp = timestamp;
    const frameStarted = performance.now();
    scene.step(budgetMs);
    costs.push(performance.now() - frameStarted);
  }

  const elapsedSec = (performance.now() - t0) / 1000;
  const actualTokPerSec = delivered / elapsedSec;

  const costStats = summarize(costs);
  const intervalStats = summarize(intervals);
  const mem = (
    performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
  ).memory;
  const heapMB = mem ? mem.usedJSHeapSize / 1_048_576 : NaN;

  const result = await reportResult({
    name: 'river-240-verify',
    refreshHz,
    params: {
      documentKiB: +(source.length / 1024).toFixed(1),
      tokenRate: TOKEN_RATE,
      tokens: tokens.length,
      delivered,
      elapsedSec: +elapsedSec.toFixed(3),
      actualTokPerSec: +actualTokPerSec.toFixed(1),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      sceneOptions: RIVER_SCENE_OPTIONS,
      note: 'River uncapped 240Hz verify — 81k@2000 tok/s, Scene maxFPS 0 autoThrottle false renderMode always, costs vs 4.16ms budget, heap stable check',
    },
    summary: {
      budgetMs: +budgetMs.toFixed(4),
      frameCostP50Ms: +costStats.median.toFixed(4),
      frameCostP99Ms: +percentile(costs, 0.99).toFixed(4),
      frameCostMaxMs: +costStats.max.toFixed(4),
      frameIntervalP50Ms: +intervalStats.median.toFixed(4),
      frameIntervalP99Ms: +percentile(intervals, 0.99).toFixed(4),
      budgetHitSharePct: +(
        (100 * intervals.filter((v) => v <= budgetMs * 1.1).length) /
        intervals.length
      ).toFixed(1),
      droppedIntervals: intervals.filter((v) => v > budgetMs * 1.5).length,
      longIntervals: intervals.filter((v) => v > 50).length,
      frames: costs.length,
      streamingFrames: frames,
      finalBlocks: markdown.content.children.length,
      finalHeight: +markdown.height.toFixed(1),
      heapMB: Number.isFinite(heapMB) ? +heapMB.toFixed(1) : NaN,
      actualTokPerSec: +actualTokPerSec.toFixed(1),
      fidelityPct: +((actualTokPerSec / TOKEN_RATE) * 100).toFixed(1),
    },
    rows: [],
    durationMs: +(performance.now() - started).toFixed(1),
  });

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
  // Keep scene alive a moment for screenshot
  setTimeout(() => {
    // @ts-ignore
    (markdown as unknown as { destroy?: () => void })?.destroy?.();
    scene.destroy();
  }, 500);
}

main().catch((error) => reportFailure('river-240-verify', error));
