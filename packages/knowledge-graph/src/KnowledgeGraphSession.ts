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
import type { KgDataSource, KgEntity, KgFact, KgGraphData, KnowledgeGraphMode } from './types';
import { pickLabel } from './types';

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
   * When true (default), a select on a node that still has unloaded edges
   * triggers {@link expand}.
   */
  expandOnSelect?: boolean;
}

/**
 * High-level session: data source → layout → Graph3D → camera → interaction.
 *
 * Owns the graph3d objects and a growing in-memory subgraph. The host still
 * owns the Three.js `WebGLRenderer` and the rAF loop — call {@link tick} each
 * frame and {@link render} with your renderer.
 *
 * Accessibility: this package does **not** project per-node DOM. Pair with an
 * aggregate announcer in the host (onDemand / `role="status"`).
 */
export class KnowledgeGraphSession {
  readonly graph: Graph3D;
  readonly camera: GraphCamera;
  readonly layout: GraphLayout;
  private interaction: GraphInteraction | null = null;

  private readonly source: KgDataSource;
  private readonly lang: string;
  private readonly expandOnSelect: boolean;
  private readonly onSelectCb?: (entity: KgEntity | null) => void;
  private readonly onHoverCb?: (entity: KgEntity | null) => void;
  private readonly onExpandCb?: (entity: KgEntity, added: number) => void;

  private readonly entities = new Map<NodeId, KgEntity>();
  private readonly facts: KgFact[] = [];
  private readonly factKey = new Set<string>();
  /** Node ids whose neighbors have already been fetched. */
  private readonly expanded = new Set<NodeId>();
  private readonly idToIndex = new Map<NodeId, number>();
  /** Index-aligned entity list for O(1) hover/select (mirrors layout order). */
  private entityByIndex: KgEntity[] = [];
  private readonly mode: KnowledgeGraphMode;
  private scene: THREE.Scene | null = null;
  private disposed = false;
  /** Last known xyz per id — warm-starts layout across expand rebuilds. */
  private readonly lastPos = new Map<NodeId, [number, number, number]>();

