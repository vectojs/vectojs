import { describe, it, expect } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { captureSnapshot, diffSnapshots } from '../src/snapshot';

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

class Lbl extends Box {
  public text = 'caption';
}

/** A row that declares a stable identity, as VirtualList and Table rows do. */
class Row extends Box {
  constructor(
    id: string,
    private key: string,
  ) {
    super(id, 100, 20);
  }
  override getDevtoolsDescriptor() {
    return { devtoolsKey: this.key, fields: [] };
  }
}

/** A control identified by its accessible label rather than a declared key. */
class Labelled extends Box {
  constructor(
    id: string,
    private label: string,
  ) {
    super(id, 40, 20);
  }
  override getA11yAttributes() {
    return { role: 'button', label: this.label };
  }
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  return new Scene(canvas, { disableWindowResize: true });
}

describe('captureSnapshot', () => {
  it('captures the tree with world geometry, omitting default-valued flags', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    const card = new Box('card', 100, 40);
    card.setPosition(10, 20);
    const label = new Lbl('label', 80, 20);
    label.interactive = true;
    card.add(label);
    scene.add(card);

    const snap = captureSnapshot(scene);
    expect(snap.width).toBe(400);
    expect(snap.root).toHaveLength(1);
    const cardNode = snap.root[0];
    expect(cardNode.type).toBe('Box');
    expect(cardNode.worldBounds).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(cardNode.opacity).toBeUndefined(); // 1 → omitted
    expect(cardNode.interactive).toBeUndefined(); // false → omitted
    const labelNode = cardNode.children![0];
    expect(labelNode.text).toBe('caption');
    expect(labelNode.interactive).toBe(true);
    expect(snap.overlay).toEqual([]);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    scene.destroy();
  });

  it('is deterministic: two captures of an unchanged scene are deep-equal', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    scene.add(new Box('a', 50, 50));
    scene.add(new Box('b', 60, 60));

    expect(captureSnapshot(scene)).toEqual(captureSnapshot(scene));
    scene.destroy();
  });
});

describe('diffSnapshots', () => {
  it('returns empty for identical scenes and property-level changes for moves', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    const box = new Box('m', 50, 50);
    scene.add(box);

    const before = captureSnapshot(scene);
    expect(diffSnapshots(before, captureSnapshot(scene))).toEqual([]);

    box.setPosition(30, 0);
    const diffs = diffSnapshots(before, captureSnapshot(scene));
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe('changed');
    expect(diffs[0].path).toBe('root > Box[0]');
    expect(diffs[0].changes?.x).toEqual({ from: 0, to: 30 });
    expect(diffs[0].changes?.worldBounds).toBeDefined();
    scene.destroy();
  });

  it('reports added and removed nodes by structural path, not id', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    scene.add(new Box('a', 50, 50));
    const before = captureSnapshot(scene);

    scene.add(new Lbl('late', 20, 10));
    const withAdd = diffSnapshots(before, captureSnapshot(scene));
    expect(withAdd).toHaveLength(1);
    expect(withAdd[0]).toMatchObject({ kind: 'added', path: 'root > Lbl[1]' });

    const removed = diffSnapshots(captureSnapshot(scene), before);
    expect(removed).toHaveLength(1);
    expect(removed[0].kind).toBe('removed');
    scene.destroy();
  });
});

