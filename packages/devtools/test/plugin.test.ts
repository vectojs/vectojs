// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { attachDevtools } from '../src/index';
import {
  clearDevtoolsPlugins,
  devtoolsPlugins,
  pluginCommands,
  pluginInspectors,
  pluginInspectorsFor,
  registerDevtoolsPlugin,
  runPluginAudits,
  runPluginCommand,
  runPluginInspector,
  type DevtoolsPlugin,
} from '../src/plugin';

class Box extends Entity {
  constructor(id: string, w = 40, h = 20) {
    super(id);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

class Special extends Box {}

function makeHost(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return new Scene(canvas, { disableWindowResize: true });
}

const simple: DevtoolsPlugin = {
  id: 'demo',
  inspectors: [
    {
      id: 'demo-info',
      label: 'Demo',
      rows: ({ selection }) => [{ label: 'id', value: selection.id }],
    },
  ],
};

afterEach(() => clearDevtoolsPlugins());

describe('registerDevtoolsPlugin', () => {
  it('registers, lists and deregisters', () => {
    const off = registerDevtoolsPlugin(simple);
    expect(devtoolsPlugins().map((p) => p.id)).toEqual(['demo']);
    off();
    expect(devtoolsPlugins()).toEqual([]);
  });

  it('replaces a re-registration of the same id instead of duplicating', () => {
    registerDevtoolsPlugin(simple);
    registerDevtoolsPlugin({ id: 'demo', inspectors: [] });
    expect(devtoolsPlugins()).toHaveLength(1);
    expect(pluginInspectors()).toHaveLength(0);
  });

  it('a stale teardown does not evict the newer registration under that id', () => {
    // A hot-reloaded module runs its old cleanup after the new module registered;
    // honouring that would silently remove a live plugin.
    const off = registerDevtoolsPlugin(simple);
    const replacement: DevtoolsPlugin = { id: 'demo', inspectors: [] };
    registerDevtoolsPlugin(replacement);
    off();
    expect(devtoolsPlugins()).toEqual([replacement]);
  });
});

describe('pluginInspectorsFor', () => {
  it('filters by appliesTo', () => {
    registerDevtoolsPlugin({
      id: 'narrow',
      inspectors: [
        {
          id: 'only-special',
          label: 'S',
          appliesTo: (e) => e instanceof Special,
          rows: () => [],
        },
      ],
    });
    expect(pluginInspectorsFor(new Special('a'))).toHaveLength(1);
    expect(pluginInspectorsFor(new Box('b'))).toHaveLength(0);
    expect(pluginInspectorsFor(null)).toHaveLength(0);
  });

  it('excludes an inspector whose appliesTo throws', () => {
    registerDevtoolsPlugin({
      id: 'hostile',
      inspectors: [
        {
          id: 'bad',
          label: 'B',
          appliesTo: () => {
            throw new Error('nope');
          },
          rows: () => [],
        },
      ],
    });
    expect(() => pluginInspectorsFor(new Box('a'))).not.toThrow();
    expect(pluginInspectorsFor(new Box('a'))).toHaveLength(0);
  });
});

describe('runPluginInspector', () => {
  it('turns a thrown error into a readable row', () => {
    const rows = runPluginInspector(
      {
        id: 'x',
        label: 'X',
        rows: () => {
          throw new Error('component state is malformed');
        },
      },
      { scene: makeHost(), selection: new Box('a') },
    );
    expect(rows).toEqual([{ label: 'error', value: 'component state is malformed' }]);
  });

  it('reports no selection rather than calling the inspector', () => {
    let called = false;
    const rows = runPluginInspector(
      {
        id: 'x',
        label: 'X',
        rows: () => {
          called = true;
          return [];
        },
      },
      { scene: makeHost(), selection: null },
    );
    expect(called).toBe(false);
    expect(rows[0]!.value).toBe('no selection');
  });
});

describe('runPluginAudits', () => {
  it('namespaces finding kinds with the plugin id', () => {
    registerDevtoolsPlugin({
      id: 'txt',
      audits: [{ id: 'a', run: () => [{ kind: 'unexpected-fallback', message: 'm' }] }],
    });
    const findings = runPluginAudits({ scene: makeHost(), selection: null });
    expect(findings[0]!.kind).toBe('txt/unexpected-fallback');
  });

  it('reports a throwing audit as a finding instead of failing the run', () => {
    registerDevtoolsPlugin({
      id: 'broken',
      audits: [
        {
          id: 'boom',
          run: () => {
            throw new Error('bad');
          },
        },
      ],
    });
    registerDevtoolsPlugin({
      id: 'ok',
      audits: [{ id: 'fine', run: () => [{ kind: 'k', message: 'm' }] }],
    });
    const findings = runPluginAudits({ scene: makeHost(), selection: null });
    expect(findings.map((f) => f.kind)).toEqual(['broken/audit-failed', 'ok/k']);
    expect(findings[0]!.message).toContain('bad');
  });
});

describe('runPluginCommand', () => {
  it('runs by qualified id and by bare id, and throws when absent', () => {
    const seen: string[] = [];
    registerDevtoolsPlugin({
      id: 'p',
      commands: [
        {
          id: 'reset',
          label: 'Reset',
          run: (ctx) => {
            seen.push(ctx.selection?.id ?? 'none');
            return 'done';
          },
        },
      ],
    });
    const scene = makeHost();
    expect(pluginCommands().map((c) => `${c.pluginId}/${c.id}`)).toEqual(['p/reset']);
    expect(runPluginCommand('p/reset', { scene, selection: new Box('a') })).toBe('done');
    expect(runPluginCommand('reset', { scene, selection: null })).toBe('done');
    expect(seen).toEqual(['a', 'none']);
    expect(() => runPluginCommand('missing', { scene, selection: null })).toThrow(/no DevTools/);
  });
});

describe('panel integration', () => {
  it('adds a tab per inspector and fills it from the selection', () => {
    registerDevtoolsPlugin(simple);
    const host = makeHost();
    const target = new Box('sel');
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    expect((panel as any).tabs.tabs.map((t: { id: string }) => t.id)).toContain('plugin:demo-info');
    // Settings stays last so a habitual target does not move as plugins load.
    const ids = (panel as any).tabs.tabs.map((t: { id: string }) => t.id);
    expect(ids[ids.length - 1]).toBe('settings');

    panel.select(target);
    expect(panel.getPluginRows('demo-info')).toEqual([{ label: 'id', value: 'sel' }]);

    panel.detach();
    host.destroy();
  });

  it('does not shrink tabs as the count grows', () => {
    // Six built-in tabs at 320px already sat near 51px each under the old
    // `contentW / count` rule; plugins made the labels unreadable.
    for (let i = 0; i < 6; i++) {
      registerDevtoolsPlugin({
        id: `p${i}`,
        inspectors: [{ id: `i${i}`, label: `T${i}`, rows: () => [] }],
      });
    }
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0, width: 320 });
    const tabs = (panel as any).tabs;
    expect(tabs.tabs.length).toBeGreaterThanOrEqual(11);
    // A fixed preferred width, not a fraction of the bar.
    expect(tabs.tabWidth ?? (panel as any).tabs._tabWidth).toBeGreaterThanOrEqual(48);
    panel.detach();
    host.destroy();
  });

  it('picks up a plugin registered after the panel mounted', () => {
    const host = makeHost();
    const target = new Box('sel');
    host.add(target);
    const panel = attachDevtools(host, { refreshInterval: 0 });
    expect((panel as any).tabs.tabs.map((t: { id: string }) => t.id)).not.toContain(
      'plugin:demo-info',
    );

    registerDevtoolsPlugin(simple);
    panel.refresh();

    const ids = (panel as any).tabs.tabs.map((t: { id: string }) => t.id);
    expect(ids).toContain('plugin:demo-info');
    expect(ids[ids.length - 1]).toBe('settings');
    panel.detach();
    host.destroy();
  });

  it('shows a plugin tab as not applicable rather than empty', () => {
    registerDevtoolsPlugin({
      id: 'narrow',
      inspectors: [
        {
          id: 'special-only',
          label: 'S',
          appliesTo: (e) => e instanceof Special,
          rows: () => [{ label: 'a', value: 'b' }],
        },
      ],
    });
    const host = makeHost();
    const plain = new Box('plain');
    host.add(plain);
    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(plain);

    const lines = (panel as any).pluginTabs.get('special-only').lines as Array<{
      text: string;
    }>;
    expect(lines[0]!.text).toContain('does not apply');
    panel.detach();
    host.destroy();
  });

  it('distinguishes an empty result from a non-applicable inspector', () => {
    registerDevtoolsPlugin({
      id: 'quiet',
      inspectors: [{ id: 'quiet-one', label: 'Q', rows: () => [] }],
    });
    const host = makeHost();
    const target = new Box('sel');
    host.add(target);
    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);

    const lines = (panel as any).pluginTabs.get('quiet-one').lines as Array<{
      text: string;
    }>;
    expect(lines[0]!.text).toContain('nothing to report');
    panel.detach();
    host.destroy();
  });

