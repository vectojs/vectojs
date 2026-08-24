/**
 * Scene-level keyboard channel primitives shared by @vectojs/core and
 * @vectojs/desktop.
 *
 * `normalizeChord` was promoted verbatim from @vectojs/desktop's
 * ShortcutRouter so both packages share one chord-normalization
 * implementation; desktop re-imports it from core.
 */

/**
 * Normalize a keyboard chord to a stable key used in shortcut maps.
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

/**
 * Payload delivered to scene-level `keydown`/`keyup` listeners registered via
 * {@link Scene.on} and to {@link Scene.registerShortcut} handlers.
 *
 * Deliberately NOT a {@link VectoJSEvent}: this channel has no entity target
 * and no tree propagation — it is a single scene-wide window-bubble tap.
 * `stopPropagation()`/`preventDefault()` forward to the native event so
 * handlers written against raw DOM semantics keep working.
 */
export interface SceneKeyEvent {
  /** Which phase of the key produced this event. */
  type: 'keydown' | 'keyup';
  /** Native `KeyboardEvent.key` (e.g. `'a'`, `'ArrowLeft'`, `'Enter'`). */
  key: string;
  /** Native `KeyboardEvent.code` (physical key, e.g. `'KeyA'`). */
  code: string;
  /** True while the key is auto-repeating; suppressed by the scene channel gate. */
  repeat: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  /** The DOM event target (`window` when dispatched directly at the window). */
  target: EventTarget | null;
  /** The originating browser event. */
  nativeEvent: KeyboardEvent;
  /** Forward to `nativeEvent.stopPropagation()`. */
  stopPropagation(): void;
  /** Forward to `nativeEvent.preventDefault()`. */
  preventDefault(): void;
}

/** Spec for {@link Scene.registerShortcut} / {@link Scene.unregisterShortcut}. */
export interface SceneShortcutSpec {
  /**
   * Chord string like `'ctrl+shift+n'`, matched after normalization via
   * {@link normalizeChord} (`'Control+Shift+N'`), or a live `KeyboardEvent`.
   */
  chord: string;
  handler: (e: SceneKeyEvent) => void;
}
