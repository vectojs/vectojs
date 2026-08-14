import type { AppDefinition } from './types';

/**
 * Installable-app catalogue. Config-owned apps are registered at shell start;
 * runtime code may also {@link register} plugins without touching the WM.
 */
export class AppRegistry {
  private readonly byId = new Map<string, AppDefinition>();

  constructor(initial: readonly AppDefinition[] = []) {
    for (const app of initial) this.register(app);
  }

  /** Add or replace an app definition. */
  register(app: AppDefinition): void {
    if (!app?.id) throw new TypeError('AppDefinition.id is required');
    if (typeof app.create !== 'function') {
      throw new TypeError(`App '${app.id}': create must be a function`);
    }
    this.byId.set(app.id, app);
  }

  /** Remove an app by id. No-op if unknown. */
  unregister(id: string): boolean {
    return this.byId.delete(id);
  }

  get(id: string): AppDefinition | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Snapshot of registered apps in insertion order. */
  list(): AppDefinition[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}
