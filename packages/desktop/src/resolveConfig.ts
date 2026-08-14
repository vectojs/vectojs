import {
  DEFAULT_DESKTOP_TOKENS,
  type AppDefinition,
  type DisplaySpec,
  type ResolvedWebosConfig,
  type ShortcutAction,
  type ShortcutMap,
  type WebosConfig,
} from './types';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function assertApp(app: AppDefinition, index: number): void {
  if (!isNonEmptyString(app.id)) {
    throw new TypeError(`WebosConfig.apps[${index}].id must be a non-empty string`);
  }
  if (!isNonEmptyString(app.title)) {
    throw new TypeError(`WebosConfig.apps[${index}] (${app.id}): title must be a non-empty string`);
  }
  if (typeof app.create !== 'function') {
    throw new TypeError(`WebosConfig.apps[${index}] (${app.id}): create must be a function`);
  }
  if (app.instances !== undefined && app.instances !== 'single' && app.instances !== 'multiple') {
    throw new TypeError(
      `WebosConfig.apps[${index}] (${app.id}): instances must be 'single' | 'multiple'`,
    );
  }
}

function assertDisplay(d: DisplaySpec, index: number): void {
  if (!isNonEmptyString(d.id)) {
    throw new TypeError(`WebosConfig.desktop.displays[${index}].id must be a non-empty string`);
  }
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    if (typeof d[k] !== 'number' || !Number.isFinite(d[k])) {
      throw new TypeError(`WebosConfig.desktop.displays[${index}].${k} must be a finite number`);
    }
  }
  if (d.width <= 0 || d.height <= 0) {
    throw new TypeError(`WebosConfig.desktop.displays[${index}]: width/height must be positive`);
  }
}

function assertAction(action: ShortcutAction, chord: string): void {
  if (!action || typeof action !== 'object' || !('type' in action)) {
    throw new TypeError(`WebosConfig.shortcuts['${chord}'] must be a ShortcutAction`);
  }
  switch (action.type) {
    case 'open-app':
      if (!isNonEmptyString(action.appId)) {
        throw new TypeError(`shortcut '${chord}': open-app requires appId`);
      }
      break;
    case 'close-focused':
    case 'toggle-start':
      break;
    case 'custom':
      if (!isNonEmptyString(action.id)) {
        throw new TypeError(`shortcut '${chord}': custom requires id`);
      }
      break;
    default:
      throw new TypeError(`shortcut '${chord}': unknown action type`);
  }
}

/**
 * Validate and merge a partial {@link WebosConfig} with defaults.
 * Throws {@link TypeError} on illegal shapes so broken configs fail loudly.
 */
export function resolveConfig(input: WebosConfig = {}): ResolvedWebosConfig {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('WebosConfig must be an object');
  }

  const appsIn = input.apps ?? [];
  if (!Array.isArray(appsIn)) {
    throw new TypeError('WebosConfig.apps must be an array when provided');
  }

  const seen = new Set<string>();
  const apps: AppDefinition[] = [];
  for (let i = 0; i < appsIn.length; i++) {
    const app = appsIn[i]!;
    assertApp(app, i);
    if (seen.has(app.id)) {
      throw new TypeError(`WebosConfig.apps: duplicate app id '${app.id}'`);
    }
    seen.add(app.id);
    apps.push({ ...app, instances: app.instances ?? 'single' });
  }

  const theme = { ...DEFAULT_DESKTOP_TOKENS, ...(input.theme ?? {}) };
  const wallpaper =
    input.desktop?.wallpaper ??
    (typeof theme['desktop-wallpaper'] === 'string'
      ? (theme['desktop-wallpaper'] as string)
      : '#0b1220');

  const displaysIn = input.desktop?.displays;
  let displays: DisplaySpec[];
  if (displaysIn === undefined) {
    displays = [];
  } else {
    if (!Array.isArray(displaysIn)) {
      throw new TypeError('WebosConfig.desktop.displays must be an array');
    }
    const ids = new Set<string>();
    displays = [];
    for (let i = 0; i < displaysIn.length; i++) {
      const d = displaysIn[i]!;
      assertDisplay(d, i);
      if (ids.has(d.id)) {
        throw new TypeError(`WebosConfig.desktop.displays: duplicate id '${d.id}'`);
      }
      ids.add(d.id);
      displays.push({ ...d });
    }
  }

  const shortcutsIn = input.shortcuts ?? {};
  const shortcuts: ShortcutMap = {};
  for (const [chord, action] of Object.entries(shortcutsIn)) {
    if (!isNonEmptyString(chord)) {
      throw new TypeError('WebosConfig.shortcuts keys must be non-empty strings');
    }
    assertAction(action, chord);
    shortcuts[chord] = action;
  }

  const taskbarHeight =
    typeof input.desktop?.taskbarHeight === 'number' && Number.isFinite(input.desktop.taskbarHeight)
      ? Math.max(0, input.desktop.taskbarHeight)
      : 40;
  const taskbarPosition = input.desktop?.taskbarPosition === 'top' ? 'top' : 'bottom';

  const wallpaperImage =
    typeof input.desktop?.wallpaperImage === 'string' && input.desktop.wallpaperImage.length > 0
      ? input.desktop.wallpaperImage
      : null;

  return {
    desktop: {
      wallpaper,
      wallpaperImage,
      displays,
      taskbarHeight,
      taskbarPosition,
    },
    theme,
    apps,
    shortcuts,
    vfs: input.vfs ?? null,
  };
}
