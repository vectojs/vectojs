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
import { pickLabel, toGraphData } from './types';

export interface KnowledgeGraphSessionOptions {
  /** Target canvas (or any element GraphCamera/Interaction can bind to). */
  domElement: HTMLElement;
  /** Lazy data source. */
  source: KgDataSource;
  /** `'2d'` (default) uses {@link FixedZLayout} + ortho camera; `'3d'` free layout. */
  mode?: KnowledgeGraphMode;
  /** Seed entity ids for the first paint. Required unless the source can list all. */
  focusIds?: readonly NodeId[];
  /** Preferred label language. Default `en`. */
  lang?: string;
  /** Forwarded to {@link Graph3D}. */
  graphOptions?: Graph3DOptions;
  /** Forwarded to {@link GraphCamera} (mode is overridden by session mode). */
  cameraOptions?: Omit<GraphCameraOptions, 'domElement' | 'mode'>;
  /** Called when the user selects a node (or deselects with `null`). */
  onSelect?: (entity: KgEntity | null) => void;
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
 * aggregate announcer in the host (onDemand / `role="status"`) per the
 * knowledge-graph design rule in RESEARCH.md.
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
  private readonly onExpandCb?: (entity: KgEntity, added: number) => void;

  private readonly entities = new Map<NodeId, KgEntity>();
  private readonly facts: KgFact[] = [];
  private readonly factKey = new Set<string>();
  /** Node ids whose neighbors have already been fetched. */
  private readonly expanded = new Set<NodeId>();
  private readonly idToIndex = new Map<NodeId, number>();
  private readonly mode: KnowledgeGraphMode;
  private scene: THREE.Scene | null = null;
  private disposed = false;

  constructor(options: KnowledgeGraphSessionOptions) {
    this.source = options.source;
    this.lang = options.lang ?? 'en';
    this.expandOnSelect = options.expandOnSelect ?? true;
    this.onSelectCb = options.onSelect;
    this.onExpandCb = options.onExpand;
    this.mode = options.mode ?? '2d';

    this.graph = new Graph3D(options.graphOptions);
    this.camera = new GraphCamera({
      ...options.cameraOptions,
      domElement: options.domElement,
      mode: this.mode,
    });
    // Dense author→work bipartite neighborhoods explode under the generic
    // VectoForceLayout defaults (repulsion 300 + high velocityDecay → NaN by
    // ~tick 16 on a ~300-node mystery cut). 2D sessions use a calmer preset;
    // 3D keeps the stock defaults for parity with bare graph3d demos.
    this.layout =
      this.mode === '2d'
        ? new FixedZLayout({
            z: 0,
            // Calmer than stock VectoForceLayout: dense author→work stars
            // otherwise expand to 1e4+ world units (and used to NaN).
            repulsion: 25,
            linkDistance: 28,
            linkStrength: 0.15,
            velocityDecay: 0.3,
            centerStrength: 0.08,
            alphaDecay: 0.05,
            theta: 0.95,
          })
        : new VectoForceLayout();

    this.interaction = new GraphInteraction({
      graph: this.graph,
      camera: this.camera.camera,
      domElement: options.domElement,
      layout: this.layout,
      setControlsEnabled: (on) => this.camera.setEnabled(on),
      onSelect: (index) => {
        void this.handleSelect(index);
      },
    });

    if (options.focusIds?.length) {
      void this.bootstrap(options.focusIds);
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

  /** Snapshot of materialised entities (insertion order). */
  listEntities(): KgEntity[] {
    return [...this.entities.values()];
  }

  /**
   * Load seed nodes (and optionally their first-degree neighbors when
   * `expandSeeds` is true).
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
   * path). Unlike {@link bootstrap}, this also ingests every fact — the lazy
   * adapter is bypassed for edges already present in `data`.
   */
  loadSnapshot(data: KgGraphData): void {
    this.assertOpen();
    this.ingestEntities(data.entities);
    for (const f of data.facts) this.ingestFact(f);
    // Mark everyone expanded so a later select does not re-fetch the same hop.
    for (const e of data.entities) this.expanded.add(e.id);
    this.rebuildGraph();
    this.camera.fitToPositions(this.layout.positions);
  }

  /** Fetch and merge one hop around `id`. */
  async expand(id: NodeId): Promise<number> {
    this.assertOpen();
    if (this.expanded.has(id)) return 0;
    const hood = await this.source.getNeighbors(id);
    this.expanded.add(id);
    const before = this.entities.size;
    this.ingestEntities([hood.entity, ...hood.neighbors]);
    for (const f of hood.facts) this.ingestFact(f);
    const added = this.entities.size - before;
    this.rebuildGraph();
    this.layout.reheat?.(0.5);
    this.onExpandCb?.(hood.entity, added);
    return added;
  }

  /**
   * Advance the force layout one (or N) ticks and push positions to the
   * renderer. Returns whether the layout reports settled.
   */
  tick(iterations = 1): boolean {
    this.assertOpen();
    if (this.entities.size === 0) return true;
    const settled = this.layout.step(iterations);
    this.graph.applyPositions(this.layout.positions);
    return settled;
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
  }

  // ── internals ────────────────────────────────────────────────────────────

  private snapshot() {
    return { entities: [...this.entities.values()], facts: this.facts.slice() };
  }

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

  private rebuildGraph(): void {
    const data = this.snapshot();
    this.idToIndex.clear();
    let i = 0;
    for (const e of data.entities) {
      this.idToIndex.set(e.id, i);
      i += 1;
    }
    const g = toGraphData(data);
    for (const e of data.entities) {
      const idx = this.idToIndex.get(e.id);
      if (idx === undefined) continue;
      const node = g.nodes[idx];
      if (node) (node as { name?: string }).name = pickLabel(e.labels, this.lang);
    }
    this.layout.setGraph(g);
    this.graph.setGraphData(g);
    this.graph.applyPositions(this.layout.positions);
  }

  private async handleSelect(index: number | null): Promise<void> {
    if (index == null) {
      this.onSelectCb?.(null);
      return;
    }
    const entity = [...this.entities.values()][index];
    if (!entity) {
      this.onSelectCb?.(null);
      return;
    }
    this.onSelectCb?.(entity);
    if (this.expandOnSelect && !this.expanded.has(entity.id)) {
      await this.expand(entity.id);
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('KnowledgeGraphSession is disposed');
  }
}
