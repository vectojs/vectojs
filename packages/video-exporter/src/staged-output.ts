import { randomUUID } from 'node:crypto';
import { access, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export interface StagedOutputDependencies {
  randomUUID(): string;
  rename: typeof rename;
  rm: typeof rm;
  access: typeof access;
}

const defaultDependencies: StagedOutputDependencies = {
  randomUUID,
  rename,
  rm,
  access,
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

  async commit(): Promise<void> {
    if (this.committed) return;

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
