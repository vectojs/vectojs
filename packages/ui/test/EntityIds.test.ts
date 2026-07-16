// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import {
  Overlay,
  Panel,
  PanelGroup,
  PanelResizeHandle,
  ProgressBar,
  RadioGroup,
  ScrollView,
  Stack,
  Tabs,
  TreeView,
  VirtualList,
} from '../src/index';

// These components used to pass their class name as the Entity id
// (`super('PanelGroup')`), so every instance in a scene shared ONE id — and
// Scene's a11y projection keys its shadow-element map by id. Two split
// dividers then shared a single DOM element, and pointer events routed to
// whichever entity claimed the id first (vem: dragging the editor split
// divider resized the Explorer divider instead). Ids must be unique.

class Leaf extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

const makers: Array<[string, () => Entity]> = [
  ['Stack', () => new Stack()],
  ['ScrollView', () => new ScrollView({ width: 100, height: 100 })],
  ['Overlay', () => new Overlay({ width: 100, height: 100 })],
  [
    'VirtualList',
    () =>
      new VirtualList({
        items: [1, 2],
        renderItem: () => new Leaf(),
        estimatedRowHeight: 20,
        width: 100,
        height: 100,
      }),
  ],
  ['RadioGroup', () => new RadioGroup({ options: [{ value: 'a', label: 'A' }] })],
  ['ProgressBar', () => new ProgressBar({ value: 0.5 })],
  ['Tabs', () => new Tabs({ width: 300, height: 100, tabs: [] })],
  ['TreeView', () => new TreeView({ nodes: [{ id: 'n', label: 'n' }], width: 100, height: 100 })],
  ['Panel', () => new Panel()],
  ['PanelGroup', () => new PanelGroup({ width: 100, height: 100, direction: 'horizontal' })],
  ['PanelResizeHandle', () => new PanelResizeHandle('horizontal', 4, '#000', '#fff', () => {})],
];

describe('every UI component instance owns a unique entity id', () => {
  for (const [name, make] of makers) {
    it(`${name}: two instances differ`, () => {
      expect(make().id).not.toBe(make().id);
    });
  }
});

describe('duplicate interactive components project distinct a11y elements', () => {
  it('two PanelGroups yield two divider shadow elements at their own positions', () => {
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    document.body.appendChild(host);
    const scene = new Scene(canvas);
    (scene as unknown as { isRunning: boolean }).isRunning = true;

    const makeGroup = (x: number) => {
      const g = new PanelGroup({ width: 400, height: 200, direction: 'horizontal' });
      g.x = x;
      g.addPanel(new Panel().setContent(new Leaf()));
      g.addPanel(new Panel().setContent(new Leaf()));
      return g;
    };
    const g1 = makeGroup(0);
    const g2 = makeGroup(500);
    scene.add(g1);
    scene.add(g2);

    const handles: Entity[] = [];
    const walk = (e: Entity) => {
      if (e instanceof PanelResizeHandle) handles.push(e);
      e.children.forEach(walk);
    };
    walk(g1);
    walk(g2);
    expect(handles).toHaveLength(2);
    expect(handles[0].id).not.toBe(handles[1].id);

    // Drive one a11y sync pass so shadow elements exist.
    (scene as unknown as { loop: (t: number) => void }).loop(16);

    const el1 = scene.getA11yElement(handles[0].id);
    const el2 = scene.getA11yElement(handles[1].id);
    expect(el1).toBeTruthy();
    expect(el2).toBeTruthy();
    expect(el1).not.toBe(el2);
  });
});
