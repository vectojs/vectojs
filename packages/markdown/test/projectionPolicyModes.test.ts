// @vitest-environment jsdom
/**
 * Markdown × capability-negotiation integration (RFC4 §6 dogfood, CTX-0601).
 *
 * A real `Markdown` document driven through the three switcher modes with a
 * non-materializing backend stand-in: asserts the block→kind mapping lands
 * each block class on the right backend with reported reasons, and that canvas
 * mode never touches a backend (the byte-identical regression gate).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Entity, Scene, type ProjectionBackend } from '@vectojs/core';
import { Markdown } from '../src/Markdown';
import {
  applyProjectionMode,
  classifyProjectionBlocks,
  type ClassifiedProjectionBlock,
} from '../src/projection-policy';

const CORPUS = [
  '# Dogfood title',
  '',
  'A paragraph of prose to select.',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
].join('\n');

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

/** Non-materializing stand-in: negotiates without creating any element. */
function fakeDomBackend(): ProjectionBackend & { updates: number } {
  const backend = {
    kind: 'dom' as const,
    updates: 0,
    mount(node: Entity): void {
      node.domResident = true;
    },
    update(node: Entity): void {
      backend.updates += 1;
      node.domResident = true;
    },
    unmount(node: Entity): void {
      node.domResident = false;
    },
  };
  return backend;
}

describe('Markdown projection-policy switcher (RFC4 §6)', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;
  let backend: ProjectionBackend & { updates: number };
  let markdown: Markdown;
  let blocks: ClassifiedProjectionBlock[];

  const tick = (): void => {
    (scene as unknown as { isRunning: boolean }).isRunning = true;
    (scene as unknown as { loop: (t: number) => void }).loop(0);
  };
  const byLabel = (prefix: string): ClassifiedProjectionBlock[] =>
    blocks.filter((b) => b.label.includes(prefix));

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 700;
    document.body.appendChild(canvas);
    scene = new Scene(canvas, { maxFPS: 0, disableWindowResize: true });
    scene.renderMode = 'always';
    backend = fakeDomBackend();
    scene.addProjectionBackend(backend);
    markdown = new Markdown(CORPUS, { maxWidth: 860, blockAffordances: false });
    scene.add(markdown);
    blocks = classifyProjectionBlocks(markdown.content);
  });

  afterEach(() => {
    scene.destroy();
    canvas.remove();
    document.body.innerHTML = '';
  });

  it('classifies every corpus block class', () => {
    const labels = blocks.map((b) => b.label);
    expect(labels.some((l) => l.includes('(prose)'))).toBe(true);
    expect(labels.some((l) => l.includes('CodeBlock'))).toBe(true);
    expect(labels.some((l) => l.includes('Table'))).toBe(true);
  });

  it('canvas mode never touches a backend (byte-identical gate)', () => {
    applyProjectionMode(markdown, 'canvas');
    tick();
    tick();
    expect(backend.updates).toBe(0);
    for (const { node } of blocks) {
      expect(scene.getProjectionResolution(node.id)).toMatchObject({
        want: 'canvas',
        resolved: 'canvas',
        reason: null,
      });
      expect(node.domResident).toBe(false);
    }
  });

  it('dom mode materializes prose and code, leaving tables canvas', () => {
    applyProjectionMode(markdown, 'dom');
    tick();
    for (const { node } of byLabel('(prose)')) {
      expect(scene.getProjectionResolution(node.id)).toMatchObject({ resolved: 'dom' });
      expect(node.domResident).toBe(true);
    }
    for (const { node } of byLabel('CodeBlock')) {
      expect(scene.getProjectionResolution(node.id)).toMatchObject({ resolved: 'dom' });
    }
    for (const { node } of byLabel('Table')) {
      expect(scene.getProjectionResolution(node.id)).toMatchObject({ resolved: 'canvas' });
      expect(node.domResident).toBe(false);
    }
  });

  it('hybrid negotiates per block with reported reasons', () => {
    applyProjectionMode(markdown, 'hybrid');
    tick();
    // Prose negotiates to dom (native selection value outweighs DOM cost).
    for (const { node } of byLabel('(prose)')) {
      expect(scene.getProjectionResolution(node.id)).toMatchObject({
        want: 'auto',
        resolved: 'dom',
      });
    }
    // Code rests on canvas per its row default; tables report unsupported-kind.
    for (const { node } of byLabel('CodeBlock')) {
      expect(scene.getProjectionResolution(node.id)).toMatchObject({
        want: 'auto',
        resolved: 'canvas',
      });
    }
    for (const { node } of byLabel('Table')) {
      expect(scene.getProjectionResolution(node.id)).toEqual({
        nodeId: node.id,
        want: 'auto',
        resolved: 'canvas',
        reason: 'unsupported-kind',
      });
    }
  });
});
