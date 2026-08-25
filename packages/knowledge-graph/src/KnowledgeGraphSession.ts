import {
  Graph3D,
  GraphCamera,
  GraphInteraction,
  VectoForceLayout,
  type Graph3DOptions,
  type GraphCameraOptions,
  type GraphLayout,
  type NodeId,
} from '@vectojs/graph3d';
import * as THREE from 'three';
import { FixedZLayout } from './FixedZLayout';
import { KnowledgeGraphModel } from './KnowledgeGraphModel';
import type { KgDataSource, KgEntity, KgGraphData, KnowledgeGraphMode } from './types';

export interface KnowledgeGraphSessionOptions {
  /** Target canvas (or any element GraphCamera/Interaction can bind to). */
  domElement: HTMLElement;
  /** Lazy data source. */
  source: KgDataSource;
  /** `'2d'` (default) uses {@link FixedZLayout} + ortho camera; `'3d'` free layout. */
  mode?: KnowledgeGraphMode;
  /**
   * Seed entity ids loaded in the background after construction.
   * Prefer awaiting {@link bootstrap} yourself so errors surface to the host.
   */
  focusIds?: readonly NodeId[];
  /** Preferred label language. Default `en`. */
  lang?: string;
  /** Forwarded to {@link Graph3D}. */
  graphOptions?: Graph3DOptions;
  /** Forwarded to {@link GraphCamera} (mode is overridden by session mode). */
  cameraOptions?: Omit<GraphCameraOptions, 'domElement' | 'mode'>;
  /** Called when the user selects a node (or deselects with `null`). */
  onSelect?: (entity: KgEntity | null) => void;
  /** Called when the hovered node changes (or clears, with `null`). */
  onHover?: (entity: KgEntity | null) => void;
  /** Called after each successful expand. */
  onExpand?: (entity: KgEntity, added: number) => void;
  /**
   * Called when an expand triggered by selecting a node fails, with the entity
   * that was being expanded (`null` when unknown). The session never lets
   * these failures escape as unhandled rejections; without this handler they
   * are logged via `console.error`.
   */
  onError?: (error: unknown, entity: KgEntity | null) => void;
  /**
   * When true (default), a select on a node that still has unloaded edges
   * triggers {@link expand}.
   */
  expandOnSelect?: boolean;
}

/**
 * High-level session: data source → layout → Graph3D → camera → interaction.
 *
 * Owns the graph3d objects and the layout it constructs, and holds a growing
 * in-memory subgraph in its {@link model} — the model is the **single layout
 * driver** (one `setGraph` + one `reheat` per expand); the session only mirrors
 * model state into the renderer. The host still owns the Three.js
 * `WebGLRenderer` and the rAF loop — call {@link tick} each frame and
 * {@link render} with your renderer.
 *
 * Accessibility: this package does **not** project per-node DOM. Pair with an
 * aggregate announcer in the host (onDemand / `role="status"`).
 */
export class KnowledgeGraphSession {
  /** Renderer-neutral graph state used by this Three.js adapter. */
  readonly model: KnowledgeGraphModel;
  readonly graph: Graph3D;
  readonly camera: GraphCamera;
  readonly layout: GraphLayout;
  private interaction: GraphInteraction | null = null;

  private readonly lang: string;
  private readonly expandOnSelect: boolean;
  private readonly onSelectCb?: (entity: KgEntity | null) => void;
  private readonly onHoverCb?: (entity: KgEntity | null) => void;
  private readonly onExpandCb?: (entity: KgEntity, added: number) => void;
  private readonly onErrorCb?: (error: unknown, entity: KgEntity | null) => void;

  /** Node ids whose neighbors have already been fetched. */
  private readonly expanded = new Set<NodeId>();
  /** Node ids with an expansion fetch currently in flight (select dedupe). */
  private readonly inFlightExpansions = new Set<NodeId>();
  /** Index-aligned entity list for O(1) hover/select (mirrors layout order). */
  private entityByIndex: KgEntity[] = [];
  private readonly mode: KnowledgeGraphMode;
  private scene: THREE.Scene | null = null;
  private disposed = false;

