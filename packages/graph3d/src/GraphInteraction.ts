import * as THREE from 'three';
import type { Graph3D } from './Graph3D';
import type { GraphLayout } from './layout/GraphLayout';

export interface GraphInteractionOptions {
  /** The renderer whose node cloud is hit-tested. */
  graph: Graph3D;
  /** Camera the scene is viewed through — used to build picking rays. */
  camera: THREE.Camera;
  /**
   * Element pointer events are read from (usually the WebGL canvas). Its
   * bounding rect converts client coordinates to normalized device coords.
   */
  domElement: HTMLElement;
  /**
   * Layout driving the graph. Required for drag-to-pin: the drag writes the
   * node's new position through {@link GraphLayout.pinNode}. If the layout
   * (or its `pinNode`) is absent, picking/hover/select still work but nodes
   * are not draggable.
   */
  layout?: GraphLayout;
  /**
   * Total node count, used only to guard indices. Defaults to `Infinity`
   * (no upper guard) when omitted.
   */
  nodeCount?: number;
  /** Fired when the hovered node changes (or clears, with `null`). */
  onHover?: (nodeIndex: number | null) => void;
  /**
   * Fired on a click that did not turn into a drag — i.e. a selection.
   * `null` when the click landed on empty space (deselect).
   */
  onSelect?: (nodeIndex: number | null) => void;
  /** Fired once when a node starts being dragged. */
  onDragStart?: (nodeIndex: number) => void;
  /** Fired on every pointer move during a drag, after the node is re-pinned. */
  onDrag?: (nodeIndex: number, x: number, y: number, z: number) => void;
  /** Fired once when a drag ends (pointer released). */
  onDragEnd?: (nodeIndex: number) => void;
  /**
   * Called with `false` when a node drag begins and `true` when it ends, so
   * the host can disable its `OrbitControls` (or equivalent) for the duration
   * — otherwise the camera orbits while you drag a node. Decoupled from any
   * specific controls implementation on purpose.
   */
  setControlsEnabled?: (enabled: boolean) => void;
  /**
   * Whether a finished drag leaves the node pinned (`true`, default) or
   * releases it back to the simulation on pointer-up (`false`).
   */
  pinOnDrag?: boolean;
  /**
   * Alpha the layout is reheated to at drag start (so the graph settles
   * around the dragged node). Default 0.3. Set 0 to never reheat.
   */
  dragReheat?: number;
  /**
   * Pointer travel in pixels beyond which a press is treated as a drag rather
   * than a click/select. Default 4.
   */
  dragThreshold?: number;
}

/**
 * Turns raw pointer events over a {@link Graph3D} into hover, select, and
 * drag-to-pin interactions — the piece every interactive 3D-graph app
 * (Unisol, the website demo, …) would otherwise hand-roll around
 * `THREE.Raycaster` + `graph.pickNode`.
 *
 * It owns three pointer listeners on `domElement` and nothing else: no scene,
 * no render loop, no controls. The host keeps driving its own animation loop
 * and layout `step()`; this class only reads pointers, hit-tests, and (during
 * a drag) writes pinned positions back through the layout.
 */
export class GraphInteraction {
  private readonly graph: Graph3D;
  private readonly camera: THREE.Camera;
  private readonly domElement: HTMLElement;
  private readonly layout?: GraphLayout;
  private readonly nodeCount: number;
  private readonly options: GraphInteractionOptions;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly dragPlane = new THREE.Plane();
  private readonly planeNormal = new THREE.Vector3();
  private readonly dragPoint = new THREE.Vector3();
  private readonly nodeWorld = new THREE.Vector3();

  private hoveredIndex: number | null = null;
  /** Node under an active press; becomes a drag once the threshold is passed. */
  private pressIndex: number | null = null;
  private pressX = 0;
  private pressY = 0;
  private dragging = false;

  private readonly canPin: boolean;

