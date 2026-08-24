import type { ShortcutAction, ShortcutMap } from './types';
import { normalizeChord } from '@vectojs/core';

// `normalizeChord` was promoted to @vectojs/core so both packages share one
// implementation; re-exported here to keep desktop's public API unchanged
// (`src/index.ts` exports it from this module).
export { normalizeChord };

export type ShortcutHandler = (action: ShortcutAction, chord: string) => void;

function normalizeMap(map: ShortcutMap): ShortcutMap {
  const out: ShortcutMap = {};
  for (const [chord, action] of Object.entries(map)) {
    out[normalizeChord(chord)] = action;
  }
  return out;
}

/**
 * Document-level keyboard shortcut router. Matches normalized chords against
 * a {@link ShortcutMap} and invokes the shell handler. Ignores events that
 * originate from editable fields unless the chord includes a modifier.
 */
export class ShortcutRouter {
  private map: ShortcutMap;
  private handler: ShortcutHandler | null = null;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private attached = false;

  constructor(map: ShortcutMap = {}) {
    this.map = normalizeMap(map);
    this.onKeyDown = (e) => this.handleEvent(e);
  }

  /** Replace the shortcut table. */
  setMap(map: ShortcutMap): void {
    this.map = normalizeMap(map);
  }

  /** Register the action dispatcher. */
  setHandler(handler: ShortcutHandler | null): void {
    this.handler = handler;
  }

  /** Begin listening on `document`. Idempotent. */
  attach(): void {
    if (this.attached || typeof document === 'undefined') return;
    document.addEventListener('keydown', this.onKeyDown);
    this.attached = true;
  }

  /** Stop listening. */
  detach(): void {
    if (!this.attached || typeof document === 'undefined') return;
    document.removeEventListener('keydown', this.onKeyDown);
    this.attached = false;
  }

  /** Resolve a chord without side effects. */
  lookup(chord: string): ShortcutAction | undefined {
    return this.map[normalizeChord(chord)];
  }

  private handleEvent(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    // Holding a chord must not fire the action repeatedly — `'single'` apps
    // focus the existing window anyway, but `'multiple'` apps would spawn one
    // window per repeat event.
    if (e.repeat) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    const editable =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      target?.isContentEditable === true;
    // Allow modified shortcuts even in fields (e.g. Ctrl+S); block bare keys.
    if (editable && !(e.ctrlKey || e.metaKey || e.altKey)) return;

    const chord = normalizeChord(e);
    const action = this.map[chord];
    if (!action || !this.handler) return;
    e.preventDefault();
    this.handler(action, chord);
  }
}