describe('keyed diffing', () => {
  it('attributes a head insertion to the right nodes', () => {
    const scene = makeScene();
    scene.resize(400, 600);
    for (let i = 0; i < 20; i++) {
      const row = new Row(`r${i}`, `row-${i}`);
      row.text = `item ${i}`;
      row.setPosition(0, i * 20);
      scene.add(row);
    }
    const before = captureSnapshot(scene);

    // Insert at the HEAD and shift everything down: what a new item at the top
    // of a list does.
    const head = new Row('rNew', 'row-new');
    head.text = 'item NEW';
    scene.rootEntity.children.unshift(head);
    head.parent = scene.rootEntity;
    for (let i = 0; i < 20; i++) {
      scene.rootEntity.children[i + 1]!.setPosition(0, (i + 1) * 20);
    }

    const diffs = diffSnapshots(before, captureSnapshot(scene));

    // The insertion is reported AT THE HEAD. Index alignment names it `Row[20]`
    // — the tail — because that is the only index without a partner.
    const added = diffs.filter((d) => d.kind === 'added');
    expect(added).toHaveLength(1);
    expect(added[0]!.path).toBe('root > Row{k:row-new}');
    expect(diffs.filter((d) => d.kind === 'removed')).toHaveLength(0);

    // Every surviving row is recognised as itself, so the only reported change
    // is the 20px it actually moved. Index alignment instead pairs each row with
    // its neighbour and reports 20 text rewrites that never happened, which is
    // the real cost: not diff size, but a diff where every entry is wrong.
    expect(diffs.filter((d) => d.changes?.text)).toHaveLength(0);
    for (const d of diffs.filter((x) => x.kind === 'changed')) {
      expect(d.path).toMatch(/^root > Row\{k:row-\d+\}$/);
      expect(Object.keys(d.changes ?? {})).toEqual(['y', 'worldBounds']);
    }
    scene.destroy();
  });

  it('reports a pure reorder as no change at all', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    const a = new Row('a', 'row-a');
    const b = new Row('b', 'row-b');
    scene.add(a);
    scene.add(b);
    const before = captureSnapshot(scene);

    // Swap render order without moving anything: identity is unchanged, so a
    // keyed diff must be silent where an index diff would report two changes.
    scene.rootEntity.children.reverse();
    expect(diffSnapshots(before, captureSnapshot(scene))).toEqual([]);
    scene.destroy();
  });

  it('keys on the accessible label when no devtoolsKey is declared', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    scene.add(new Labelled('x', 'Save'));
    const snap = captureSnapshot(scene);
    expect(snap.root[0]!.key).toBe('l:Save');
    scene.destroy();
  });

  it('prefers devtoolsKey over the accessible label', () => {
    class Both extends Labelled {
      override getDevtoolsDescriptor() {
        return { devtoolsKey: 'declared', fields: [] };
      }
    }
    const scene = makeScene();
    scene.add(new Both('x', 'Save'));
    expect(captureSnapshot(scene).root[0]!.key).toBe('k:declared');
    scene.destroy();
  });

  it('does not key on drawn text, so a text edit stays one changed entry', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    const label = new Lbl('t', 20, 10);
    scene.add(label);
    const before = captureSnapshot(scene);
    expect(before.root[0]!.key).toBeUndefined();

    label.text = 'edited';
    const diffs = diffSnapshots(before, captureSnapshot(scene));
    // One `changed` carrying from/to — not a removal plus an addition, which is
    // what keying on content would have produced.
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.kind).toBe('changed');
    expect(diffs[0]!.changes?.text).toEqual({ from: 'caption', to: 'edited' });
    scene.destroy();
  });

  it('falls back to index matching when sibling keys collide', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    // Two controls with the same label: pairing by key could match either, so
    // an honest index diff is preferable to an arbitrary one.
    scene.add(new Labelled('a', 'Delete'));
    scene.add(new Labelled('b', 'Delete'));
    const before = captureSnapshot(scene);

    (scene.rootEntity.children[1] as Entity).setPosition(0, 40);
    const diffs = diffSnapshots(before, captureSnapshot(scene));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.path).toBe('root > Labelled[1]');
    scene.destroy();
  });

  it('survives a descriptor or a11y getter that throws', () => {
    class Hostile extends Box {
      override getDevtoolsDescriptor(): never {
        throw new Error('nope');
      }
      override getA11yAttributes(): never {
        throw new Error('also nope');
      }
    }
    const scene = makeScene();
    scene.add(new Hostile('h', 10, 10));
    expect(() => captureSnapshot(scene)).not.toThrow();
    expect(captureSnapshot(scene).root[0]!.key).toBeUndefined();
    scene.destroy();
  });

  it('detects a keyed removal by key, not position', () => {
    const scene = makeScene();
    scene.resize(400, 300);
    scene.add(new Row('a', 'row-a'));
    scene.add(new Row('b', 'row-b'));
    scene.add(new Row('c', 'row-c'));
    const before = captureSnapshot(scene);

    // Remove the MIDDLE row. Index alignment would call it a change to `b` plus
    // a removal of the tail.
    scene.rootEntity.children.splice(1, 1);
    const diffs = diffSnapshots(before, captureSnapshot(scene));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'removed', path: 'root > Row{k:row-b}' });
    scene.destroy();
  });
});
