import { randomUUID } from 'node:crypto';
import { access, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export interface StagedOutputDependencies {
  randomUUID(): string;
  rename: typeof rename;
  rm: typeof rm;
  access: typeof access;
  readdir: typeof readdir;
}

const defaultDependencies: StagedOutputDependencies = {
  randomUUID,
  rename,
  rm,
  access,
  readdir,
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export class StagedOutput {
  readonly path: string;
  readonly targetPath: string;
  private readonly backupPath: string;
  private committed = false;
  private cleaned = false;
  private backupMoved = false;
  /**
   * Reclaim sweep for staging files stranded by a previous run. A kill
   * landing between the backup-rename and install steps of {@link commit}
   * leaves the previous output inside a hidden `.vecto-*` path no cleanup
   * will ever visit (the process died), so the next export start sweeps
   * them. Started at construction; awaited before any rename so the sweep
   * can never race this instance's own commit/cleanup.
   */
  private readonly staleSweep: Promise<void>;

  private constructor(
    targetPath: string,
    id: string,
    private readonly dependencies: StagedOutputDependencies,
  ) {
    const directory = dirname(targetPath);
    const extension = extname(targetPath);
    const stem = basename(targetPath, extension);
    this.targetPath = targetPath;
    this.path = join(directory, `.${stem}.vecto-${id}.mp4`);
    this.backupPath = join(directory, `.${stem}.vecto-${id}.backup${extension || '.mp4'}`);
    this.staleSweep = this.sweepStaleFiles();
  }

  static create(
    targetPath: string,
    dependencies: Partial<StagedOutputDependencies> = {},
  ): StagedOutput {
    const resolved = { ...defaultDependencies, ...dependencies };
    return new StagedOutput(targetPath, resolved.randomUUID(), resolved);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.dependencies.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes `.vecto-*` staging/backup siblings left by a dead previous run.
   * Assumes one exporter per target path at a time (as before — concurrent
   * exports to one destination already fought over the same renames); the
   * prefix is specific enough that unrelated files are never touched.
   * Best-effort: a failed sweep must not fail the export.
   */
  private async sweepStaleFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await this.dependencies.readdir(dirname(this.targetPath));
    } catch {
      return; // directory missing/unreadable: nothing to reclaim
    }
    const prefix = `.${basename(this.targetPath, extname(this.targetPath))}.vecto-`;
    const own = new Set([basename(this.path), basename(this.backupPath)]);
    const doomed = entries.filter((name) => name.startsWith(prefix) && !own.has(name));
    await Promise.allSettled(
      doomed.map((name) =>
        this.dependencies.rm(join(dirname(this.targetPath), name), { force: true }),
      ),
    );
  }

  async commit(): Promise<void> {
    if (this.committed) return;
    await this.staleSweep;

    try {
      await this.dependencies.rename(this.path, this.targetPath);
      this.committed = true;
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(errorCode(error) ?? '')) throw error;
      if (!(await this.exists(this.targetPath))) throw error;
    }

    await this.dependencies.rename(this.targetPath, this.backupPath);
    this.backupMoved = true;
    try {
      await this.dependencies.rename(this.path, this.targetPath);
      this.committed = true;
    } catch (installError) {
      try {
        await this.dependencies.rename(this.backupPath, this.targetPath);
        this.backupMoved = false;
      } catch (restoreError) {
        // `restoreError` is preserved in the AggregateError's `errors` array
        // alongside `installError`. A `cause` chain would hold only one of the
        // two, so this carries strictly more information than the rule asks.
        // oxlint-disable-next-line eslint/preserve-caught-error
        throw new AggregateError(
          [installError, restoreError],
          'Failed to install staged output and restore the previous destination',
        );
      }
      throw installError;
    }

    await this.dependencies.rm(this.backupPath, { force: true });
    this.backupMoved = false;
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.staleSweep;
    const errors: unknown[] = [];

    try {
      await this.dependencies.rm(this.path, { force: true });
    } catch (error) {
      errors.push(error);
    }

    if (this.backupMoved && (await this.exists(this.backupPath))) {
      try {
        if (await this.exists(this.targetPath)) {
          await this.dependencies.rm(this.backupPath, { force: true });
        } else {
          await this.dependencies.rename(this.backupPath, this.targetPath);
        }
        this.backupMoved = false;
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean staged output');
  }
}
