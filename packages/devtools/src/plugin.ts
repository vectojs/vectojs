import type { Entity, Scene } from '@vectojs/core';

/**
 * A row of key/value output contributed by a plugin inspector.
 *
 * Deliberately the same shape a component's own `getDevtoolsDescriptor()` field
 * takes, so a plugin that just forwards a descriptor does not have to translate.
 */
export interface PluginRow {
  label: string;
  value: string;
  /** Extra context shown after the value when the row has room. */
  note?: string;
}

/** A finding a plugin audit produced, mirroring the shape of a layout finding. */
export interface PluginFinding {
  /** Stable machine-readable class, e.g. `text-fallback-unexpected`. */
  kind: string;
  /** The entity the finding is about, when it belongs to one. */
  entityId?: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
}

/**
 * A tool a plugin exposes to a user or an agent, addressed by id.
 *
 * Commands are how a plugin does something rather than only reporting: reset a
 * counter, force a re-shape, dump a cache. Kept separate from inspectors so that
 * running one is an explicit act, never a side effect of opening a tab.
 */
export interface PluginCommand {
  id: string;
  label: string;
  /** Return value is stringified into the panel and returned to a caller. */
  run(context: PluginContext): unknown;
}

/** What a plugin is handed on every call: the scene and the current selection. */
export interface PluginContext {
  scene: Scene;
  /** The entity selected in the panel, or null when nothing is selected. */
  selection: Entity | null;
}

/**
 * A named readout a plugin contributes.
 *
 * `rows` is called for the selected entity when its tab is visible. Returning an
 * empty array is meaningful and rendered as such — it says "this inspector
 * applies here and found nothing", which differs from `appliesTo` returning
 * false, meaning "not relevant to this entity".
 */
export interface PluginInspector {
  /** Tab id and label. The id must be unique across plugins. */
  id: string;
  label: string;
  /** Narrow the inspector to the entities it understands. Defaults to all. */
  appliesTo?(entity: Entity): boolean;
  rows(context: PluginContext & { selection: Entity }): PluginRow[];
}

/** An audit a plugin contributes, run over the whole scene. */
export interface PluginAudit {
  id: string;
  run(context: PluginContext): PluginFinding[];
}

/**
 * A DevTools plugin.
 *
 * The point of the protocol is that `@vectojs/markdown`, `@vectojs/text`,
 * `@vectojs/graph3d` and `@vectojs/three` can contribute panels without
 * `@vectojs/devtools` depending on any of them — the alternative is a hardcoded
 * tab per package, which inverts the dependency graph and puts a debug tool in
 * the way of every new component.
 */
export interface DevtoolsPlugin {
  /** Unique plugin id, used to deregister and to namespace diagnostics. */
  id: string;
  inspectors?: PluginInspector[];
  audits?: PluginAudit[];
  commands?: PluginCommand[];
}

const registry = new Map<string, DevtoolsPlugin>();

/**
 * Register a plugin. Returns a function that deregisters it.
 *
 * Registration is module-global rather than per-panel on purpose: a plugin is
 * contributed by importing a package, which happens once, while panels are
 * created and destroyed. A panel reads the registry when it mounts and on every
 * refresh, so a plugin registered after a panel opens still appears.
 *
 * Re-registering the same id replaces the previous entry rather than throwing,
 * so a hot-reloaded module does not accumulate duplicates.
 */
export function registerDevtoolsPlugin(plugin: DevtoolsPlugin): () => void {
  registry.set(plugin.id, plugin);
  return () => {
    // Only remove it if it is still the same object: a later registration under
    // the same id owns the slot, and this teardown must not evict it.
    if (registry.get(plugin.id) === plugin) registry.delete(plugin.id);
  };
}

/** Every registered plugin, in registration order. */
export function devtoolsPlugins(): DevtoolsPlugin[] {
  return [...registry.values()];
}

/** Drop every registration. Intended for tests. */
export function clearDevtoolsPlugins(): void {
  registry.clear();
}

/**
 * The inspectors that apply to `entity`, across all plugins.
 *
 * A throwing `appliesTo` excludes that inspector rather than failing the lookup:
 * one broken plugin must not make the panel unusable for everything else.
 */
export function pluginInspectorsFor(entity: Entity | null): PluginInspector[] {
  const out: PluginInspector[] = [];
  for (const plugin of registry.values()) {
    for (const inspector of plugin.inspectors ?? []) {
      if (!entity) continue;
      try {
        if (inspector.appliesTo && !inspector.appliesTo(entity)) continue;
      } catch {
        continue;
      }
      out.push(inspector);
    }
  }
  return out;
}

/** Every inspector regardless of selection, for building the tab list. */
export function pluginInspectors(): PluginInspector[] {
  const out: PluginInspector[] = [];
  for (const plugin of registry.values()) out.push(...(plugin.inspectors ?? []));
  return out;
}

/**
 * Run one inspector, converting a thrown error into a readable row.
 *
 * A plugin reads live component state, which is exactly the state most likely to
 * be malformed while it is being debugged. Surfacing the failure in the readout
 * is more useful than an empty tab and far better than a broken panel.
 */
export function runPluginInspector(
  inspector: PluginInspector,
  context: PluginContext,
): PluginRow[] {
  if (!context.selection) return [{ label: '—', value: 'no selection' }];
  try {
    return inspector.rows({ ...context, selection: context.selection });
  } catch (error) {
    return [{ label: 'error', value: describeError(error) }];
  }
}

/** Run every registered audit, tagging findings with the plugin that produced them. */
export function runPluginAudits(context: PluginContext): PluginFinding[] {
  const out: PluginFinding[] = [];
  for (const plugin of registry.values()) {
    for (const audit of plugin.audits ?? []) {
      try {
        for (const finding of audit.run(context)) {
          out.push({ ...finding, kind: `${plugin.id}/${finding.kind}` });
        }
      } catch (error) {
        out.push({
          kind: `${plugin.id}/audit-failed`,
          message: `audit ${audit.id} threw: ${describeError(error)}`,
          severity: 'error',
        });
      }
    }
  }
  return out;
}

/** Every registered command, id-prefixed by its plugin. */
export function pluginCommands(): Array<PluginCommand & { pluginId: string }> {
  const out: Array<PluginCommand & { pluginId: string }> = [];
  for (const plugin of registry.values()) {
    for (const command of plugin.commands ?? []) out.push({ ...command, pluginId: plugin.id });
  }
  return out;
}

/**
 * Run a command by `<pluginId>/<commandId>`, or by bare command id when it is
 * unambiguous. Throws when no command matches, since a caller asking for a
 * specific tool needs to know it was not there rather than get a silent no-op.
 */
export function runPluginCommand(qualifiedId: string, context: PluginContext): unknown {
  const all = pluginCommands();
  const match =
    all.find((c) => `${c.pluginId}/${c.id}` === qualifiedId) ??
    all.find((c) => c.id === qualifiedId);
  if (!match) throw new Error(`no DevTools command matches "${qualifiedId}"`);
  return match.run(context);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
