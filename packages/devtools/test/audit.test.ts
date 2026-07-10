import { describe, it, expect } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { auditScene, auditTree } from '../src/audit';

class Box extends Entity {
  constructor(id: string, w = 0, h = 0) {
    super(id);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

/** Text-like stub: audit duck-types on `.text`, never on real measurement. */
class Lbl extends Box {
  public text = 'stub label';
}

/** Named so `constructor.name === 'ScrollView'` triggers the scroll exemption. */
class ScrollView extends Box {
  constructor(id: string, w: number, h: number) {
    super(id, w, h);
    this.clipChildren = true;
  }
}

class Clipper extends Box {
  constructor(id: string, w: number, h: number) {
    super(id, w, h);
    this.clipChildren = true;
  }
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  return new Scene(canvas, { disableWindowResize: true });
}

describe('auditTree — text overflow', () => {
  it('reports text escaping its nearest sized ancestor', () => {
    const root = new Box('root');
    const card = new Box('card', 100, 40);
    const label = new Lbl('label', 150, 20); // 50px wider than the card
    card.add(label);
    root.add(card);

    const findings = auditTree(root, null);
    const overflow = findings.filter((f) => f.kind === 'text-overflow');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].entityId).toBe('label');
    expect(overflow[0].containerId).toBe('card');
    expect(overflow[0].overflow?.right).toBe(50);
    expect(overflow[0].message).toContain('escapes');
  });

  it('stays quiet within tolerance and fires just past it', () => {
    const root = new Box('root');
    const card = new Box('card', 100, 40);
    const snug = new Lbl('snug', 100.4, 20); // 0.4px — under the 0.5 default
    card.add(snug);
    root.add(card);
    expect(auditTree(root, null).filter((f) => f.kind === 'text-overflow')).toHaveLength(0);

    snug.width = 101; // 1px past
    expect(auditTree(root, null).filter((f) => f.kind === 'text-overflow')).toHaveLength(1);
  });
});

describe('auditTree — clip overflow and scroll exemption', () => {
  it('reports content escaping a non-scrollable clipping container', () => {
    const root = new Box('root');
    const clip = new Clipper('clip', 100, 100);
    const runaway = new Box('runaway', 100, 100);
    runaway.setPosition(0, 60); // 60px past the bottom edge
    clip.add(runaway);
    root.add(clip);

    const findings = auditTree(root, null).filter((f) => f.kind === 'clip-overflow');
    expect(findings).toHaveLength(1);
    expect(findings[0].overflow?.bottom).toBe(60);
  });

  it('exempts vertical escape inside scrollable containers but not horizontal', () => {
    const root = new Box('root');
    const scroll = new ScrollView('scroll', 100, 100);
    const tall = new Box('tall', 100, 500); // vertical escape = scrolling, normal
    scroll.add(tall);
    root.add(scroll);
    expect(auditTree(root, null).filter((f) => f.kind === 'clip-overflow')).toHaveLength(0);

    const wide = new Box('wide', 300, 50); // horizontal escape is still a bug
    scroll.add(wide);
    const findings = auditTree(root, null).filter((f) => f.kind === 'clip-overflow');
    expect(findings).toHaveLength(1);
    expect(findings[0].entityId).toBe('wide');
    expect(findings[0].overflow?.right).toBe(200);
  });
});

describe('auditTree — overlap', () => {
  it('reports overlapping siblings exactly once', () => {
    const root = new Box('root');
    const a = new Box('a', 100, 100);
    const b = new Box('b', 100, 100);
    b.setPosition(50, 50);
    root.add(a);
    root.add(b);

    const findings = auditTree(root, null).filter((f) => f.kind === 'overlap');
    expect(findings).toHaveLength(1);
    expect(findings[0].entityId).toBe('a');
    expect(findings[0].otherId).toBe('b');
    expect(findings[0].intersection).toEqual({ x: 50, y: 50, width: 50, height: 50 });
  });

  it('never reports parent-child containment or non-sibling cousins', () => {
    const root = new Box('root');
    const parent = new Box('p', 200, 200);
    const child = new Box('c', 100, 100); // fully inside parent
    parent.add(child);
    const uncle = new Box('u', 50, 50);
    uncle.setPosition(300, 300); // disjoint sibling of parent
    const cousin = new Box('cz', 40, 40);
    uncle.add(cousin);
    root.add(parent);
    root.add(uncle);

    expect(auditTree(root, null).filter((f) => f.kind === 'overlap')).toHaveLength(0);
  });

  it('skips invisible entities and honors ignoreOverlap', () => {
    const root = new Box('root');
    const a = new Box('a', 100, 100);
    const b = new Box('b', 100, 100);
    root.add(a);
    root.add(b); // fully stacked

    b.opacity = 0;
    expect(auditTree(root, null).filter((f) => f.kind === 'overlap')).toHaveLength(0);

    b.opacity = 1;
    expect(auditTree(root, null).filter((f) => f.kind === 'overlap')).toHaveLength(1);
    expect(
      auditTree(root, null, { ignoreOverlap: (x, y) => x.id === 'a' && y.id === 'b' }).filter(
        (f) => f.kind === 'overlap',
      ),
    ).toHaveLength(0);
  });

  it('prunes subtrees via ignore', () => {
    const root = new Box('root');
    const a = new Box('a', 100, 100);
    const b = new Box('b', 100, 100);
    root.add(a);
    root.add(b);
    expect(
      auditTree(root, null, { ignore: (e) => e.id === 'b' }).filter((f) => f.kind === 'overlap'),
    ).toHaveLength(0);
  });
});

describe('auditScene', () => {
  it('reports viewport overflow for unconstrained entities drawn off-canvas', () => {
    const scene = makeScene();
    scene.resize(200, 200);
    const stray = new Box('stray', 100, 100);
    stray.setPosition(150, 150); // 50px past both scene edges
    scene.add(stray);

    const findings = auditScene(scene).filter((f) => f.kind === 'viewport-overflow');
    expect(findings).toHaveLength(1);
    expect(findings[0].overflow?.right).toBe(50);
    expect(findings[0].overflow?.bottom).toBe(50);
    scene.destroy();
  });

  it('excludes the overlay by default and includes it on request', () => {
    const scene = makeScene();
    scene.resize(200, 200);
    const modal = new Box('modal', 400, 400); // escapes viewport, but overlays are out-of-flow
    scene.showOverlay(modal);

    expect(auditScene(scene)).toHaveLength(0);
    const included = auditScene(scene, { includeOverlay: true });
    expect(included.some((f) => f.entityId === 'modal')).toBe(true);
    scene.destroy();
  });

  it('produces deterministic, JSON-safe, sorted output', () => {
    const scene = makeScene();
    scene.resize(200, 200);
    const a = new Box('a', 100, 100);
    const b = new Box('b', 100, 100);
    b.setPosition(20, 20);
    const card = new Box('card', 50, 20);
    const label = new Lbl('label', 90, 20);
    card.add(label);
    scene.add(a);
    scene.add(b);
    scene.add(card);

    const first = auditScene(scene);
    const second = auditScene(scene);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    const kinds = first.map((f) => f.kind);
    expect([...kinds].sort()).toEqual(kinds); // sorted by kind first
    scene.destroy();
  });
});