  constructor(options: KnowledgeGraphSessionOptions) {
    this.lang = options.lang ?? 'en';
    this.expandOnSelect = options.expandOnSelect ?? true;
    this.onSelectCb = options.onSelect;
    this.onHoverCb = options.onHover;
    this.onExpandCb = options.onExpand;
    this.onErrorCb = options.onError;
    this.mode = options.mode ?? '2d';

    this.graph = new Graph3D(options.graphOptions);
    this.camera = new GraphCamera({
      ...options.cameraOptions,
      domElement: options.domElement,
      mode: this.mode,
    });
    this.layout =
      this.mode === '2d'
        ? new FixedZLayout({
            z: 0,
            repulsion: 120,
            linkDistance: 55,
            linkStrength: 0.12,
            velocityDecay: 0.4,
            centerStrength: 0.015,
            alphaDecay: 0.028,
            theta: 0.9,
          })
        : new VectoForceLayout();
    this.model = new KnowledgeGraphModel({
      source: options.source,
      layout: this.layout,
      lang: this.lang,
    });

    // Getter keeps picking on the live camera after GraphCamera.setMode.
    this.interaction = new GraphInteraction({
      graph: this.graph,
      camera: () => this.camera.camera,
      domElement: options.domElement,
      layout: this.layout,
      setControlsEnabled: (on) => this.camera.setEnabled(on),
      onSelect: (index) => {
        // handleSelect is sync; background expand failures are routed to
        // onError, never left as unhandled rejections.
        this.handleSelect(index);
      },
      onHover: (index) => {
        this.handleHover(index);
      },
    });

    // Optional fire-and-forget seed load — errors go to console; prefer
    // explicit `await session.bootstrap(...)` in production hosts.
    if (options.focusIds?.length) {
      void this.bootstrap(options.focusIds).catch((err) => {
        console.error('[KnowledgeGraphSession] bootstrap failed:', err);
      });
    }
  }

  /** Attach the graph group to a host Three.js scene (idempotent). */
  attach(scene: THREE.Scene): void {
    if (this.scene === scene) return;
    if (this.scene) this.scene.remove(this.graph.group);
    this.scene = scene;
    scene.add(this.graph.group);
  }

  getMode(): KnowledgeGraphMode {
    return this.mode;
  }

  /** Current entity count in the materialised subgraph. */
  get entityCount(): number {
    return this.entityByIndex.length;
  }

  get factCount(): number {
    return this.model.factCount;
  }

  /** Snapshot of materialised entities (layout index order). */
  listEntities(): KgEntity[] {
    return this.entityByIndex.slice();
  }

  /**
   * Load seed nodes (and optionally their first-degree neighbors when
   * `expandSeeds` is true). Await this — do not rely on constructor `focusIds`.
   */
  async bootstrap(focusIds: readonly NodeId[], expandSeeds = true): Promise<void> {
    this.assertOpen();
    await this.model.bootstrap(focusIds, expandSeeds);
    // The host may dispose the session while the fetch is in flight (the
    // constructor's fire-and-forget bootstrap makes this routine); continuing
    // would drive the disposed Graph3D/camera — quiesce instead, teardown
    // owns the final state.
    if (this.disposed) return;
    this.syncFromModel();
    this.camera.fitToPositions(this.layout.positions);
  }

  /**
   * Materialise a full in-memory snapshot in one shot (demo / offline export
   * path). Unlike {@link bootstrap}, this also ingests every fact.
   *
   * All entity ids are marked expanded so select does not re-fetch hops already
   * present in the snapshot. Neighbors *outside* the snapshot are still
   * expandable only if you clear that mark yourself or omit them here.
   */
  loadSnapshot(data: KgGraphData): void {
    this.assertOpen();
    this.model.importSnapshot({
      version: 1,
      entities: data.entities,
      facts: data.facts,
      expansions: data.entities.map((e) => ({
        id: e.id,
        status: 'complete',
        loaded: data.facts.length,
      })),
    });
    this.syncFromModel();
    this.camera.fitToPositions(this.layout.positions);
  }

