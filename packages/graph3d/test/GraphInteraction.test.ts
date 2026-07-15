// @vitest-environment jsdom
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Graph3D } from '../src/Graph3D';
import { GraphInteraction } from '../src/GraphInteraction';
import { D3ForceLayout } from '../src/layout/D3ForceLayout';
import type { GraphData } from '../src/types';

const DATA: GraphData = {
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  links: [{ source: 'a', target: 'b' }],
};

// Node 1 sits at the origin; the others are pushed far away so a ray down the
// -Z axis through screen-center hits only node 1.
const POSITIONS = new Float32Array([
  500,
  500,
  0, // a — off screen
  0,
  0,
  0, // b — dead center
  -500,
  -500,
  0, // c — off screen
]);

/**
 * A camera looking down -Z from z=100 at the origin, plus a canvas whose
 * bounding rect is stubbed to a fixed 200×200 at the page origin. Screen
 * center (100,100) maps to NDC (0,0), i.e. a ray straight down -Z through the
 * origin — where node 1 lives.
 */
const makeRig = () => {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const domElement = document.createElement('canvas');
  domElement.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0 }) as DOMRect;

  const graph = new Graph3D({ nodeRadius: 6 });
  graph.setGraphData(DATA);
  graph.applyPositions(POSITIONS);

  return { camera, domElement, graph };
};

const pointer = (type: string, x: number, y: number): PointerEvent =>
  new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(type, {
    clientX: x,
    clientY: y,
    bubbles: true,
  }) as unknown as PointerEvent;

const CENTER = 100; // screen-center px within the 200×200 canvas
let rig: ReturnType<typeof makeRig>;

beforeEach(() => {
  rig = makeRig();
});

describe('GraphInteraction', () => {
  it('fires onHover with the node index when the pointer moves over it, and null off it', () => {
    const onHover = vi.fn();
    const interaction = new GraphInteraction({ ...rig, onHover });

    rig.domElement.dispatchEvent(pointer('pointermove', CENTER, CENTER));
    expect(onHover).toHaveBeenLastCalledWith(1);
    expect(interaction.hovered).toBe(1);

    rig.domElement.dispatchEvent(pointer('pointermove', 5, 5));
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(interaction.hovered).toBeNull();
    interaction.dispose();
  });

  it('fires onSelect with the node index on a click (down+up without moving)', () => {
    const onSelect = vi.fn();
    const interaction = new GraphInteraction({ ...rig, onSelect });

    rig.domElement.dispatchEvent(pointer('pointerdown', CENTER, CENTER));
    window.dispatchEvent(pointer('pointerup', CENTER, CENTER));
    expect(onSelect).toHaveBeenLastCalledWith(1);
    interaction.dispose();
  });

  it('fires onSelect(null) when clicking empty space', () => {
    const onSelect = vi.fn();
    const interaction = new GraphInteraction({ ...rig, onSelect });

    rig.domElement.dispatchEvent(pointer('pointerdown', 5, 5));
    window.dispatchEvent(pointer('pointerup', 5, 5));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    interaction.dispose();
  });

  it('drags a node past the threshold: pins it, toggles controls, and does not select', () => {
    const layout = new D3ForceLayout();
    layout.setGraph(DATA);
    const onSelect = vi.fn();
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    const setControlsEnabled = vi.fn();
    const interaction = new GraphInteraction({
      ...rig,
      layout,
      onSelect,
      onDragStart,
      onDragEnd,
      setControlsEnabled,
    });

    rig.domElement.dispatchEvent(pointer('pointerdown', CENTER, CENTER));
    // Move well past the 4px default threshold.
    rig.domElement.dispatchEvent(pointer('pointermove', CENTER + 40, CENTER));
    expect(onDragStart).toHaveBeenCalledWith(1);
    expect(setControlsEnabled).toHaveBeenLastCalledWith(false);

    window.dispatchEvent(pointer('pointerup', CENTER + 40, CENTER));
    expect(onDragEnd).toHaveBeenCalledWith(1);
    expect(setControlsEnabled).toHaveBeenLastCalledWith(true);
    // A drag is not a click.
    expect(onSelect).not.toHaveBeenCalled();

    // Node 1 was pinned by the drag (fx/fy/fz set), so it holds after stepping.
    const x = layout.positions[3];
    layout.step(100);
    expect(layout.positions[3]).toBeCloseTo(x);
    interaction.dispose();
  });

  it('does not drag when no layout is provided (falls back to select)', () => {
    const onSelect = vi.fn();
    const onDragStart = vi.fn();
    const interaction = new GraphInteraction({ ...rig, onSelect, onDragStart });

    rig.domElement.dispatchEvent(pointer('pointerdown', CENTER, CENTER));
    rig.domElement.dispatchEvent(pointer('pointermove', CENTER + 40, CENTER));
    expect(onDragStart).not.toHaveBeenCalled();
    interaction.dispose();
  });

  it('releases the node on drag end when pinOnDrag is false', () => {
    const layout = new D3ForceLayout();
    layout.setGraph(DATA);
    const unpinSpy = vi.spyOn(layout, 'unpinNode');
    const interaction = new GraphInteraction({ ...rig, layout, pinOnDrag: false });

    rig.domElement.dispatchEvent(pointer('pointerdown', CENTER, CENTER));
    rig.domElement.dispatchEvent(pointer('pointermove', CENTER + 40, CENTER));
    window.dispatchEvent(pointer('pointerup', CENTER + 40, CENTER));
    expect(unpinSpy).toHaveBeenCalledWith(1);
    interaction.dispose();
  });

  it('dispose removes listeners so later events are ignored', () => {
    const onHover = vi.fn();
    const interaction = new GraphInteraction({ ...rig, onHover });
    interaction.dispose();

    rig.domElement.dispatchEvent(pointer('pointermove', CENTER, CENTER));
    expect(onHover).not.toHaveBeenCalled();
  });
});
