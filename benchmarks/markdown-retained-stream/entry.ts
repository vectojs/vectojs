import { Scene } from '@vectojs/core';
import { Markdown } from '@vectojs/markdown';
import { awaitStart, calibrateRefreshRate, reportFailure, reportResult } from '../_shared/client';
import { percentile, summarize } from '../_shared/stats';

const params = new URLSearchParams(location.search);
const TARGET_KIB = Number(params.get('documentKiB') ?? 350);
const CHUNK_SIZE = Number(params.get('chunkSize') ?? 320);

function makeDocument(targetChars: number): string {
  const sections: string[] = [];
  let length = 0;
  for (let index = 0; length < targetChars; index++) {
    const section = `
## Streaming section ${index}

This paragraph exercises **incremental Markdown**, inline \`code\`, a [link](https://vectojs.org), and enough prose to wrap across several lines in the reader viewport. Section ${index} keeps the source unique.

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

async function main(): Promise<void> {
  await awaitStart();
  const refreshHz = await calibrateRefreshRate(1000);
  const budgetMs = 1000 / refreshHz;
  const source = makeDocument(TARGET_KIB * 1024);

  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const scene = new Scene(canvas, {
    maxFPS: 0,
    maxDPR: 2,
    renderMode: 'onDemand',
    contentSemanticMargin: Infinity,
    contentProjectionMargin: 1200,
  });
  scene.resize(innerWidth, innerHeight);
  const markdown = new Markdown('', { maxWidth: Math.min(900, innerWidth - 80) });
  markdown.setPosition(40, 24);
  scene.add(markdown);
  const stream = markdown.createStream({ incompleteMode: 'optimistic' });

  const costs: number[] = [];
  const intervals: number[] = [];
  let cursor = 0;
  let previousTimestamp = await nextFrame();
  while (cursor < source.length) {
    const timestamp = await nextFrame();
    const interval = timestamp - previousTimestamp;
    intervals.push(interval);
    previousTimestamp = timestamp;
    stream.write(source.slice(cursor, cursor + CHUNK_SIZE));
    cursor += CHUNK_SIZE;
    const frameStarted = performance.now();
    scene.step(interval || budgetMs);
    costs.push(performance.now() - frameStarted);
  }
  await stream.close();

  for (let frame = 0; frame < Math.ceil(refreshHz / 2); frame++) {
    const timestamp = await nextFrame();
    intervals.push(timestamp - previousTimestamp);
    previousTimestamp = timestamp;
    const frameStarted = performance.now();
    scene.step(budgetMs);
    costs.push(performance.now() - frameStarted);
  }

  const costStats = summarize(costs);
  const intervalStats = summarize(intervals);
  const result = await reportResult({
    name: 'markdown-retained-stream',
    refreshHz,
    params: {
      documentKiB: +(source.length / 1024).toFixed(1),
      chunkSize: CHUNK_SIZE,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    },
    summary: {
      budgetMs: +budgetMs.toFixed(4),
      frameCostP50Ms: +costStats.median.toFixed(4),
      frameCostP99Ms: +percentile(costs, 0.99).toFixed(4),
      frameCostMaxMs: +costStats.max.toFixed(4),
      frameIntervalP50Ms: +intervalStats.median.toFixed(4),
      frameIntervalP99Ms: +percentile(intervals, 0.99).toFixed(4),
      budgetHitSharePct: +(
        (100 * intervals.filter((value) => value <= budgetMs * 1.1).length) /
        intervals.length
      ).toFixed(1),
      droppedIntervals: intervals.filter((value) => value > budgetMs * 1.5).length,
      longIntervals: intervals.filter((value) => value > 50).length,
      frames: costs.length,
      finalBlocks: markdown.content.children.length,
      finalHeight: +markdown.height.toFixed(1),
    },
    rows: [],
  });

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
  markdown.destroy();
  scene.destroy();
}

main().catch((error) => reportFailure('markdown-retained-stream', error));
