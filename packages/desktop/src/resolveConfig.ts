import {
  DEFAULT_DESKTOP_TOKENS,
  type AppDefinition,
  type ResolvedWebosConfig,
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
    apps.push(app);
  }

  const theme = { ...DEFAULT_DESKTOP_TOKENS, ...(input.theme ?? {}) };
  const wallpaper =
    input.desktop?.wallpaper ??
    (typeof theme['desktop-wallpaper'] === 'string'
      ? (theme['desktop-wallpaper'] as string)
      : '#0b1220');

  const shortcuts = { ...(input.shortcuts ?? {}) };
  for (const [key, appId] of Object.entries(shortcuts)) {
    if (!isNonEmptyString(key) || !isNonEmptyString(appId)) {
      throw new TypeError('WebosConfig.shortcuts entries must be non-empty strings');
    }
  }

  return {
    desktop: {
      wallpaper,
      width: input.desktop?.width,
      height: input.desktop?.height,
    },
    theme,
    apps,
    shortcuts,
  };
}
