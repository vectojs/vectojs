// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { virtual } from '@guidepup/virtual-screen-reader';
import { Scene, Entity, A11yAttributes } from '../src';

/**
 * What a screen reader ANNOUNCES for the projected layer.
 *
 * This is tier 2 of three. The tiers exist because the matrix a canvas UI
 * actually has to work against — NVDA+Firefox, NVDA+Chrome, Narrator+Edge,
 * VoiceOver+Safari, VoiceOver+iOS, TalkBack+Android — is not reachable from
 * one Linux CI runner, and pretending otherwise produces either a permanently
 * red job or a green one that tests nothing:
 *
 * 1. **axe-core**, `packages/ui/e2e/axe-audit.e2e.ts` — rule conformance in real
 *    Chrome and Firefox. Catches invalid roles, disallowed attributes and
 *    broken containment. Says nothing about what is spoken.
 * 2. **This file** — `@guidepup/virtual-screen-reader`, a screen reader derived
 *    from the specs (ACCNAME, CORE-AAM, WAI-ARIA, HTML-AAM) rather than a
 *    driver for a real one, so it runs in jsdom with no browser and no AT.
 *    It gives assertions on reading ORDER and ANNOUNCED TEXT, which is the layer
 *    axe cannot see. Its own README is explicit that it augments rather than
 *    replaces real-AT testing, and that is exactly how it is used here.
 * 3. **Real AT** — stays a manual checklist (`docs/screen-reader-checklist.md`).
 *    `@guidepup/guidepup` can drive NVDA on Windows and VoiceOver on macOS, but
 *    both need a headed session on an OS this project does not run in CI;
 *    Narrator, TalkBack and iOS VoiceOver cannot be automated at all.
 *
 * So: a spec-level regression fails CI here, and a "does NVDA actually say
 * something sensible" question stays a human one, honestly labelled.
 */

class RoleEntity extends Entity {
  constructor(
    id: string,
    public role: string,
    public label?: string,
  ) {
    super(id);
    this.interactive = true;
    this.width = 100;
    this.height = 30;
  }
  isPointInside() {
    return true;
  }
  render() {}
  public getA11yAttributes(): A11yAttributes {
    return this.label === undefined ? { role: this.role } : { role: this.role, label: this.label };
  }
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

describe('screen reader announcement (spec-derived)', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;
  let t = 0;

  const tick = () => {
    (scene as any).isRunning = true;
    (scene as any)._canvasOnScreen = true;
    t += 100;
    (scene as any).loop(t);
  };

  /** Walk forward `steps` times, collecting what each stop announces. */
  const readForward = async (steps: number): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < steps; i++) {
      await virtual.next();
      out.push(await virtual.lastSpokenPhrase());
    }
    return out;
  };

  const startReader = async () => {
    await virtual.start({ container: (scene as any).a11yRoot as HTMLElement });
  };

  beforeEach(() => {
    t = 0;
    const ctx = fakeCtx();
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);
    scene = new Scene(canvas, { maxFPS: 0 });
    scene.renderMode = 'always';
  });

  afterEach(async () => {
    await virtual.stop();
    scene.destroy();
    canvas.remove();
  });

  it('announces a grid, its rows and their containment boundaries', async () => {
    // The point of nesting: a reader that reports "end of row" / "end of grid"
    // has understood the structure. Under a flat projection those boundaries do
    // not exist, so cells are announced as unrelated siblings of the grid.
    const grid = new RoleEntity('grid', 'grid', 'Data');
    const row = new RoleEntity('row', 'row');
    const cellA = new RoleEntity('cellA', 'gridcell', 'a1');
    const cellB = new RoleEntity('cellB', 'gridcell', 'b1');
    cellB.x = 200;
    grid.add(row);
    row.add(cellA);
    row.add(cellB);
    scene.add(grid);
    tick();

    await startReader();
    const spoken = await readForward(6);

    expect(spoken).toEqual([
      'row, a1 b1',
      'gridcell, a1',
      'gridcell, b1',
      'end of row, a1 b1',
      'end of grid, Data',
      'grid, Data',
    ]);
  });

  it('announces cells in visual order regardless of insertion order', async () => {
    // Reading order comes from geometry, not from the scene graph. Added
    // right-then-left, the reader must still say left first.
    const grid = new RoleEntity('grid', 'grid', 'Data');
    const row = new RoleEntity('row', 'row');
    row.width = 400;
    const right = new RoleEntity('right', 'gridcell', 'right cell');
    right.x = 200;
    const left = new RoleEntity('left', 'gridcell', 'left cell');
    left.x = 0;
    row.add(right);
    row.add(left);
    grid.add(row);
    scene.add(grid);
    tick();

    await startReader();
    const spoken = await readForward(3);

    expect(spoken.slice(1)).toEqual(['gridcell, left cell', 'gridcell, right cell']);
  });

  it('announces a tab and its selected state inside its tablist', async () => {
    class TabEntity extends RoleEntity {
      public selected = false;
      public override getA11yAttributes(): A11yAttributes {
        return {
          role: 'tab',
          label: this.label,
          selected: this.selected,
          tabIndex: 0,
        };
      }
    }
    const tablist = new RoleEntity('tablist', 'tablist', 'Views');
    const one = new TabEntity('one', 'tab', 'One');
    one.selected = true;
    const two = new TabEntity('two', 'tab', 'Two');
    two.x = 200;
    tablist.add(one);
    tablist.add(two);
    scene.add(tablist);
    tick();

    await startReader();
    const spoken = await readForward(3);

    // `position 1, set size 2` is computed from the DOM structure — neither tab
    // sets `posInSet`/`setSize`. Under a flat projection the reader could not
    // derive them, which is exactly why those attributes exist as a manual
    // override for virtualized sets (see `A11yAttributes.posInSet`).
    expect(spoken).toEqual([
      'tab, One, selected, position 1, set size 2',
      'tab, Two, not selected, position 2, set size 2',
      // `orientated horizontally` is the role's IMPLICIT orientation, spoken
      // even though nothing sets `aria-orientation` — a tablist defaults to
      // horizontal, a tree to vertical. Pinned so a future explicit
      // `orientation` attribute cannot silently change what is announced.
      'end of tablist, Views, orientated horizontally',
    ]);
  });

  it('announces a treeitem with its level and expanded state', async () => {
    class TreeItemEntity extends RoleEntity {
      public override getA11yAttributes(): A11yAttributes {
        return {
          role: 'treeitem',
          label: this.label,
          level: 2,
          expanded: true,
          tabIndex: 0,
        };
      }
    }
    const tree = new RoleEntity('tree', 'tree', 'Files');
    const item = new TreeItemEntity('item', 'treeitem', 'src');
    tree.add(item);
    scene.add(tree);
    tick();

    await startReader();
    const spoken = await readForward(2);

    expect(spoken).toEqual([
      'treeitem, src, expanded, level 2, position 1, set size 1',
      'end of tree, Files, orientated vertically',
    ]);
  });

  it('does not announce a pruned mirror', async () => {
    // A virtualized row that scrolls away must leave the accessibility tree, not
    // linger as a phantom stop between two real ones.
    const grid = new RoleEntity('grid', 'grid', 'Data');
    const row = new RoleEntity('row', 'row');
    const cell = new RoleEntity('cell', 'gridcell', 'gone soon');
    grid.add(row);
    row.add(cell);
    scene.add(grid);
    tick();

    cell.interactive = false;
    tick();

    await startReader();
    const spoken = await readForward(4);

    expect(spoken.join(' | ')).not.toContain('gone soon');
  });
});
