import type { ShortcutAction, ShortcutMap } from './types';

/**
 * Normalize a keyboard chord to a stable key used in {@link ShortcutMap}.
 * Order: Ctrl/Control, Alt, Shift, Meta, then the uppercased key.
 *
 * Accepts either a {@link KeyboardEvent} or a pre-written string like
 * `Control+Shift+N`.
 */
export function normalizeChord(input: KeyboardEvent | string): string {
  if (typeof input === 'string') {
    const parts = input
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean);
    const mods = new Set<string>();
    let key = '';
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low === 'ctrl' || low === 'control') mods.add('Control');
      else if (low === 'alt') mods.add('Alt');
      else if (low === 'shift') mods.add('Shift');
      else if (low === 'meta' || low === 'cmd' || low === 'super') mods.add('Meta');
      else key = p.length === 1 ? p.toUpperCase() : p;
    }
    const ordered = ['Control', 'Alt', 'Shift', 'Meta'].filter((m) => mods.has(m));
    return key ? [...ordered, key].join('+') : ordered.join('+');
  }

  const ordered: string[] = [];
  if (input.ctrlKey) ordered.push('Control');
  if (input.altKey) ordered.push('Alt');
  if (input.shiftKey) ordered.push('Shift');
  if (input.metaKey) ordered.push('Meta');
  let key = input.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  // Skip pure modifier presses.
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    return ordered.join('+');
  }
  ordered.push(key);
  return ordered.join('+');
}

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
