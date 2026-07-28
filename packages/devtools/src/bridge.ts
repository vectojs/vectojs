import type { Entity, Scene } from '@vectojs/core';
import { auditScene } from './audit';
import { auditA11y, a11yReadingOrder, inspectA11y } from './a11yInspect';
import { highlightGeometry, type HighlightLayerKind } from './highlightGeometry';
import { explainHitTest } from './hitExplain';
import { inspectEntity } from './inspect';
import { inspectGpu } from './gpuInspect';
import { inspectMarkdownStream } from './markdownInspect';
import { buildTreeModel, pickInScene } from './model';
import {
  pluginCommands,
  pluginInspectors,
  runPluginAudits,
  runPluginCommand,
  runPluginInspector,
} from './plugin';
import { captureSnapshot, diffSnapshots, type SceneSnapshot } from './snapshot';
import { inspectText } from './textInspect';

/**
 * The wire protocol between a page-side backend and a DevTools frontend.
 *
 * Split this way so one backend serves every frontend: the in-page panel, a
 * browser extension, a Playwright test, and an agent. The alternative — each
 * consumer reaching into the scene itself — means four implementations of the same
 * queries that drift apart, and three of them unavailable to the fourth.
 *
 * Deliberately protocol-only. The in-page panel is untouched and still calls the
 * headless functions directly; nothing here rewrites the UI. That ordering is
 * intentional: a protocol validated by one real consumer is worth more than a UI
 * rebuilt around an unvalidated protocol.
 */
export const DEVTOOLS_PROTOCOL_VERSION = 1;

/** Channel tag on every message, so unrelated `postMessage` traffic is ignored. */
export const DEVTOOLS_CHANNEL = 'vectojs-devtools';

/** Every query a frontend can issue. */
export type DevtoolsMethod =
  | 'protocol.version'
  | 'tree.get'
  | 'entity.inspect'
  | 'entity.pick'
  | 'entity.highlightGeometry'
  | 'scene.audit'
  | 'entity.a11yInspect'
  | 'scene.a11yAudit'
  | 'scene.a11yOrder'
  | 'scene.snapshot'
  | 'scene.diff'
  | 'scene.frameStats'
  | 'hit.explain'
  | 'text.inspect'
  | 'markdown.stream'
  | 'gpu.inspect'
  | 'plugin.list'
  | 'plugin.rows'
  | 'plugin.audit'
  | 'command.list'
  | 'command.run';

export interface DevtoolsRequest {
  channel: typeof DEVTOOLS_CHANNEL;
  kind: 'request';
  /** Correlates a response to its request; a frontend may have several in flight. */
  id: number;
  method: DevtoolsMethod;
  params?: Record<string, unknown>;
}

