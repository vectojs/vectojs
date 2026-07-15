import * as THREE from 'three';
import type { GraphData } from './types';

export interface Graph3DOptions {
  /** Base node radius before `val` scaling. Default 4. */
  nodeRadius?: number;
  /** Sphere tessellation (width/height segments). Default 12. */
  nodeSegments?: number;
  /** Fallback color for nodes that declare none. Default '#4f9cff'. */
  nodeColor?: string;
  /** Link line color. Default '#9aa4b2'. */
  linkColor?: string;
  /** Link line opacity. Default 0.35. */
  linkOpacity?: number;
}

/**
 * Instanced Three.js presentation of a graph: one `InstancedMesh` for every
 * node (per-instance color and ∛val radius scaling) plus one `LineSegments`
 * for every link, all under a single {@link group} the host adds to its
 * scene. Nothing here allocates per node beyond the shared GPU buffers, so
 * graph size costs two draw calls regardless of node count.
 *
 * Positions come from a {@link GraphLayout}-shaped `Float32Array` via
 * {@link applyPositions} — the renderer is deliberately ignorant of how they
 * were computed so layouts stay swappable (or remote, behind a worker).
 */
export class Graph3D {
  /** Root object to add to the host Three.js scene. */
  public readonly group = new THREE.Group();

  private nodeMesh: THREE.InstancedMesh | null = null;
  private linkLines: THREE.LineSegments | null = null;
  /** Node-index pairs per link, resolved once per setGraphData. */
  private linkEndpoints: Uint32Array = new Uint32Array(0);
  private nodeScales: Float32Array = new Float32Array(0);

  private readonly nodeRadius: number;
  private readonly nodeSegments: number;
  private readonly nodeColor: string;
  private readonly linkColor: string;
  private readonly linkOpacity: number;

  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchColor = new THREE.Color();

  constructor(options: Graph3DOptions = {}) {
    this.nodeRadius = options.nodeRadius ?? 4;
    this.nodeSegments = options.nodeSegments ?? 12;
    this.nodeColor = options.nodeColor ?? '#4f9cff';
    this.linkColor = options.linkColor ?? '#9aa4b2';
    this.linkOpacity = options.linkOpacity ?? 0.35;
  }

  /**
   * Rebuild GPU resources for a new graph. Instanced buffers are fixed-size,
   * so a changed node/link count means fresh meshes; styling-only changes to
   * the same topology are cheap enough to not need a separate path yet.
   * Unknown link endpoints throw rather than rendering a line to the origin.
   */
  public setGraphData(data: GraphData): void {
    this.clearMeshes();

    const nodeCount = data.nodes.length;
    const indexById = new Map<string | number, number>();
    this.nodeScales = new Float32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      indexById.set(data.nodes[i].id, i);
      this.nodeScales[i] = Math.cbrt(Math.max(data.nodes[i].val ?? 1, 0));
    }

    if (nodeCount > 0) {
      const geometry = new THREE.SphereGeometry(
        this.nodeRadius,
        this.nodeSegments,
        this.nodeSegments,
      );
      const material = new THREE.MeshLambertMaterial();
      this.nodeMesh = new THREE.InstancedMesh(geometry, material, nodeCount);
      for (let i = 0; i < nodeCount; i++) {
        this.scratchColor.set(data.nodes[i].color ?? this.nodeColor);
        this.nodeMesh.setColorAt(i, this.scratchColor);
        this.scratchMatrix.makeScale(this.nodeScales[i], this.nodeScales[i], this.nodeScales[i]);
        this.nodeMesh.setMatrixAt(i, this.scratchMatrix);
      }
      this.group.add(this.nodeMesh);
    }

    const linkCount = data.links.length;
    this.linkEndpoints = new Uint32Array(linkCount * 2);
    for (let i = 0; i < linkCount; i++) {
      const link = data.links[i];
      const sourceIndex = indexById.get(link.source);
      const targetIndex = indexById.get(link.target);
      if (sourceIndex === undefined || targetIndex === undefined) {
        throw new Error(
          `Link ${String(link.source)}→${String(link.target)} references an unknown node id`,
        );
      }
      this.linkEndpoints[i * 2] = sourceIndex;
      this.linkEndpoints[i * 2 + 1] = targetIndex;
    }

