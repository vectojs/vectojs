// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import {
  createDevtoolsBackend,
  createDevtoolsClient,
  createDirectTransportPair,
  createWindowTransport,
  DEVTOOLS_CHANNEL,
  DEVTOOLS_PROTOCOL_VERSION,
  publishSelection,
  publishStructure,
  type DevtoolsMessage,
  type DevtoolsTransport,
} from '../src/bridge';
import { clearDevtoolsPlugins, registerDevtoolsPlugin } from '../src/plugin';

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

class Labelled extends Box {
  public text = 'hello';
  override getA11yAttributes() {
    return { role: 'button', label: 'Press me' };
  }
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return new Scene(canvas, { disableWindowResize: true });
}

/** A wired backend + client over the in-process transport pair. */
function connect(scene: Scene, options?: Parameters<typeof createDevtoolsBackend>[2]) {
  const { backend, frontend } = createDirectTransportPair();
  const server = createDevtoolsBackend(scene, backend, options);
  const client = createDevtoolsClient(frontend, { timeoutMs: 500 });
  return { client, server, backend, frontend };
}

describe('protocol handshake', () => {
  it('reports its version', async () => {
    const scene = makeScene();
    const { client, server } = connect(scene);
    await expect(client.request('protocol.version')).resolves.toEqual({
      version: DEVTOOLS_PROTOCOL_VERSION,
    });
    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('rejects an unknown method rather than hanging', async () => {
    const scene = makeScene();
    const { client, server } = connect(scene);
    await expect(client.request('nope' as never)).rejects.toThrow(/unknown method/);
    server.dispose();
    client.dispose();
    scene.destroy();
  });
});

describe('tree and entity queries', () => {
  it('returns the tree with its structure version', async () => {
    const scene = makeScene();
    scene.add(new Box('a'));
    scene.add(new Box('b'));
    const { client, server } = connect(scene);

    const tree = await client.request<{
      root: Array<{ id: string }>;
      structureVersion: number;
      truncated: boolean;
    }>('tree.get');
    expect(tree.root).toHaveLength(2);
    expect(tree.truncated).toBe(false);
    expect(tree.structureVersion).toBe(scene.structureVersion);

    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('reports truncation instead of silently returning part of the tree', async () => {
    const scene = makeScene();
    for (let i = 0; i < 10; i++) scene.add(new Box(`e${i}`));
    const { client, server } = connect(scene, { maxTreeNodes: 4 });

    const tree = await client.request<{ root: unknown[]; truncated: boolean }>('tree.get');
    expect(tree.root).toHaveLength(4);
    // A frontend drawing a tree must know it is looking at part of one.
    expect(tree.truncated).toBe(true);

    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('inspects an entity by id', async () => {
    const scene = makeScene();
    const target = new Box('target', 60, 30);
    target.setPosition(15, 25);
    scene.add(target);
    const { client, server } = connect(scene);

    await client.request('tree.get');
    const info = await client.request<{ id: string; x: number }>('entity.inspect', {
      entityId: 'target',
    });
    expect(info.id).toBe('target');
    expect(info.x).toBe(15);

    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('resolves an entity id without a prior tree.get', async () => {
    // The index is built lazily on a miss, so a frontend need not know the order.
    const scene = makeScene();
    scene.add(new Box('lonely'));
    const { client, server } = connect(scene);
    await expect(
      client.request<{ id: string }>('entity.inspect', { entityId: 'lonely' }),
    ).resolves.toMatchObject({ id: 'lonely' });
    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('rejects a missing entity id with a useful message', async () => {
    const scene = makeScene();
    const { client, server } = connect(scene);
    await expect(client.request('entity.inspect', { entityId: 'ghost' })).rejects.toThrow(
      /no entity with id "ghost"/,
    );
    await expect(client.request('entity.inspect')).rejects.toThrow(/entityId is required/);
    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('validates numeric params', async () => {
    const scene = makeScene();
    const { client, server } = connect(scene);
    await expect(client.request('hit.explain', { x: 'nope', y: 0 })).rejects.toThrow(
      /x must be a finite number/,
    );
    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('returns highlight geometry layers', async () => {
    const scene = makeScene();
    scene.add(new Box('g'));
    const { client, server } = connect(scene);
    const layers = await client.request<Array<{ kind: string }>>('entity.highlightGeometry', {
      entityId: 'g',
      layers: ['layout'],
    });
    expect(layers.map((l) => l.kind)).toEqual(['layout']);
    server.dispose();
    client.dispose();
    scene.destroy();
  });
});

describe('scene queries', () => {
  it('serves audits, a11y and frame stats', async () => {
    const scene = makeScene();
    scene.add(new Labelled('l'));
    const { client, server } = connect(scene);

    await expect(client.request('scene.audit')).resolves.toBeInstanceOf(Array);
    await expect(client.request('scene.a11yAudit')).resolves.toBeInstanceOf(Array);
    await expect(client.request('scene.a11yOrder')).resolves.toBeInstanceOf(Array);
    await expect(client.request('gpu.inspect')).resolves.toMatchObject({
      rendererKind: 'canvas2d',
    });
    await expect(client.request('scene.frameStats')).resolves.toHaveProperty('fps');

    const a11y = await client.request<{ accessibleName?: string }>('entity.a11yInspect', {
      entityId: 'l',
    });
    expect(a11y.accessibleName).toBe('Press me');

    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('diffs against the previous snapshot when none is supplied', async () => {
    const scene = makeScene();
    const box = new Box('m', 50, 50);
    scene.add(box);
    const { client, server } = connect(scene);

    await client.request('scene.snapshot');
    box.setPosition(30, 0);
    const diff = await client.request<Array<{ kind: string }>>('scene.diff');
    expect(diff).toHaveLength(1);
    expect(diff[0]!.kind).toBe('changed');

    // The diff advanced the baseline, so an unchanged scene is now empty.
    await expect(client.request('scene.diff')).resolves.toEqual([]);

    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('refuses to diff without a baseline', async () => {
    const scene = makeScene();
    const { client, server } = connect(scene);
    await expect(client.request('scene.diff')).rejects.toThrow(/call scene.snapshot first/);
    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('serves the text inspector through the protocol', async () => {
    const scene = makeScene();
    scene.add(new Labelled('t'));
    const { client, server } = connect(scene);
    const info = await client.request<{ baseDirection: string }>('text.inspect', {
      entityId: 't',
    });
    expect(info.baseDirection).toBe('ltr');
    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('explains a hit test', async () => {
    const scene = makeScene();
    scene.add(new Box('h', 100, 100));
    const { client, server } = connect(scene);
    const explanation = await client.request<{ candidates: unknown[] }>('hit.explain', {
      x: 10,
      y: 10,
    });
    expect(explanation).toHaveProperty('candidates');
    server.dispose();
    client.dispose();
    scene.destroy();
  });
});

describe('plugins over the bridge', () => {
  it('lists inspectors, fetches rows and runs commands', async () => {
    clearDevtoolsPlugins();
    let ran = false;
    registerDevtoolsPlugin({
      id: 'demo',
      inspectors: [
        {
          id: 'demo-info',
          label: 'Demo',
          rows: ({ selection }) => [{ label: 'id', value: selection.id }],
        },
      ],
      audits: [{ id: 'a', run: () => [{ kind: 'k', message: 'm' }] }],
      commands: [
        {
          id: 'go',
          label: 'Go',
          run: () => {
            ran = true;
            return 'done';
          },
        },
      ],
    });

    const scene = makeScene();
    scene.add(new Box('sel'));
    const { client, server } = connect(scene);

    await expect(client.request('plugin.list')).resolves.toEqual([
      { id: 'demo-info', label: 'Demo' },
    ]);
    await expect(
      client.request('plugin.rows', {
        inspectorId: 'demo-info',
        entityId: 'sel',
      }),
    ).resolves.toEqual([{ label: 'id', value: 'sel' }]);
    await expect(client.request('plugin.audit')).resolves.toEqual([
      { kind: 'demo/k', message: 'm' },
    ]);
    await expect(client.request('command.list')).resolves.toEqual([{ id: 'demo/go', label: 'Go' }]);
    await expect(client.request('command.run', { commandId: 'demo/go' })).resolves.toBe('done');
    expect(ran).toBe(true);

    server.dispose();
    client.dispose();
    scene.destroy();
    clearDevtoolsPlugins();
  });

  it('rejects an unknown inspector or command', async () => {
    clearDevtoolsPlugins();
    const scene = makeScene();
    const { client, server } = connect(scene);
    await expect(client.request('plugin.rows', { inspectorId: 'ghost' })).rejects.toThrow(
      /no plugin inspector/,
    );
    await expect(client.request('command.run', { commandId: 'ghost' })).rejects.toThrow(
      /no DevTools command/,
    );
    server.dispose();
    client.dispose();
    scene.destroy();
  });
});

describe('origin enforcement', () => {
  it('refuses a request from an unlisted origin', async () => {
    const scene = makeScene();

    // Drive the backend's handler with an origin, which is exactly what
    // createWindowTransport forwards for a cross-document sender.
    const replies: DevtoolsMessage[] = [];
    const handlers: Array<(m: DevtoolsMessage, origin?: string) => void> = [];
    const server2 = createDevtoolsBackend(
      scene,
      {
        send: (m) => replies.push(m),
        subscribe: (h) => {
          handlers.push(h);
          return () => {};
        },
      },
      { allowedOrigins: ['https://ok.test'] },
    );
    handlers[0]!(
      {
        channel: DEVTOOLS_CHANNEL,
        kind: 'request',
        id: 1,
        method: 'protocol.version',
      },
      'https://evil.test',
    );
    const refusal = replies.find((m) => m.kind === 'response');
    expect(refusal).toMatchObject({ ok: false });
    expect((refusal as { error: string }).error).toContain('evil.test');

    server2.dispose();
    scene.destroy();
  });

  it('answers a listed origin', async () => {
    const scene = makeScene();
    const replies: DevtoolsMessage[] = [];
    const handlers: Array<(m: DevtoolsMessage, origin?: string) => void> = [];
    const transport: DevtoolsTransport = {
      send: (m) => replies.push(m),
      subscribe: (h) => {
        handlers.push(h);
        return () => {};
      },
    };
    const server = createDevtoolsBackend(scene, transport, {
      allowedOrigins: ['https://ok.test'],
    });
    handlers[0]!(
      {
        channel: DEVTOOLS_CHANNEL,
        kind: 'request',
        id: 1,
        method: 'protocol.version',
      },
      'https://ok.test',
    );
    expect(replies[0]).toMatchObject({ ok: true });
    server.dispose();
    scene.destroy();
  });

  it('refuses every origin when no allowlist is configured', async () => {
    // No permissive default: a backend answers questions about the whole scene,
    // so an unconfigured one must not serve a cross-document caller.
    const scene = makeScene();
    const replies: DevtoolsMessage[] = [];
    const handlers: Array<(m: DevtoolsMessage, origin?: string) => void> = [];
    const server = createDevtoolsBackend(
      scene,
      {
        send: (m) => replies.push(m),
        subscribe: (h) => {
          handlers.push(h);
          return () => {};
        },
      },
      {},
    );
    handlers[0]!(
      {
        channel: DEVTOOLS_CHANNEL,
        kind: 'request',
        id: 1,
        method: 'protocol.version',
      },
      'https://anything.test',
    );
    expect(replies[0]).toMatchObject({ ok: false });
    server.dispose();
    scene.destroy();
  });

  it('serves an in-process caller, which has no origin', async () => {
    const scene = makeScene();
    const { client, server } = connect(scene);
    // The direct transport passes no origin, so the check does not apply — this is
    // the in-page panel and agent case.
    await expect(client.request('protocol.version')).resolves.toBeTruthy();
    server.dispose();
    client.dispose();
    scene.destroy();
  });
});

describe('client behaviour', () => {
  it('correlates concurrent requests to their own responses', async () => {
    const scene = makeScene();
    scene.add(new Box('one'));
    scene.add(new Box('two'));
    const { client, server } = connect(scene);
    await client.request('tree.get');

    const [a, b] = await Promise.all([
      client.request<{ id: string }>('entity.inspect', { entityId: 'one' }),
      client.request<{ id: string }>('entity.inspect', { entityId: 'two' }),
    ]);
    expect(a.id).toBe('one');
    expect(b.id).toBe('two');

    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('times out rather than hanging when no backend answers', async () => {
    const { frontend } = createDirectTransportPair();
    const client = createDevtoolsClient(frontend, { timeoutMs: 20 });
    await expect(client.request('protocol.version')).rejects.toThrow(/timed out/);
    client.dispose();
  });

  it('rejects pending requests on dispose', async () => {
    const { frontend } = createDirectTransportPair();
    const client = createDevtoolsClient(frontend, { timeoutMs: 5000 });
    const pending = client.request('protocol.version');
    client.dispose();
    await expect(pending).rejects.toThrow(/client disposed/);
  });

  it('delivers backend events', async () => {
    const scene = makeScene();
    const { client, server, backend } = connect(scene);
    const seen: unknown[] = [];
    client.on((event) => seen.push(event));

    publishSelection(backend, new Box('chosen'));
    publishStructure(backend, 7);

    expect(seen).toEqual([
      {
        channel: DEVTOOLS_CHANNEL,
        kind: 'event',
        event: 'selection',
        payload: { entityId: 'chosen' },
      },
      {
        channel: DEVTOOLS_CHANNEL,
        kind: 'event',
        event: 'structure',
        payload: { structureVersion: 7 },
      },
    ]);

    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('ignores traffic on other channels', async () => {
    const scene = makeScene();
    const { client, server, backend } = connect(scene);
    const seen: unknown[] = [];
    client.on((e) => seen.push(e));
    // Unrelated postMessage traffic shares the window; the channel tag is what
    // keeps the bridge from reacting to it.
    backend.send({
      channel: 'something-else',
      kind: 'event',
      event: 'selection',
    } as never);
    expect(seen).toEqual([]);
    server.dispose();
    client.dispose();
    scene.destroy();
  });

  it('stops answering after the backend is disposed', async () => {
    const scene = makeScene();
    const { client, server } = connect(scene);
    server.dispose();
    await expect(client.request('protocol.version')).rejects.toThrow(/timed out/);
    client.dispose();
    scene.destroy();
  });
});

describe('createWindowTransport', () => {
  it('forwards the sender origin so the allowlist can be enforced', () => {
    const posted: unknown[] = [];
    const fakeWindow = {
      postMessage: (m: unknown) => posted.push(m),
      addEventListener: (_type: string, listener: EventListener) => {
        (fakeWindow as { listener?: EventListener }).listener = listener;
      },
      removeEventListener: () => {},
    } as unknown as Window & { listener?: EventListener };

    const transport = createWindowTransport(fakeWindow, 'https://ok.test');
    const seen: Array<{ origin?: string }> = [];
    transport.subscribe((_m, origin) => seen.push({ origin }));

    fakeWindow.listener!(
      new MessageEvent('message', {
        data: {
          channel: DEVTOOLS_CHANNEL,
          kind: 'request',
          id: 1,
          method: 'protocol.version',
        },
        origin: 'https://caller.test',
      }),
    );
    // A transport that dropped the origin would make the backend's check
    // impossible and it would answer anyone.
    expect(seen).toEqual([{ origin: 'https://caller.test' }]);

    transport.send({
      channel: DEVTOOLS_CHANNEL,
      kind: 'event',
      event: 'structure',
    });
    expect(posted).toHaveLength(1);
  });

  it('ignores messages that are not ours', () => {
    const fakeWindow = {
      postMessage: () => {},
      addEventListener: (_t: string, l: EventListener) => {
        (fakeWindow as { listener?: EventListener }).listener = l;
      },
      removeEventListener: () => {},
    } as unknown as Window & { listener?: EventListener };
    const transport = createWindowTransport(fakeWindow, '*');
    const seen: unknown[] = [];
    transport.subscribe((m) => seen.push(m));
    fakeWindow.listener!(new MessageEvent('message', { data: { hello: 'world' } }));
    expect(seen).toEqual([]);
  });
});

describe('serialization', () => {
  it('returns JSON-safe results so a structured clone cannot fail downstream', async () => {
    const scene = makeScene();
    scene.add(new Box('a'));
    const { client, server } = connect(scene);
    const info = await client.request('entity.inspect', { entityId: 'a' });
    // Round-trips cleanly: no live entity references leaked into the response.
    expect(() => structuredClone(info)).not.toThrow();
    server.dispose();
    client.dispose();
    scene.destroy();
  });
});