export interface DevtoolsResponse {
  channel: typeof DEVTOOLS_CHANNEL;
  kind: 'response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** A backend-initiated notification, for state a frontend cannot poll cheaply. */
export interface DevtoolsEvent {
  channel: typeof DEVTOOLS_CHANNEL;
  kind: 'event';
  event: 'selection' | 'structure';
  payload?: unknown;
}

export type DevtoolsMessage = DevtoolsRequest | DevtoolsResponse | DevtoolsEvent;

/**
 * A duplex message channel.
 *
 * Abstracted so the same backend runs over `window.postMessage`, a `MessagePort`,
 * an extension port, or a direct in-process pair — which is also what makes the
 * protocol testable without a browser.
 */
export interface DevtoolsTransport {
  send(message: DevtoolsMessage): void;
  subscribe(handler: (message: DevtoolsMessage, origin?: string) => void): () => void;
}

export interface DevtoolsBackendOptions {
  /**
   * Origins permitted to issue requests.
   *
   * REQUIRED for a cross-document transport. A backend answers questions about
   * the entire scene — text content, accessible names, geometry — so one that
   * replies to any sender is an information-disclosure vector reachable by any
   * frame that can post to this window. There is no permissive default: omit this
   * and cross-origin messages are refused.
   */
  allowedOrigins?: string[];
  /** Cap on entities returned by `tree.get`, so one query cannot serialize a huge scene. */
  maxTreeNodes?: number;
}

/** Default ceiling on serialized tree nodes per request. */
const DEFAULT_MAX_TREE_NODES = 5000;

function isRequest(message: DevtoolsMessage): message is DevtoolsRequest {
  return message.kind === 'request' && message.channel === DEVTOOLS_CHANNEL;
}

/**
 * Serve DevTools queries for `scene` over `transport`.
 *
 * Returns a disposer. Every handler is wrapped: a query that throws answers with
 * `ok: false` and a message rather than killing the backend, because the scenes
 * worth inspecting are the malformed ones.
 */
export function createDevtoolsBackend(
  scene: Scene,
  transport: DevtoolsTransport,
  options: DevtoolsBackendOptions = {},
): { dispose(): void } {
  const allowed = options.allowedOrigins;
  const maxNodes = options.maxTreeNodes ?? DEFAULT_MAX_TREE_NODES;
  let index = new Map<string, Entity>();
  let lastSnapshot: SceneSnapshot | null = null;

  const refreshIndex = (): Map<string, Entity> => {
    const root = buildTreeModel(scene.rootEntity);
    const overlay = buildTreeModel(scene.overlayRootEntity);
    index = root.index;
    for (const [id, entity] of overlay.index) index.set(id, entity);
    return index;
  };

  const entityFor = (params: Record<string, unknown> | undefined): Entity => {
    const id = typeof params?.entityId === 'string' ? params.entityId : null;
    if (!id) throw new Error('entityId is required');
    const found = index.get(id) ?? refreshIndex().get(id);
    if (!found) throw new Error(`no entity with id "${id}"`);
    return found;
  };

  const numberParam = (params: Record<string, unknown> | undefined, key: string): number => {
    const value = params?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${key} must be a finite number`);
    }
    return value;
  };

  const handle = (method: DevtoolsMethod, params?: Record<string, unknown>): unknown => {
    switch (method) {
      case 'protocol.version':
        return { version: DEVTOOLS_PROTOCOL_VERSION };
      case 'tree.get': {
        const root = buildTreeModel(scene.rootEntity);
        const overlay = buildTreeModel(scene.overlayRootEntity);
        index = root.index;
        for (const [id, entity] of overlay.index) index.set(id, entity);
        let remaining = maxNodes;
        // Truncation is reported, not silent: a frontend drawing a tree needs to
        // know it is looking at part of one.
        let truncated = false;
        const trim = (nodes: ReturnType<typeof buildTreeModel>['nodes']): typeof nodes =>
          nodes.flatMap((node) => {
            if (remaining <= 0) {
              truncated = true;
              return [];
            }
            remaining--;
            return [
              {
                ...node,
                children: node.children ? trim(node.children) : undefined,
              },
            ];
          });
        return {
          root: trim(root.nodes),
          overlay: trim(overlay.nodes),
          structureVersion: scene.structureVersion,
          truncated,
        };
      }
      case 'entity.inspect':
        return inspectEntity(entityFor(params));
      case 'entity.pick': {
        const hit = pickInScene(scene, numberParam(params, 'x'), numberParam(params, 'y'));
        return hit ? inspectEntity(hit) : null;
      }
      case 'entity.highlightGeometry':
        return highlightGeometry(scene, entityFor(params), {
          layers: Array.isArray(params?.layers)
            ? (params.layers as HighlightLayerKind[])
            : undefined,
          hitSampleStep:
            typeof params?.hitSampleStep === 'number' ? params.hitSampleStep : undefined,
        });
      case 'scene.audit':
        return auditScene(scene);
      case 'entity.a11yInspect':
        return inspectA11y(scene, entityFor(params));
      case 'scene.a11yAudit':
        return auditA11y(scene);
      case 'scene.a11yOrder':
        return a11yReadingOrder(scene);
      case 'scene.snapshot': {
        lastSnapshot = captureSnapshot(scene);
        return lastSnapshot;
      }
      case 'scene.diff': {
        // Diff against the previous snapshot when the caller supplies none, which
        // is the common "what changed since I last looked" question.
        const against = (params?.against as SceneSnapshot | undefined) ?? lastSnapshot;
        if (!against) throw new Error('no baseline snapshot; call scene.snapshot first');
        const current = captureSnapshot(scene);
        const diff = diffSnapshots(against, current);
        lastSnapshot = current;
        return diff;
      }
      case 'scene.frameStats':
        return scene.frameStats;
      case 'hit.explain':
        return explainHitTest(scene, numberParam(params, 'x'), numberParam(params, 'y'));
      case 'text.inspect':
        return inspectText(entityFor(params));
      case 'markdown.stream':
        return inspectMarkdownStream(entityFor(params));
      case 'gpu.inspect':
        return inspectGpu(scene);
      case 'plugin.list':
        return pluginInspectors().map((i) => ({ id: i.id, label: i.label }));
      case 'plugin.rows': {
        const id = typeof params?.inspectorId === 'string' ? params.inspectorId : null;
        const inspector = pluginInspectors().find((i) => i.id === id);
        if (!inspector) throw new Error(`no plugin inspector "${id}"`);
        const selection = params?.entityId ? entityFor(params) : null;
        return runPluginInspector(inspector, { scene, selection });
      }
      case 'plugin.audit':
        return runPluginAudits({ scene, selection: null });
      case 'command.list':
        return pluginCommands().map((c) => ({
          id: `${c.pluginId}/${c.id}`,
          label: c.label,
        }));
      case 'command.run': {
        const id = typeof params?.commandId === 'string' ? params.commandId : null;
        if (!id) throw new Error('commandId is required');
        const selection = params?.entityId ? entityFor(params) : null;
        return runPluginCommand(id, { scene, selection });
      }
      default: {
        // Exhaustive over DevtoolsMethod; reached only by a frontend speaking a
        // newer protocol, which is exactly why protocol.version exists.
        const unknown: string = method;
        throw new Error(`unknown method "${unknown}"`);
      }
    }
  };

  const unsubscribe = transport.subscribe((message, origin) => {
    if (!isRequest(message)) return;
    // An unlisted origin is refused rather than answered. Silence would be worse
    // than a refusal for the legitimate caller who misconfigured their allowlist.
    if (origin !== undefined && (!allowed || !allowed.includes(origin))) {
      transport.send({
        channel: DEVTOOLS_CHANNEL,
        kind: 'response',
        id: message.id,
        ok: false,
        error: `origin "${origin}" is not in allowedOrigins`,
      });
      return;
    }
    try {
      const result = handle(message.method, message.params);
      transport.send({
        channel: DEVTOOLS_CHANNEL,
        kind: 'response',
        id: message.id,
        ok: true,
        // Round-tripped through JSON so a handler returning a live entity
        // reference fails here, in the backend's own tests, rather than in a
        // structured-clone error inside somebody's extension.
        result: JSON.parse(JSON.stringify(result ?? null)),
      });
    } catch (error) {
      transport.send({
        channel: DEVTOOLS_CHANNEL,
        kind: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { dispose: unsubscribe };
}

/** A frontend-side client: issues requests and resolves the matching response. */
export interface DevtoolsClient {
  request<T = unknown>(method: DevtoolsMethod, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to backend-initiated events. */
  on(handler: (event: DevtoolsEvent) => void): () => void;
  dispose(): void;
}

/** How long a request waits before rejecting, so a dead backend does not hang a caller. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Create a client over `transport`. */
export function createDevtoolsClient(
  transport: DevtoolsTransport,
  options: { timeoutMs?: number } = {},
): DevtoolsClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: unknown;
    }
  >();
  const eventHandlers = new Set<(event: DevtoolsEvent) => void>();

  const unsubscribe = transport.subscribe((message) => {
    if (message.channel !== DEVTOOLS_CHANNEL) return;
    if (message.kind === 'event') {
      for (const handler of eventHandlers) handler(message);
      return;
    }
    if (message.kind !== 'response') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? 'request failed'));
  });

  return {
    request<T>(method: DevtoolsMethod, params?: Record<string, unknown>): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        transport.send({
          channel: DEVTOOLS_CHANNEL,
          kind: 'request',
          id,
          method,
          params,
        });
      });
    },
    on(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    dispose() {
      unsubscribe();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
        entry.reject(new Error('client disposed'));
      }
      pending.clear();
      eventHandlers.clear();
    },
  };
}

/**
 * A transport pair sharing no window, for tests and in-process agents.
 *
 * This is the transport the protocol is validated against: it exercises every
 * handler and every error path without a browser, an extension, or a second
 * document.
 */
export function createDirectTransportPair(): {
  backend: DevtoolsTransport;
  frontend: DevtoolsTransport;
} {
  const backendHandlers = new Set<(m: DevtoolsMessage, origin?: string) => void>();
  const frontendHandlers = new Set<(m: DevtoolsMessage, origin?: string) => void>();
  return {
    backend: {
      send: (message) => {
        for (const handler of frontendHandlers) handler(message);
      },
      subscribe: (handler) => {
        backendHandlers.add(handler);
        return () => backendHandlers.delete(handler);
      },
    },
    frontend: {
      send: (message) => {
        for (const handler of backendHandlers) handler(message);
      },
      subscribe: (handler) => {
        frontendHandlers.add(handler);
        return () => frontendHandlers.delete(handler);
      },
    },
  };
}

/**
 * A transport over `window.postMessage`, for an extension or a parent frame.
 *
 * Forwards the sender's origin so the backend can enforce its allowlist; a
 * transport that dropped the origin would make that check impossible and the
 * backend would answer anyone.
 */
export function createWindowTransport(
  target: Window,
  targetOrigin: string,
  source: Window = target,
): DevtoolsTransport {
  return {
    send: (message) => target.postMessage(message, targetOrigin),
    subscribe: (handler) => {
      const listener = (event: MessageEvent): void => {
        const data = event.data as DevtoolsMessage | undefined;
        if (!data || data.channel !== DEVTOOLS_CHANNEL) return;
        handler(data, event.origin);
      };
      source.addEventListener('message', listener as EventListener);
      return () => source.removeEventListener('message', listener as EventListener);
    },
  };
}

/** Publish a selection change to a connected frontend. */
export function publishSelection(transport: DevtoolsTransport, entity: Entity | null): void {
  transport.send({
    channel: DEVTOOLS_CHANNEL,
    kind: 'event',
    event: 'selection',
    payload: entity ? { entityId: entity.id } : null,
  });
}

/** Publish a structure change, so a frontend can re-fetch the tree. */
export function publishStructure(transport: DevtoolsTransport, structureVersion: number): void {
  transport.send({
    channel: DEVTOOLS_CHANNEL,
    kind: 'event',
    event: 'structure',
    payload: { structureVersion },
  });
}