    if (linkCount > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(linkCount * 2 * 3), 3),
      );
      const material = new THREE.LineBasicMaterial({
        color: this.linkColor,
        transparent: true,
        opacity: this.linkOpacity,
      });
      this.linkLines = new THREE.LineSegments(geometry, material);
      // Endpoints move every layout tick; recomputing bounds per frame for a
      // background element is wasted work, so never frustum-cull the links.
      this.linkLines.frustumCulled = false;
      this.group.add(this.linkLines);
    }
  }

  /**
   * Write layout positions (xyz triplets in node order, e.g.
   * `GraphLayout.positions`) into the instanced node matrices and link
   * endpoints. Call after every layout step that moved something.
   */
  public applyPositions(positions: Float32Array): void {
    if (this.nodeMesh) {
      const count = this.nodeMesh.count;
      for (let i = 0; i < count; i++) {
        const scale = this.nodeScales[i];
        this.scratchMatrix.makeScale(scale, scale, scale);
        this.scratchMatrix.setPosition(
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2],
        );
        this.nodeMesh.setMatrixAt(i, this.scratchMatrix);
      }
      this.nodeMesh.instanceMatrix.needsUpdate = true;
      this.nodeMesh.computeBoundingSphere();
    }

    if (this.linkLines) {
      const attribute = this.linkLines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = attribute.array as Float32Array;
      for (let i = 0; i < this.linkEndpoints.length; i++) {
        const nodeIndex = this.linkEndpoints[i];
        array[i * 3] = positions[nodeIndex * 3];
        array[i * 3 + 1] = positions[nodeIndex * 3 + 1];
        array[i * 3 + 2] = positions[nodeIndex * 3 + 2];
      }
      attribute.needsUpdate = true;
    }
  }

  /**
   * Hit-test the node cloud with an already-configured `THREE.Raycaster`
   * (the caller sets it from camera + pointer NDC) and return the index of
   * the nearest struck node, or `null` if the ray missed every node. The
   * index is aligned with the `GraphData.nodes` array from {@link setGraphData}
   * — feed it straight to `data.nodes[i]` or {@link GraphLayout.pinNode}.
   *
   * Links are never picked: only the instanced node mesh is tested, so a ray
   * grazing a link line reports a miss.
   */
  public pickNode(raycaster: THREE.Raycaster): number | null {
    if (!this.nodeMesh) return null;
    const hit = raycaster.intersectObject(this.nodeMesh, false).find((h) => h.instanceId != null);
    return hit?.instanceId ?? null;
  }

  /**
   * Read the current world position of node `index` (as last written by
   * {@link applyPositions}) into `target`, returning it. Returns `null` if the
   * index is out of range or the node mesh does not exist. Reads straight from
   * the instance matrix, so it reflects exactly what is on screen.
   */
  public getNodePosition(index: number, target: THREE.Vector3): THREE.Vector3 | null {
    if (!this.nodeMesh || index < 0 || index >= this.nodeMesh.count) return null;
    this.nodeMesh.getMatrixAt(index, this.scratchMatrix);
    return target.setFromMatrixPosition(this.scratchMatrix);
  }

  /** Release all GPU resources and empty {@link group}. */
  public dispose(): void {
    this.clearMeshes();
  }

  private clearMeshes(): void {
    if (this.nodeMesh) {
      this.group.remove(this.nodeMesh);
      this.nodeMesh.geometry.dispose();
      (this.nodeMesh.material as THREE.Material).dispose();
      this.nodeMesh.dispose();
      this.nodeMesh = null;
    }
    if (this.linkLines) {
      this.group.remove(this.linkLines);
      this.linkLines.geometry.dispose();
      (this.linkLines.material as THREE.Material).dispose();
      this.linkLines = null;
    }
    this.linkEndpoints = new Uint32Array(0);
    this.nodeScales = new Float32Array(0);
  }
}