  it('merges plugin findings into the audit list', () => {
    registerDevtoolsPlugin({
      id: 'aud',
      audits: [{ id: 'a', run: () => [{ kind: 'thing', message: 'went wrong' }] }],
    });
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.audit();

    expect(panel.getPluginFindings().map((f) => f.kind)).toEqual(['aud/thing']);
    // `Tree` keeps its roots in `_roots`; the label is what a user reads.
    const labels = (panel as any).auditTree._roots ?? [];
    expect(JSON.stringify(labels)).toContain('aud/thing');
    expect(JSON.stringify(labels)).toContain('went wrong');
    panel.detach();
    host.destroy();
  });

  it('runs a command through the panel with the live selection', () => {
    let sawSelection: string | null = null;
    registerDevtoolsPlugin({
      id: 'cmd',
      commands: [
        {
          id: 'peek',
          label: 'Peek',
          run: (ctx) => {
            sawSelection = ctx.selection?.id ?? null;
            return 42;
          },
        },
      ],
    });
    const host = makeHost();
    const target = new Box('chosen');
    host.add(target);
    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);

    expect(panel.runCommand('cmd/peek')).toBe(42);
    expect(sawSelection).toBe('chosen');
    panel.detach();
    host.destroy();
  });

  it('keeps working when a plugin inspector throws on every row call', () => {
    registerDevtoolsPlugin({
      id: 'hostile',
      inspectors: [
        {
          id: 'bad-rows',
          label: 'X',
          rows: () => {
            throw new Error('kaboom');
          },
        },
      ],
    });
    const host = makeHost();
    const target = new Box('sel');
    host.add(target);
    const panel = attachDevtools(host, { refreshInterval: 0 });

    expect(() => panel.select(target)).not.toThrow();
    const lines = (panel as any).pluginTabs.get('bad-rows').lines as Array<{
      text: string;
    }>;
    expect(lines[0]!.text).toContain('kaboom');
    // The built-in readout is unaffected.
    const readout = (panel as any).detailLines.map((l: { text: string }) => l.text).join('\n');
    expect(readout).toContain('#sel');
    panel.detach();
    host.destroy();
  });
});
