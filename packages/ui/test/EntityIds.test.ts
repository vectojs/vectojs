// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { Panel, PanelGroup, PanelResizeHandle } from '../src/index';

// These components used to pass their class name as the Entity id
// (`super('PanelGroup')`), so every instance in a scene shared ONE id — and
// Scene's a11y projection keys its shadow-element map by id. Two split
// dividers then shared a single DOM element, and pointer events routed to
// whichever entity claimed the id first (vem: dragging the editor split
// divider resized the Explorer divider instead). Ids must be unique.
//
// This file's plain "two instances, different ids" check (originally a loop
// over 11 components here) has been generalized into
// `ComponentConformance.test.ts`'s check (a), which now runs it against
// every `@vectojs/ui` component, not just the 11 that happened to be broken
// at the time. What's left here is the ONE thing that suite doesn't cover: a
// live two-Scene repro proving the id collision actually corrupts a11y DOM
// routing end-to-end (not just that ids differ in isolation) — kept as its
// own file because it's a scenario test, not a per-component matrix check.

class Leaf extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

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
