/** Directory entry returned by {@link Vfs.list}. */
export interface VfsEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number;
}

/** Stat for a single path. */
export interface VfsStat {
  path: string;
  kind: 'file' | 'dir';
  size: number;
}

/**
 * Pluggable virtual filesystem. Phase surface is intentionally small: apps
 * that need real persistence inject their own implementation (IndexedDB,
 * OPFS, remote). The shell never hardcodes a backend.
 */
export interface Vfs {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  list(path: string): Promise<VfsEntry[]>;
  stat(path: string): Promise<VfsStat | null>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

function normalizePath(path: string): string {
  if (!path || path === '/') return '/';
  const parts = path.split('/').filter((p) => p && p !== '.');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else out.push(p);
  }
  return '/' + out.join('/');
}

function parentPath(path: string): string {
  const n = normalizePath(path);
  if (n === '/') return '/';
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

/**
 * In-memory VFS for tests and demos. Not durable across reloads.
 */
export class MemoryVfs implements Vfs {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>(['/']);

  async read(path: string): Promise<string> {
    const p = normalizePath(path);
    if (!this.files.has(p)) {
      throw new Error(`VFS: file not found: ${p}`);
    }
    return this.files.get(p)!;
  }

  async write(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') throw new Error('VFS: cannot write root');
    await this.ensureDir(parentPath(p));
    if (this.dirs.has(p)) throw new Error(`VFS: is a directory: ${p}`);
    this.files.set(p, data);
  }

  async list(path: string): Promise<VfsEntry[]> {
    const p = normalizePath(path);
    if (!this.dirs.has(p)) {
      throw new Error(`VFS: directory not found: ${p}`);
    }
    const prefix = p === '/' ? '/' : p + '/';
    const names = new Map<string, VfsEntry>();

    for (const dir of this.dirs) {
      if (dir === p) continue;
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      const name = rest.split('/')[0]!;
      if (!name || names.has(name)) continue;
      const full = normalizePath(prefix + name);
      if (this.dirs.has(full)) {
        names.set(name, { name, path: full, kind: 'dir', size: 0 });
      }
    }
    for (const [file, data] of this.files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest.includes('/')) continue;
      names.set(rest, {
        name: rest,
        path: file,
        kind: 'file',
        size: data.length,
      });
    }
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async stat(path: string): Promise<VfsStat | null> {
    const p = normalizePath(path);
    if (this.dirs.has(p)) return { path: p, kind: 'dir', size: 0 };
    if (this.files.has(p)) {
      return { path: p, kind: 'file', size: this.files.get(p)!.length };
    }
    return null;
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') return;
    if (this.files.has(p)) throw new Error(`VFS: file exists: ${p}`);
    await this.ensureDir(p);
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') throw new Error('VFS: cannot remove root');
    if (this.files.has(p)) {
      this.files.delete(p);
      return;
    }
    if (!this.dirs.has(p)) throw new Error(`VFS: not found: ${p}`);
    const prefix = p + '/';
    for (const f of [...this.files.keys()]) {
      if (f === p || f.startsWith(prefix)) this.files.delete(f);
    }
    for (const d of [...this.dirs]) {
      if (d === p || d.startsWith(prefix)) this.dirs.delete(d);
    }
  }

  private async ensureDir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (this.dirs.has(p)) return;
    if (this.files.has(p)) throw new Error(`VFS: file exists: ${p}`);
    if (p !== '/') await this.ensureDir(parentPath(p));
    this.dirs.add(p);
  }
}

export { normalizePath, parentPath };
