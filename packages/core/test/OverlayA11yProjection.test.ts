// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Scene, Entity, Group } from '../src';

class Box extends Entity {
  constructor(id: string, w = 50, h = 50) {
    super(id);
    this.width = w;
    this.height = h;
  }
  render(): void {}
  isPointInside(): boolean {
    return false;
  }
}

function makeScene() {
  const parentDiv = document.createElement('div');
  const canvas = document.createElement('canvas');
  parentDiv.appendChild(canvas);
  const scene = new Scene(canvas);
  (scene as any).isRunning = true;
  (globalThis as any).requestAnimationFrame = () => 0;
  return scene;
}

function tick(scene: Scene, t: number) {
  (scene as any).loop(t);
}

describe('overlay a11y projection', () => {
  it('projects eager interactive entities of an overlay subtree on the frame after showOverlay', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';

    const startBtn = new Box('start', 64, 40);
    startBtn.interactive = true;
    scene.add(startBtn);
    tick(scene, 16);
    expect(scene.getA11yElement('start')).toBeTruthy();

    const menu = new Group();
    menu.id = 'menu';
    menu.width = 200;
    menu.height = 300;
    const item = new Box('menu-item', 180, 30);
    item.interactive = true;
    menu.add(item);

    scene.showOverlay(menu);
    tick(scene, 32);

    expect(scene.getA11yElement('menu-item')).toBeTruthy();
    expect(scene.overlayRoot.children).toContain(menu);
  });

  it('keeps projecting overlay entries while an unrelated entity animates', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';

    const spinner = new Box('spinner', 10, 10);
    spinner.interactive = true;
    (spinner as any).hasPendingAnimations = () => true;
    scene.add(spinner);
    tick(scene, 16);

    const menu = new Group();
    menu.id = 'menu';
    menu.width = 200;
    menu.height = 300;
    const item = new Box('menu-item', 180, 30);
    item.interactive = true;
    menu.add(item);

    scene.showOverlay(menu);
    tick(scene, 32);

    expect(scene.getA11yElement('menu-item')).toBeTruthy();
  });

  it('does not project a11yProjection: never entities, even when interactive', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';

    const catcher = new Box('catcher', 800, 600);
    catcher.interactive = true;
    catcher.a11yProjection = 'never';
    scene.add(catcher);
    tick(scene, 16);

    expect(scene.getA11yElement('catcher')).toBeUndefined();
  });

  it('removes overlay mirrors when hideOverlay runs', () => {
    const scene = makeScene();
    scene.renderMode = 'onDemand';

    const menu = new Group();
    menu.id = 'menu';
    menu.width = 200;
    menu.height = 300;
    const item = new Box('menu-item', 180, 30);
    item.interactive = true;
    menu.add(item);

    scene.showOverlay(menu);
    tick(scene, 16);
    expect(scene.getA11yElement('menu-item')).toBeTruthy();

    scene.hideOverlay(menu);
    tick(scene, 32);
    expect(scene.getA11yElement('menu-item')).toBeUndefined();
    expect(scene.overlayRoot.children).not.toContain(menu);
  });
});