  /** Fetch and merge one hop around `id`. Preserves prior node positions. */
  async expand(id: NodeId): Promise<number> {
    this.assertOpen();
    // The model drives the layout here (setGraph + reheat); the session only
    // mirrors the result into the renderer.
    const result = await this.model.expand(id);
    // Post-await disposal check, same race as bootstrap: a host disposing
    // while the fetch is in flight must not see the mirror run against the
    // torn-down graph/camera.
    if (this.disposed) return 0;
    this.syncFromModel();
    if (result.entity) this.onExpandCb?.(result.entity, result.addedEntities);
    return result.addedEntities;
  }

  /**
   * Advance the force layout one (or N) ticks and push positions to the
   * renderer.
   *
   * @returns `true` when the layout has **settled** (cooled); `false` while
   * still hot. Matches “stop the loop when tick() is true”:
   * `if (!session.tick()) requestAnimationFrame(loop)`.
   * (Inverts {@link GraphLayout.step}, which returns active/hot.)
   */
  tick(iterations = 1): boolean {
    this.assertOpen();
    if (this.entityByIndex.length === 0) return true;
    const stillHot = this.layout.step(iterations);
    // The model owns warm-start bookkeeping; keep its position cache current
    // so the next expand does not scatter settled nodes. The warm-start cache
    // only needs the settled snapshot: capturing every hot frame wrote one Map
    // entry per node per frame.
    if (!stillHot) this.model.captureLayoutPositions();
    this.graph.applyPositions(this.layout.positions);
    return !stillHot;
  }

  /** Convenience render through a host WebGLRenderer. */
  render(renderer: THREE.WebGLRenderer, scene?: THREE.Scene): void {
    this.assertOpen();
    const s = scene ?? this.scene;
    if (!s) throw new Error('KnowledgeGraphSession.render: call attach(scene) first');
    renderer.render(s, this.camera.camera);
  }

  setSize(width: number, height: number): void {
    this.camera.setSize(width, height);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.interaction?.dispose();
    this.interaction = null;
    this.camera.dispose();
    if (this.scene) this.scene.remove(this.graph.group);
    this.graph.dispose();
    // The session constructed the layout, so it releases it — model.dispose()
    // deliberately leaves the borrowed layout untouched.
    this.layout.dispose();
    this.model.dispose();
    this.expanded.clear();
    this.inFlightExpansions.clear();
    this.entityByIndex = [];
    this.scene = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private syncFromModel(): void {
    // Defense-in-depth for late async continuations: never touch the
    // torn-down graph after dispose().
    if (this.disposed) return;
    // The model is the single layout driver and has already called setGraph:
    // mirror its canonical node order into the renderer and picking indexes.
    const data = this.model.getGraphData();
    this.entityByIndex = data.nodes as KgEntity[];
    this.expanded.clear();
    for (const entity of this.entityByIndex) {
      if (this.model.getExpansionState(entity.id).status === 'complete') {
        this.expanded.add(entity.id);
      }
    }
    this.graph.setGraphData(data);
    this.graph.applyPositions(this.layout.positions);
    this.interaction?.setNodeCount(this.entityByIndex.length);
  }

  private entityAt(index: number | null): KgEntity | null {
    if (index == null) return null;
    return this.entityByIndex[index] ?? null;
  }

  private handleHover(index: number | null): void {
    this.onHoverCb?.(this.entityAt(index));
  }

  private handleSelect(index: number | null): void {
    const entity = this.entityAt(index);
    this.onSelectCb?.(entity);
    if (entity && this.expandOnSelect && !this.expanded.has(entity.id)) {
      this.expandInBackground(entity);
    }
  }

  /**
   * Fire-and-forget expand behind a user select. Failures go to
   * {@link onError} (or `console.error` when absent) — never unhandled
   * rejections.
   *
   * One fetch per id: repeated selects on an id whose expansion is still in
   * flight return early, so onExpand/onError fire once per shared expansion
   * instead of once per click.
   */
  private expandInBackground(entity: KgEntity): void {
    if (this.inFlightExpansions.has(entity.id)) return;
    this.inFlightExpansions.add(entity.id);
    this.expand(entity.id)
      .then(
        () => undefined,
        (error: unknown) => {
          if (this.onErrorCb) {
            this.onErrorCb(error, entity);
          } else {
            console.error('[KnowledgeGraphSession] select expand failed:', error);
          }
        },
      )
      .finally(() => {
        this.inFlightExpansions.delete(entity.id);
      });
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('KnowledgeGraphSession is disposed');
  }
}
