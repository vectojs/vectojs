import { describe, expect, it } from 'vitest';
import { MemoryVfs } from '../src';

describe('MemoryVfs', () => {
  it('writes, reads, lists, and removes files', async () => {
    const vfs = new MemoryVfs();
    await vfs.mkdir('/docs');
    await vfs.write('/docs/a.txt', 'hello');
    expect(await vfs.read('/docs/a.txt')).toBe('hello');
    const entries = await vfs.list('/docs');
    expect(entries).toEqual([{ name: 'a.txt', path: '/docs/a.txt', kind: 'file', size: 5 }]);
    expect(await vfs.stat('/docs/a.txt')).toEqual({
      path: '/docs/a.txt',
      kind: 'file',
      size: 5,
    });
    await vfs.remove('/docs/a.txt');
    expect(await vfs.stat('/docs/a.txt')).toBeNull();
  });

  it('creates parent dirs on write and rejects file/dir collisions', async () => {
    const vfs = new MemoryVfs();
    await vfs.write('/a/b/c.txt', 'x');
    expect(await vfs.stat('/a')).toEqual({ path: '/a', kind: 'dir', size: 0 });
    await expect(vfs.mkdir('/a/b/c.txt')).rejects.toThrow(/file exists/);
    await vfs.write('/a/b/c.txt', 'y');
    expect(await vfs.read('/a/b/c.txt')).toBe('y');
  });

  it('remove on a directory is recursive', async () => {
    const vfs = new MemoryVfs();
    await vfs.write('/tree/x.txt', '1');
    await vfs.write('/tree/sub/y.txt', '2');
    await vfs.remove('/tree');
    expect(await vfs.stat('/tree')).toBeNull();
    expect(await vfs.stat('/tree/sub/y.txt')).toBeNull();
  });
});
