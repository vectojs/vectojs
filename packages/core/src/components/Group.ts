import { Entity } from '../tree/Entity';
import type { IRenderer } from '../renderer/IRenderer';

/**
 * A transform-only container: it draws nothing itself and is invisible to
 * hit-testing, existing solely to compose one transform (`x`/`y`/`scale`/
 * `rotation`/`opacity`) onto a set of children. Instantiate directly and pass
 * children inline:
 *
 * @example
 * const toolbar = new Group(saveBtn, undoBtn, redoBtn);
 * toolbar.set({ x: 20, y: 20 });
 * scene.add(toolbar);
 *
 * `isPointInside` returns `false` so the group never becomes the pick target;
 * `Scene`'s hit-test recurses into children before testing a parent, so the
 * children remain independently interactive. `render` is a no-op — children are
 * drawn by the scene's normal tree walk under this group's accumulated
 * transform.
 */
export class Group extends Entity {
  constructor(...children: Entity[]) {
    super();
    if (children.length > 0) this.add(...children);
  }

  public isPointInside(): boolean {
    return false;
  }

  public render(_renderer: IRenderer): void {
    // Intentionally empty: a Group only composes a transform onto its children.
  }
}
