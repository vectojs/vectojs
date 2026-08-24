// A failed program link must not strand the programs that already linked, nor
// keep the GL context resident: init retries after a driver hiccup used to
// leak one program generation plus a live context per attempt (#686).
import { describe, it, expect, vi } from 'vitest';
import { createWebGLPointRenderer } from '../src/renderer/WebGLPointRenderer';

describe('createWebGLPointRenderer link-failure cleanup', () => {
  it('deletes previously linked programs and loses the context when any link fails', () => {
    const deletedPrograms: { n: number }[] = [];
    let programSeq = 0;
    let loseContext: ReturnType<typeof vi.fn> | null = null;

    // The 4th program (MSDF) fails to link; the rest succeed.
    const gl = {
      VERTEX_SHADER: 35633,
      FRAGMENT_SHADER: 35632,
      COMPILE_STATUS: 35713,
      LINK_STATUS: 35714,
      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      deleteShader: vi.fn(),
      createProgram: vi.fn(() => {
        return { n: ++programSeq };
      }),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn((_p: { n: number }, _status: number) => _p.n !== 4),
      deleteProgram: vi.fn((p: { n: number }) => deletedPrograms.push(p)),
      enable: vi.fn(),
      blendFunc: vi.fn(),
      getExtension: vi.fn(() => {
        loseContext = vi.fn();
        return { loseContext };
      }),
    } as unknown as WebGL2RenderingContext;

    const canvas = {
      getContext: vi.fn(() => gl),
    } as unknown as HTMLCanvasElement;

    expect(createWebGLPointRenderer(canvas)).toBeNull();

    // Programs 1-3 linked successfully and must be explicitly released
    // (program 4 is deleted by link() itself on its own failure).
    const deletedNs = deletedPrograms.map((p) => p.n).sort((a, b) => a - b);
    expect(deletedNs).toContain(1);
    expect(deletedNs).toContain(2);
    expect(deletedNs).toContain(3);

    // The context must not stay resident across retries.
    expect(loseContext).not.toBeNull();
    expect(loseContext!).toHaveBeenCalledTimes(1);
  });

  it('still returns null without exploding where WEBGL_lose_context is unavailable', () => {
    const gl = {
      VERTEX_SHADER: 35633,
      FRAGMENT_SHADER: 35632,
      COMPILE_STATUS: 35713,
      LINK_STATUS: 35714,
      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      deleteShader: vi.fn(),
      createProgram: vi.fn(() => ({ n: ++programSeq2 })),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => false), // everything fails
      deleteProgram: vi.fn(),
      enable: vi.fn(),
      blendFunc: vi.fn(),
      getExtension: vi.fn(() => null),
    } as unknown as WebGL2RenderingContext;
    let programSeq2 = 0;

    const canvas = { getContext: vi.fn(() => gl) } as unknown as HTMLCanvasElement;
    expect(createWebGLPointRenderer(canvas)).toBeNull();
  });
});