  constructor(options: GraphInteractionOptions) {
    this.graph = options.graph;
    this.camera = options.camera;
    this.domElement = options.domElement;
    this.layout = options.layout;
    this.nodeCount = options.nodeCount ?? Number.POSITIVE_INFINITY;
    this.options = options;
    this.canPin = typeof this.layout?.pinNode === 'function';

    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    // pointerup is bound on window so a release outside the canvas still ends
    // the drag cleanly rather than leaving a node stuck to the cursor.
    window.addEventListener('pointerup', this.onPointerUp);
  }

  /** The currently hovered node index, or `null`. */
  public get hovered(): number | null {
    return this.hoveredIndex;
  }

  private setPointerFromEvent(event: PointerEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
  }

  private pick(event: PointerEvent): number | null {
    this.setPointerFromEvent(event);
    const index = this.graph.pickNode(this.raycaster);
    if (index === null || index >= this.nodeCount) return null;
    return index;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.dragging && this.pressIndex !== null) {
      this.updateDrag(event, this.pressIndex);
      return;
    }

    // Promote a press to a drag once the pointer has travelled far enough.
    if (this.pressIndex !== null && this.canPin) {
      const dx = event.clientX - this.pressX;
      const dy = event.clientY - this.pressY;
      const threshold = this.options.dragThreshold ?? 4;
      if (dx * dx + dy * dy >= threshold * threshold) {
        this.beginDrag(this.pressIndex);
        this.updateDrag(event, this.pressIndex);
      }
      return;
    }

    const next = this.pick(event);
    if (next !== this.hoveredIndex) {
      this.hoveredIndex = next;
      this.domElement.style.cursor = next !== null ? 'pointer' : '';
      this.options.onHover?.(next);
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    const index = this.pick(event);
    if (index === null) {
      // Press on empty space: a click here means "deselect".
      this.pressIndex = null;
      return;
    }
    this.pressIndex = index;
    this.pressX = event.clientX;
    this.pressY = event.clientY;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.dragging && this.pressIndex !== null) {
      const dragged = this.pressIndex;
      this.dragging = false;
      this.pressIndex = null;
      if (this.options.pinOnDrag === false && this.layout?.unpinNode) {
        this.layout.unpinNode(dragged);
        this.layout.reheat?.(this.options.dragReheat ?? 0.3);
      }
      this.options.setControlsEnabled?.(true);
      this.options.onDragEnd?.(dragged);
      return;
    }

    // No drag happened → this press/release is a click.
    if (this.pressIndex !== null) {
      const clicked = this.pressIndex;
      this.pressIndex = null;
      // Only count it as a click if the pointer is still over the same node.
      const stillOver = this.pick(event);
      this.options.onSelect?.(stillOver === clicked ? clicked : null);
    } else {
      // Press began on empty space and ended without dragging: deselect.
      this.options.onSelect?.(null);
    }
  };

  private beginDrag(index: number): void {
    this.dragging = true;
    this.options.setControlsEnabled?.(false);
    this.layout?.reheat?.(this.options.dragReheat ?? 0.3);
    this.options.onDragStart?.(index);
  }

  private updateDrag(event: PointerEvent, index: number): void {
    if (!this.layout?.pinNode) return;
    // Build a plane through the node, facing the camera, and read where the
    // pointer ray crosses it — the node tracks the cursor at its own depth.
    const nodePos = this.graph.getNodePosition(index, this.nodeWorld);
    if (!nodePos) return;
    this.camera.getWorldDirection(this.planeNormal);
    this.dragPlane.setFromNormalAndCoplanarPoint(this.planeNormal, nodePos);

    this.setPointerFromEvent(event);
    const hit = this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint);
    if (!hit) return;

    this.layout.pinNode(index, hit.x, hit.y, hit.z);
    this.options.onDrag?.(index, hit.x, hit.y, hit.z);
  }

  /** Remove all pointer listeners. The instance must not be used afterwards. */
  public dispose(): void {
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
  }
}