  constructor(options: KnowledgeGraphSessionOptions) {
    this.source = options.source;
    this.lang = options.lang ?? 'en';
    this.expandOnSelect = options.expandOnSelect ?? true;
    this.onSelectCb = options.onSelect;
    this.onHoverCb = options.onHover;
    this.onExpandCb = options.onExpand;
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

    // Getter keeps picking on the live camera after GraphCamera.setMode.
    this.interaction = new GraphInteraction({
      graph: this.graph,
      camera: () => this.camera.camera,
      domElement: options.domElement,
      layout: this.layout,
      setControlsEnabled: (on) => this.camera.setEnabled(on),
      onSelect: (index) => {
        void this.handleSelect(index);
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
    return this.entities.size;
  }

  get factCount(): number {
    return this.facts.length;
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
    const nodes = await this.source.getNodes(focusIds);
    this.ingestEntities(nodes);
    if (expandSeeds) {
      for (const id of focusIds) await this.expand(id);
    } else {
      this.rebuildGraph();
      this.camera.fitToPositions(this.layout.positions);
    }
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
    this.ingestEntities(data.entities);
    for (const f of data.facts) this.ingestFact(f);
    for (const e of data.entities) this.expanded.add(e.id);
    this.rebuildGraph();
    this.camera.fitToPositions(this.layout.positions);
  }

  /** Fetch and merge one hop around `id`. Preserves prior node positions. */
  async expand(id: NodeId): Promise<number> {
    this.assertOpen();
    if (this.expanded.has(id)) return 0;
    const hood = await this.source.getNeighbors(id);
    const before = this.entities.size;
    this.ingestEntities([hood.entity, ...hood.neighbors]);
    for (const f of hood.facts) this.ingestFact(f);
    const added = this.entities.size - before;
    // rebuildGraph first; only mark expanded after it succeeds so a throw
    // (e.g. bad link id in setGraphData) leaves the id retryable.
    this.rebuildGraph();
    this.expanded.add(id);
    this.layout.reheat?.(0.5);
    this.onExpandCb?.(hood.entity, added);
    return added;
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
    if (this.entities.size === 0) return true;
    const stillHot = this.layout.step(iterations);
    this.graph.applyPositions(this.layout.positions);
    this.capturePositions();
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
    this.layout.dispose();
    this.entities.clear();
    this.facts.length = 0;
    this.factKey.clear();
    this.expanded.clear();
    this.idToIndex.clear();
    this.entityByIndex = [];
    this.lastPos.clear();
    this.scene = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private ingestEntities(list: readonly KgEntity[]): void {
    for (const e of list) {
      const prev = this.entities.get(e.id);
      if (!prev) {
        this.entities.set(e.id, { ...e, labels: { ...e.labels } });
      } else {
        this.entities.set(e.id, {
          ...prev,
          ...e,
          labels: { ...prev.labels, ...e.labels },
        });
      }
    }
  }

  private ingestFact(f: KgFact): void {
    const key = `${f.source}|${f.predicate}|${f.target}`;
    if (this.factKey.has(key)) return;
    this.factKey.add(key);
    this.facts.push(f);
  }

  private capturePositions(): void {
    const pos = this.layout.positions;
    for (let i = 0; i < this.entityByIndex.length; i++) {
      const e = this.entityByIndex[i]!;
      const x = pos[i * 3]!;
      const y = pos[i * 3 + 1]!;
      const z = pos[i * 3 + 2]!;
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        this.lastPos.set(e.id, [x, y, z]);
      }
    }
  }

  private rebuildGraph(): void {
    // Preserve current simulation coords before tearing down the layout.
    if (this.entityByIndex.length > 0 && this.layout.positions.length >= 3) {
      this.capturePositions();
    }

    // Stable order: keep previous entities in their prior order, append newcomers.
    const next: KgEntity[] = [];
    const seen = new Set<NodeId>();
    for (const e of this.entityByIndex) {
      const cur = this.entities.get(e.id);
      if (cur) {
        next.push(cur);
        seen.add(cur.id);
      }
    }
    for (const e of this.entities.values()) {
      if (!seen.has(e.id)) next.push(e);
    }
    this.entityByIndex = next;
    this.idToIndex.clear();
    for (let i = 0; i < next.length; i++) this.idToIndex.set(next[i]!.id, i);

    // Warm-start: stamp last known x/y/z onto node seeds so setGraph does not
    // re-scatter existing nodes (expand must not jump the whole graph).
    const seeded = next.map((e) => {
      const prev = this.lastPos.get(e.id);
      const node = {
        ...e,
        name: pickLabel(e.labels, this.lang),
      } as KgEntity & { x?: number; y?: number; z?: number; name?: string };
      if (prev) {
        node.x = prev[0];
        node.y = prev[1];
        node.z = prev[2];
      }
      return node;
    });

    const g = {
      nodes: seeded,
      links: this.facts as import('@vectojs/graph3d').GraphLink[],
    };
    this.layout.setGraph(g);
    this.graph.setGraphData(g);
    this.graph.applyPositions(this.layout.positions);
    this.interaction?.setNodeCount(seeded.length);
    this.capturePositions();
  }

  private entityAt(index: number | null): KgEntity | null {
    if (index == null) return null;
    return this.entityByIndex[index] ?? null;
  }

  private handleHover(index: number | null): void {
    this.onHoverCb?.(this.entityAt(index));
  }

  private async handleSelect(index: number | null): Promise<void> {
    const entity = this.entityAt(index);
    this.onSelectCb?.(entity);
    if (entity && this.expandOnSelect && !this.expanded.has(entity.id)) {
      await this.expand(entity.id);
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('KnowledgeGraphSession is disposed');
  }
}
