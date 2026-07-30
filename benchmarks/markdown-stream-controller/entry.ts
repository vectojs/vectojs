import {
  awaitStart,
  calibrateRefreshRate,
  reportFailure,
  reportResult,
} from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';
import { Scene } from '@vectojs/core';

const query = new URLSearchParams(location.search);
const CHUNKS = Number(query.get('chunks') ?? 200);
const CHUNKS_PER_FRAME = Number(query.get('chunksPerFrame') ?? 20);
const TRIALS = Number(query.get('trials') ?? 7);

const SHAPES: Record<string, (index: number) => string> = {
  prose: (index) =>
    index % 12 === 11
      ? '\n\nA new paragraph begins here and continues for a while. '
      : 'The quick brown fox jumps over the lazy dog. ',
  code: (index) => (index === 0 ? '```ts\nconst a0 = 0;' : `\nconst a${index} = ${index};`),
  mixed: (index) => {
    if (index % 10 === 0) return `\n\n## Heading ${index / 10}\n\n`;
    if (index % 10 === 5) return '\n\n- a list item\n- another item\n';
    if (index % 10 === 7) return '\n\n```ts\nconst x = 1;\n```\n\n';
    return 'Some prose that keeps accumulating in the current block. ';
  },
};

type Mode = 'direct' | 'controller';

interface InstrumentableMarkdown {
  appendMarkdownCore(chunk: string): unknown;
}

interface SourceMarkdown {
  rawMarkdown: string;
}

interface TrialMetrics {
  writeCallMs: number;
  commitMs: number;
  renderMs: number;
  activeMs: number;
  appendCommits: number;
  sourceEqual: boolean;
}

// Both guards below check `value !== null` before the `typeof` check. The
// reverse order is equivalent at runtime, but it narrows `value` to `object`
// first, after which CodeQL's js/comparison-between-incompatible-types reads the
// null comparison as impossible and reports a warning.
function isInstrumentableMarkdown(value: unknown): value is InstrumentableMarkdown {
  return (
    value !== null &&
    typeof value === 'object' &&
    'appendMarkdownCore' in value &&
    typeof value.appendMarkdownCore === 'function'
  );
}

function isSourceMarkdown(value: unknown): value is SourceMarkdown {
  return (
    value !== null &&
    typeof value === 'object' &&
    'rawMarkdown' in value &&
    typeof value.rawMarkdown === 'string'
  );
}

function streamAppends(markdown: {
  getDevtoolsDescriptor(): {
    groups?: Array<{ label: string; fields: Array<{ label: string; value: unknown }> }>;
  };
}): number {
  const field = markdown
    .getDevtoolsDescriptor()
    .groups?.find((group) => group.label === 'Streaming')
    ?.fields.find((candidate) => candidate.label === 'appends');
  if (typeof field?.value !== 'number') throw new Error('Missing Streaming/appends descriptor');
  return field.value;
}

const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame((timestamp) => resolve(timestamp)));

