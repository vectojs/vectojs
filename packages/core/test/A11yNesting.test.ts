// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene, Entity, A11yAttributes } from '../src';

/**
 * Composite-widget nesting in the a11y projection.
 *
 * The projection is flat by default. It nests exactly the role pairs ARIA
 * requires to be DOM-contained, because `aria-required-children` and
 * `aria-required-parent` check containment and cannot pass otherwise. These
 * tests pin the three things that make that safe: WHICH pairs nest, that
 * geometry survives the containing-block change, and that pruning still reaches
 * a mirror whose parent is no longer the root.
 */

class RoleEntity extends Entity {
  public role: string;
  public label?: string;

  constructor(id: string, role: string, label?: string) {
    super(id);
    this.role = role;
    this.label = label;
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

/** A container that never projects, like `Table`'s virtualization clip. */
class InertEntity extends Entity {
  constructor(id: string) {
    super(id);
    this.interactive = false;
    this.width = 100;
    this.height = 30;
  }
  isPointInside() {
    return false;
  }
  render() {}
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

describe('a11y projection nesting', () => {
  let canvas: HTMLCanvasElement;
  let scene: Scene;
  let t = 0;

  const tick = () => {
    (scene as any).isRunning = true;
    (scene as any)._canvasOnScreen = true;
    t += 100;
    (scene as any).loop(t);
  };

  const mirror = (id: string): HTMLElement | undefined => scene.getA11yElement(id);
  const parentRole = (id: string): string | null | undefined =>
    mirror(id)?.parentElement?.getAttribute('role');

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

  afterEach(() => {
    scene.destroy();
    canvas.remove();
  });

  describe('which pairs nest', () => {
    it('nests grid > row > gridcell', () => {
      const grid = new RoleEntity('grid', 'grid', 'Data');
      const row = new RoleEntity('row', 'row');
      const cell = new RoleEntity('cell', 'gridcell', 'a1');
      grid.add(row);
      row.add(cell);
      scene.add(grid);
      tick();

      expect(parentRole('row')).toBe('grid');
      expect(parentRole('cell')).toBe('row');
      // The grid itself stays a direct child of the projection root.
      expect(mirror('grid')!.parentElement).toBe((scene as any).a11yRoot);
    });

    it('nests tablist > tab, tree > treeitem and menu > menuitem', () => {
      const cases: [string, string][] = [
        ['tablist', 'tab'],
        ['tree', 'treeitem'],
        ['menu', 'menuitem'],
      ];
      for (const [container, child] of cases) {
        const parent = new RoleEntity(`${container}-p`, container, container);
        const kid = new RoleEntity(`${container}-c`, child, child);
        parent.add(kid);
        scene.add(parent);
      }
      tick();

      expect(parentRole('tablist-c')).toBe('tablist');
      expect(parentRole('tree-c')).toBe('tree');
      expect(parentRole('menu-c')).toBe('menu');
    });

    it('leaves radiogroup > radio flat', () => {
      // ARIA does not require radios to be DOM children of their group, so this
      // pair is deliberately absent from the containment table: nesting it would
      // be churn with no conformance gain.
      const group = new RoleEntity('group', 'radiogroup', 'Size');
      const radio = new RoleEntity('radio', 'radio', 'Small');
      group.add(radio);
      scene.add(group);
      tick();

      expect(mirror('radio')!.parentElement).toBe((scene as any).a11yRoot);
    });

    it('does not nest a role the container may not own', () => {
      // A `button` is not in `tablist`'s owned set. Nesting it would trip axe's
      // unallowed-children branch, which runs BEFORE the empty-container review
      // — a hard violation, strictly worse than staying flat.
      const tablist = new RoleEntity('tablist', 'tablist', 'Tabs');
      const button = new RoleEntity('button', 'button', 'Close');
      tablist.add(button);
      scene.add(tablist);
      tick();

      expect(mirror('button')!.parentElement).toBe((scene as any).a11yRoot);
    });

    it('reaches the container across a non-projecting ancestor', () => {
      // `Table` parents its body rows to a clip entity that is never
      // interactive, so it never projects and cannot be a container itself. The
      // row must still find the grid, or virtualized and non-virtualized rows
      // would land in different parents.
      const grid = new RoleEntity('grid', 'grid', 'Data');
      const clip = new InertEntity('clip');
      const row = new RoleEntity('row', 'row');
      grid.add(clip);
      clip.add(row);
      scene.add(grid);
      tick();

      expect(mirror('clip')).toBeUndefined();
      expect(parentRole('row')).toBe('grid');
    });

    it('keeps an overlay out of any main-tree container', () => {
      // A submenu mounts on `overlayRoot`, not on the menu that opened it, so it
      // is not an entity-tree descendant of its opener and must not end up
      // nested under it.
      //
      // The overlay walk passes `null` explicitly. Mutation-testing this showed
      // the argument is currently *equivalent* to passing the root's own
      // container, because the scene root has no role and so is never a
      // container itself — the `null` is defensive, not load-bearing today. The
      // property below is what actually matters and is worth pinning; it would
      // start failing the moment the root gained a container role.
      const menu = new RoleEntity('menu', 'menu', 'Menu');
      const item = new RoleEntity('item', 'menuitem', 'Open');
      menu.add(item);
      scene.add(menu);

      const submenu = new RoleEntity('submenu', 'menu', 'Submenu');
      scene.overlayRoot.add(submenu);
      tick();

      expect(parentRole('item')).toBe('menu');
      expect(mirror('submenu')!.parentElement).toBe((scene as any).a11yRoot);
    });
  });

  describe('geometry under nesting', () => {
    it('rebases a nested child so its on-screen box is unchanged', () => {
      const grid = new RoleEntity('grid', 'grid', 'Data');
      grid.x = 100;
      grid.y = 50;
      const row = new RoleEntity('row', 'row');
      row.x = 10;
      row.y = 30;
      grid.add(row);
      scene.add(grid);
      tick();

      // World position is (110, 80). Written as-is under a positioned parent it
      // would resolve to (210, 130) — the double-offset this rebasing exists to
      // prevent. Relative to the grid it is the child's own local offset.
      expect(mirror('grid')!.style.left).toBe('100px');
      expect(mirror('grid')!.style.top).toBe('50px');
      expect(mirror('row')!.style.left).toBe('10px');
      expect(mirror('row')!.style.top).toBe('30px');
    });

    it('divides out the parent scale rather than subtracting its translation', () => {
      // `left`/`top` are applied BEFORE the ancestor's transform, so a plain
      // world-delta would be multiplied by the parent's scale a second time.
      const grid = new RoleEntity('grid', 'grid', 'Data');
      grid.x = 100;
      grid.y = 50;
      grid.scaleX = 2;
      grid.scaleY = 2;
      const row = new RoleEntity('row', 'row');
      row.x = 10;
      row.y = 30;
      grid.add(row);
      scene.add(grid);
      tick();

      // Child world origin is (100 + 10*2, 50 + 30*2) = (120, 110); the naive
      // delta would be (20, 60). Divided by the parent's scale it is the local
      // offset, which the parent's own matrix(2,0,0,2) then scales back.
      expect(mirror('row')!.style.left).toBe('10px');
      expect(mirror('row')!.style.top).toBe('30px');
      expect(mirror('row')!.style.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    });

    it('keeps a nested child at the parent origin when the parent is degenerate', () => {
      // A zero-scale parent has no inverse. Emitting NaN would read as `left: 0`
      // and make the reading-order sort treat the element as top-left-most.
      const grid = new RoleEntity('grid', 'grid', 'Data');
      grid.x = 100;
      grid.y = 50;
      grid.scaleX = 0;
      const row = new RoleEntity('row', 'row');
      row.x = 10;
      row.y = 30;
      grid.add(row);
      scene.add(grid);
      tick();

      expect(mirror('row')!.style.left).toBe('0px');
      expect(mirror('row')!.style.top).toBe('0px');
      expect(mirror('row')!.style.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    });
  });

  describe('lifecycle', () => {
    it('prunes a nested mirror when its entity stops projecting', () => {
      // The prune sweep used to compare `el.parentNode === a11yRoot`, which is
      // false for a nested mirror — it would leak for the scene's lifetime.
      const grid = new RoleEntity('grid', 'grid', 'Data');
      const row = new RoleEntity('row', 'row');
      grid.add(row);
      scene.add(grid);
      tick();
      expect(parentRole('row')).toBe('grid');

      row.interactive = false;
      tick();

      expect(mirror('row')).toBeUndefined();
      expect(document.querySelectorAll('[data-vecto-id="row"]').length).toBe(0);
    });

    it('re-parents a nested mirror when its entity moves between containers', () => {
      // Pooled row hotspots migrate parents at runtime when a Table turns
      // virtualization on. A mirror left under its previous container reads as a
      // cell of the wrong row.
      const gridA = new RoleEntity('gridA', 'grid', 'A');
      const gridB = new RoleEntity('gridB', 'grid', 'B');
      const row = new RoleEntity('row', 'row');
      gridA.add(row);
      scene.add(gridA);
      scene.add(gridB);
      tick();
      expect(mirror('row')!.parentElement).toBe(mirror('gridA'));

      gridA.remove(row);
      gridB.add(row);
      tick();

      expect(mirror('row')!.parentElement).toBe(mirror('gridB'));
    });

    it('keeps the focus sentinel last among the root children', () => {
      const grid = new RoleEntity('grid', 'grid', 'Data');
      const row = new RoleEntity('row', 'row');
      grid.add(row);
      scene.add(grid);
      tick();

      const root = (scene as any).a11yRoot as HTMLElement;
      expect(root.lastElementChild?.hasAttribute('data-vecto-focus-sentinel')).toBe(true);
      // Nesting removed the row from the root's own child list.
      expect(root.children.length).toBe(2);
    });

    it('orders nested siblings by visual position, not insertion order', () => {
      const grid = new RoleEntity('grid', 'grid', 'Data');
      const right = new RoleEntity('right', 'gridcell', 'right');
      right.x = 200;
      const left = new RoleEntity('left', 'gridcell', 'left');
      left.x = 0;
      const row = new RoleEntity('row', 'row');
      row.width = 400;
      // Added right-then-left on purpose: reading order must come from geometry.
      row.add(right);
      row.add(left);
      grid.add(row);
      scene.add(grid);
      tick();

      const cells = [...mirror('row')!.children].map((c) => c.getAttribute('data-vecto-id'));
      expect(cells).toEqual(['left', 'right']);
    });
  });
});
