/**
 * Minimal ambient typings for d3-force-3d (which ships no declarations),
 * covering only the surface D3ForceLayout consumes. Kept internal: nothing in
 * this package's public API exposes these types.
 */
declare module 'd3-force-3d' {
  export interface SimulationNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
    [key: string]: unknown;
  }

  export interface SimulationLink {
    source: string | number | SimulationNode;
    target: string | number | SimulationNode;
    [key: string]: unknown;
  }

  export interface Simulation {
    tick(iterations?: number): this;
    stop(): this;
    alpha(): number;
    alpha(value: number): this;
    alphaMin(): number;
    alphaMin(value: number): this;
    force(name: string, force: unknown | null): this;
    nodes(): SimulationNode[];
  }

  export interface LinkForce {
    id(accessor: (node: SimulationNode) => string | number): this;
    distance(value: number | ((link: SimulationLink) => number)): this;
  }

  export interface ManyBodyForce {
    strength(value: number): this;
  }

  export function forceSimulation(nodes?: SimulationNode[], numDimensions?: number): Simulation;
  export function forceLink(links?: SimulationLink[]): LinkForce;
  export function forceManyBody(): ManyBodyForce;
  export function forceCenter(x?: number, y?: number, z?: number): unknown;
}