const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function main(): Promise<void> {
  await awaitStart();
  const startedAt = performance.now();
  const refreshHz = await calibrateRefreshRate(1000);
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 700;
  document.body.appendChild(canvas);
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:12px monospace;white-space:pre-wrap';
  document.body.appendChild(pre);

  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Reflect.deleteProperty(globalThis, 'Worker');

  try {
    // Dynamic import is required: Markdown creates its Worker at module evaluation,
    // and this benchmark must remove Worker first to attribute synchronous commits.
    const { Markdown } = await import('@vectojs/markdown');
    const rows: Array<Record<string, unknown>> = [];

    const runTrial = async (
      mode: Mode,
      chunkOf: (index: number) => string,
    ): Promise<TrialMetrics> => {
      const scene = new Scene(canvas, { disableWindowResize: true });
      scene.resize(900, 700);
      const markdown = new Markdown(chunkOf(0), { maxWidth: 820 });
      scene.add(markdown);
      scene.step(16.67);

      const instrumentable: unknown = markdown;
      if (!isInstrumentableMarkdown(instrumentable)) {
        throw new Error('Markdown append core is unavailable for benchmark attribution');
      }
      const originalAppendCore = instrumentable.appendMarkdownCore.bind(instrumentable);
      let commitMs = 0;
      instrumentable.appendMarkdownCore = (chunk: string): unknown => {
        const commitStarted = performance.now();
        const result = originalAppendCore(chunk);
        commitMs += performance.now() - commitStarted;
        return result;
      };

      const controller = mode === 'controller' ? markdown.createStream() : null;
      let writeCallMs = 0;
      let renderMs = 0;
      for (let start = 1; start < CHUNKS; start += CHUNKS_PER_FRAME) {
        const end = Math.min(CHUNKS, start + CHUNKS_PER_FRAME);
        const writes: Promise<void>[] = [];
        const writeStarted = performance.now();
        for (let index = start; index < end; index++) {
          if (controller) writes.push(controller.write(chunkOf(index)));
          else markdown.appendMarkdown(chunkOf(index));
        }
        writeCallMs += performance.now() - writeStarted;
        if (controller) {
          await Promise.all(writes);
          await nextFrame();
        }

        const renderStarted = performance.now();
        scene.step(16.67);
        renderMs += performance.now() - renderStarted;
        if (!controller) await nextFrame();
      }
      await controller?.close();

      const sourceValue: unknown = markdown;
      if (!isSourceMarkdown(sourceValue)) throw new Error('Markdown source is unavailable');
      let expected = '';
      for (let index = 0; index < CHUNKS; index++) expected += chunkOf(index);
      const sourceEqual = sourceValue.rawMarkdown === expected;
      const appendCommits = streamAppends(markdown);
      const activeMs = (mode === 'controller' ? writeCallMs + commitMs : writeCallMs) + renderMs;

      instrumentable.appendMarkdownCore = originalAppendCore;
      markdown.destroy();
      scene.destroy();
      await yieldToBrowser();
      return { writeCallMs, commitMs, renderMs, activeMs, appendCommits, sourceEqual };
    };

    for (const [shape, chunkOf] of Object.entries(SHAPES)) {
      const direct: TrialMetrics[] = [];
      const controller: TrialMetrics[] = [];
      for (let trial = 0; trial < TRIALS; trial++) {
        direct.push(await runTrial('direct', chunkOf));
        controller.push(await runTrial('controller', chunkOf));
      }

      const summarize = (samples: TrialMetrics[]) => ({
        writeCallMs: +median(samples.map((sample) => sample.writeCallMs)).toFixed(2),
        commitMs: +median(samples.map((sample) => sample.commitMs)).toFixed(2),
        renderMs: +median(samples.map((sample) => sample.renderMs)).toFixed(2),
        activeMs: +median(samples.map((sample) => sample.activeMs)).toFixed(2),
        appendCommits: Math.round(median(samples.map((sample) => sample.appendCommits))),
        sourceEqual: samples.every((sample) => sample.sourceEqual),
      });
      const directMedian = summarize(direct);
      const controllerMedian = summarize(controller);
      rows.push({
        shape,
        chunks: CHUNKS,
        chunksPerFrame: CHUNKS_PER_FRAME,
        direct: directMedian,
        controller: controllerMedian,
        commitReduction: +(directMedian.appendCommits / controllerMedian.appendCommits).toFixed(2),
        appendCoreSpeedup: +(directMedian.commitMs / controllerMedian.commitMs).toFixed(2),
        activeSpeedup: +(directMedian.activeMs / controllerMedian.activeMs).toFixed(2),
      });
      pre.textContent = JSON.stringify(rows, null, 2);
      await yieldToBrowser();
    }

    const result = await reportResult({
      name: 'markdown-stream-controller',
      refreshHz,
      params: {
        chunks: CHUNKS,
        chunksPerFrame: CHUNKS_PER_FRAME,
        trials: TRIALS,
        note: 'Worker removed before import; direct appends every token, controller receives the same tokens in per-frame bursts and commits once via real rAF. activeMs excludes rAF wait and includes producer calls, append core, and one Scene.step per frame.',
      },
      rows,
      durationMs: +(performance.now() - startedAt).toFixed(1),
    });
    pre.textContent = JSON.stringify(result, null, 2);
    window.close();
  } finally {
    if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
  }
}

void main().catch((error) => {
  void reportFailure('markdown-stream-controller', error);
});
