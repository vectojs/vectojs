import { Markdown } from '../src';

export interface StreamControllerBrowserResult {
  burstAppends: number;
  burstSourceLength: number;
  ordered: boolean;
  pacedClusterIntact: boolean;
  finalFlushed: boolean;
  aborted: boolean;
  destroyed: boolean;
}

declare global {
  interface Window {
    __ready?: boolean;
    __streamControllerResult?: StreamControllerBrowserResult;
    __streamControllerError?: string;
  }
}

const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame((timestamp) => resolve(timestamp)));

function sourceOf(markdown: Markdown): string {
  const value: unknown = markdown;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('rawMarkdown' in value) ||
    typeof value.rawMarkdown !== 'string'
  ) {
    throw new Error('Markdown source is unavailable');
  }
  return value.rawMarkdown;
}

function descriptorValue(markdown: Markdown, groupLabel: string, fieldLabel: string): number {
  const group = markdown
    .getDevtoolsDescriptor()
    .groups?.find((candidate) => candidate.label === groupLabel);
  const field = group?.fields.find((candidate) => candidate.label === fieldLabel);
  if (typeof field?.value !== 'number') {
    throw new Error(`Missing numeric ${groupLabel}/${fieldLabel} descriptor`);
  }
  return field.value;
}

async function run(): Promise<void> {
  const burstMarkdown = new Markdown('');
  const burst = burstMarkdown.createStream();
  const writes: Promise<void>[] = [];
  for (let index = 0; index < 100; index++) writes.push(burst.write('x'));
  await Promise.all(writes);
  await nextFrame();
  await nextFrame();

  const burstAppends = descriptorValue(burstMarkdown, 'Streaming', 'appends');
  const burstSourceLength = descriptorValue(burstMarkdown, 'Source', 'sourceLength');
  await burst.close();

  const orderedMarkdown = new Markdown('');
  const orderedStream = orderedMarkdown.createStream({ maxBufferedChars: 1 });
  await orderedStream.write('A');
  const blocked = orderedStream.write('B');
  orderedMarkdown.appendMarkdown('C');
  await blocked;
  await orderedStream.close();
  const ordered = sourceOf(orderedMarkdown) === 'ABC';

  const pacedMarkdown = new Markdown('');
  const paced = pacedMarkdown.createStream({ pacing: { graphemesPerSecond: 1000 } });
  await paced.write('e');
  await nextFrame();
  await nextFrame();
  await paced.write('\u0301X');
  await nextFrame();
  await nextFrame();
  const pacedClusterIntact = sourceOf(pacedMarkdown) === 'e\u0301';
  await paced.close();
  const finalFlushed = sourceOf(pacedMarkdown) === 'e\u0301X';

  const abortController = new AbortController();
  const abortedMarkdown = new Markdown('');
  const abortedStream = abortedMarkdown.createStream({ signal: abortController.signal });
  await abortedStream.write('discard');
  abortController.abort('stop');
  await nextFrame();
  const aborted = abortedStream.state === 'aborted' && sourceOf(abortedMarkdown) === '';

  const destroyedMarkdown = new Markdown('');
  const destroyedStream = destroyedMarkdown.createStream();
  await destroyedStream.write('discard');
  destroyedMarkdown.destroy();
  await nextFrame();
  const destroyed = destroyedStream.state === 'aborted' && sourceOf(destroyedMarkdown) === '';

  window.__streamControllerResult = {
    burstAppends,
    burstSourceLength,
    ordered,
    pacedClusterIntact,
    finalFlushed,
    aborted,
    destroyed,
  };
  window.__ready = true;
}

run().catch((error) => {
  window.__streamControllerError =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  window.__ready = true;
  throw error;
});
