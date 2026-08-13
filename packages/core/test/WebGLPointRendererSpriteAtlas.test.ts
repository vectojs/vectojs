// @vitest-environment jsdom
//
// WebGLPointRenderer.setTexture must commit the pending sprite batch before
// swapping the atlas. Sprites are batched against the CURRENTLY bound texture;
// a mid-frame atlas swap that leaves them pending lets flush() draw them with
// the NEW atlas and the OLD UVs — wrong pixels, and the swap itself is
// invisible (this is the sprite-path counterpart of the MSDF switch guard
// setMSDFTexture already has).
import { describe, expect, it } from 'vitest';
import { createWebGLPointRenderer } from '../src/renderer/WebGLPointRenderer';

/** Ordered log of every GL call, for asserting draw-before-upload ordering. */
const CALLS: string[] = [];

function makeGl(): unknown {
  const fn = new Set([
    'shaderSource',
    'compileShader',
    'deleteShader',
    'attachShader',
    'linkProgram',
    'deleteProgram',
    'enable',
    'blendFunc',
    'bindVertexArray',
    'bindBuffer',
    'enableVertexAttribArray',
    'vertexAttribPointer',
    'useProgram',
    'bufferData',
    'activeTexture',
    'bindTexture',
    'uniform1i',
    'uniform2f',
    'uniform1f',
    'drawElements',
    'drawArrays',
    'clearColor',
    'clear',
    'texParameteri',
    'texImage2D',
    'deleteBuffer',
  ]);
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
        if (prop === 'getParameter') return () => new Float32Array([1, 1024]);
        if (prop === 'getAttribLocation' || prop === 'getUniformLocation') return () => 0;
        if (
          prop === 'createShader' ||
          prop === 'createProgram' ||
          prop === 'createBuffer' ||
          prop === 'createVertexArray' ||
          prop === 'createTexture'
        ) {
          return () => ({});
        }
        if (fn.has(prop)) {
          return () => {
            CALLS.push(prop);
          };
        }
        // Everything else is an opaque GL constant the renderer passes around.
        return prop;
      },
      set() {
        return true;
      },
    },
  );
}

describe('WebGLPointRenderer sprite atlas switch', () => {
  it('commits the pending sprite batch before uploading a new atlas', () => {
    CALLS.length = 0;
    const gl = makeGl();
    const canvas = { getContext: () => gl } as never;
    const renderer = createWebGLPointRenderer(canvas);
    expect(renderer).not.toBeNull();
    if (!renderer) return;

    renderer.begin();
    renderer.setTexture({} as never); // plain object: always "ready"
    renderer.addSprite(0, 0, 10, 10, 0, 0, 1, 1);

    // Swapping the atlas mid-frame: the batched sprite belongs to atlas A.
    renderer.setTexture({} as never);

    // The sprite draw (drawElements) must precede the second atlas upload
    // (texImage2D): the batch is drawn with the OLD texture before the new
    // one replaces its contents.
    const firstDraw = CALLS.indexOf('drawElements');
    const secondUpload = CALLS.lastIndexOf('texImage2D');
    expect(firstDraw).toBeGreaterThanOrEqual(0);
    expect(firstDraw).toBeLessThan(secondUpload);

    // The batch was consumed: the next frame start accounts exactly one draw,
    // and a subsequent flush has nothing left to emit with the wrong atlas.
    renderer.begin();
    expect(renderer.stats!().totalDrawCalls).toBe(1);
    const drawsAfterBegin = CALLS.filter((c) => c === 'drawElements').length;
    renderer.flush();
    expect(CALLS.filter((c) => c === 'drawElements').length).toBe(drawsAfterBegin);
  });
});
