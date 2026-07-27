/**
 * A11y conformance fixture: one scene containing every component that projects a
 * semantic node, laid out so nothing overlaps and each control is reachable.
 *
 * This exists because VectoJS documents conformance across a dozen roles that has
 * never been observed end to end. The `e2e` suite drives this page in real Chrome
 * and Firefox and asserts the projected accessibility tree, tab order, and the
 * per-role keyboard protocol — the things a jsdom unit test cannot see because
 * they depend on the browser's own accessibility mapping and focus behaviour.
 *
 * Every entity gets a stable `id`, because the e2e assertions address elements by
 * `[data-vecto-id]` rather than by DOM position (position is what
 * `enforceA11yDomOrder` is free to change).
 */
import { Scene, Entity } from '@vectojs/core';
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Link,
  ContextMenu,
  Modal,
  RadioGroup,
  Slider,
  Tabs,
  Text,
  TextArea,
  Table,
  Toggle,
  TreeView,
  VirtualList,
} from '@vectojs/ui';

/** Records what each control reported, so the test can assert on behaviour. */
interface EventLog {
  id: string;
  type: string;
  detail?: string;
}

declare global {
  interface Window {
    __a11yFixture: {
      scene: Scene;
      events: EventLog[];
      /** Announce text into the live region, to test aria-live delivery. */
      announce(message: string): void;
      /** Scroll the virtualized list far enough to recycle every mounted row. */
      recycleRows(): void;
      openMenu(): void;
      closeMenu(): void;
      openModal(): void;
      closeModal(): Promise<void>;
    };
  }
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const scene = new Scene(canvas, { contentProjection: true });
scene.resize(canvas.width, canvas.height);

const events: EventLog[] = [];
const log = (id: string, type: string, detail?: string): void => {
  events.push({ id, type, detail });
};

// --- Column 1: simple controls ---------------------------------------------

const submit = new Button('Submit', { width: 140, height: 40 });
submit.id = 'btn-submit';
submit.x = 20;
submit.y = 20;
submit.on('click', () => log('btn-submit', 'click'));
scene.add(submit);

// A disabled Button. This used to be a local entity because `Button` had no
// disabled state at all — not visually and not semantically — which the
// conformance suite surfaced. The component now owns it, so the fixture exercises
// the real thing.
const disabled = new Button('Disabled', { width: 140, height: 40, disabled: true });
disabled.id = 'btn-disabled';
disabled.x = 20;
disabled.y = 76;
disabled.on('click', () => log('btn-disabled', 'click'));
scene.add(disabled);

const link = new Link('Documentation', { href: 'https://vectojs.org/learn/' });
link.id = 'link-docs';
link.x = 20;
link.y = 132;
scene.add(link);

const checkbox = new Checkbox({ label: 'Accept terms', checked: false });
checkbox.id = 'checkbox-terms';
checkbox.x = 20;
checkbox.y = 176;
checkbox.on('change', () => log('checkbox-terms', 'change', String(checkbox.checked)));
scene.add(checkbox);

const toggle = new Toggle({ label: 'Notifications', checked: false });
toggle.id = 'toggle-notify';
toggle.x = 20;
toggle.y = 220;
toggle.on('change', () => log('toggle-notify', 'change'));
scene.add(toggle);

// --- Column 2: value and choice controls -----------------------------------

const slider = new Slider({ width: 200, min: 0, max: 100, value: 40, label: 'Volume' });
slider.id = 'slider-volume';
slider.x = 220;
slider.y = 20;
slider.on('change', () => log('slider-volume', 'change'));
scene.add(slider);

const dropdown = new Dropdown(['Small', 'Medium', 'Large'], { width: 200, label: 'Size' });
dropdown.id = 'dropdown-size';
dropdown.x = 220;
dropdown.y = 76;
dropdown.on('change', () => log('dropdown-size', 'change'));
scene.add(dropdown);

const radios = new RadioGroup({
  options: [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' },
    { value: 'c', label: 'Option C' },
  ],
  value: 'a',
});
radios.id = 'radio-plan';
radios.x = 220;
radios.y = 140;
radios.on('change', () => log('radio-plan', 'change'));
scene.add(radios);

// --- Column 3: text entry ---------------------------------------------------

const input = new Input({ width: 220, placeholder: 'Your name', value: '' });
input.id = 'input-name';
input.x = 460;
input.y = 20;
input.on('change', () => log('input-name', 'change'));
scene.add(input);

// A required field in an invalid state, via the real `Input`. Also previously a
// local stand-in: `Input` could not express either constraint even though
// `A11yAttributes` supported both.
const required = new Input({
  width: 220,
  placeholder: 'Email',
  value: '',
  required: true,
  invalid: true,
});
required.id = 'input-email';
required.x = 460;
required.y = 76;
scene.add(required);

const textarea = new TextArea({ width: 220, height: 70, placeholder: 'Notes' });
textarea.id = 'textarea-notes';
textarea.x = 460;
textarea.y = 132;
scene.add(textarea);

// --- Column 4: composite widgets -------------------------------------------

const tabs = new Tabs({
  tabs: [
    { id: 'one', label: 'First', content: new Text('Panel one') },
    { id: 'two', label: 'Second', content: new Text('Panel two') },
    { id: 'three', label: 'Third', content: new Text('Panel three') },
  ],
  value: 'one',
  width: 260,
  height: 120,
});
tabs.id = 'tabs-main';
tabs.x = 700;
tabs.y = 20;
tabs.on('change', () => log('tabs-main', 'change'));
scene.add(tabs);

// --- Composite widgets with roving tabindex + arrow navigation -------------
// These three carry the patterns unit tests cannot verify: roving tabindex, arrow
// keys, and the grid/tree role structure assistive tech requires. Their behaviour
// was asserted only in jsdom before, which has no accessibility tree.

const tree = new TreeView({
  nodes: [
    {
      id: 'src',
      label: 'src',
      children: [
        { id: 'index', label: 'index.ts' },
        { id: 'scene', label: 'Scene.ts' },
      ],
    },
    { id: 'readme', label: 'README.md' },
  ],
  width: 220,
  height: 130,
});
tree.id = 'tree-files';
tree.x = 700;
tree.y = 160;
tree.on('change', () => log('tree-files', 'change'));
scene.add(tree);

const table = new Table({
  headers: ['Name', 'Size'],
  rows: [
    ['index.ts', '1.2 kB'],
    ['Scene.ts', '48 kB'],
    ['README.md', '3 kB'],
  ],
  width: 260,
  rowHeight: 30,
});
table.id = 'table-files';
table.x = 20;
table.y = 380;
scene.add(table);

// Opened on demand: a context menu that is always visible is not the pattern
// under test, and it would overlap the controls above.
let menu: ContextMenu | null = null;

// --- Virtualized list: focus across row recycling ---------------------------
// The fragile boundary here is recycling WHILE a row holds focus. Row entities
// are recycled out as the viewport moves, and if the focused one is torn down
// without preserving focus, a keyboard user is dropped to <body> and loses their
// position entirely. Rows are focusable so the case is reachable at all.

class ListRow extends Entity {
  constructor(
    private readonly labelText: string,
    private readonly index: number,
    private readonly total: number,
  ) {
    super(`vrow-${index}`);
    this.interactive = true;
    this.width = 240;
    this.height = 26;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  override getA11yAttributes() {
    return {
      role: 'listitem',
      label: this.labelText,
      tabIndex: 0,
      // Only the mounted window exists in the DOM, so each row states its real
      // position — otherwise this is announced as "item 3 of 12".
      posInSet: this.index + 1,
      setSize: this.total,
    };
  }
}

const ROW_COUNT = 400;
const vlist = new VirtualList<{ id: number }>({
  items: Array.from({ length: ROW_COUNT }, (_, i) => ({ id: i })),
  estimatedRowHeight: 26,
  width: 240,
  height: 130,
  renderItem: (item, index) => new ListRow(`Row ${item.id}`, index, ROW_COUNT),
});
vlist.id = 'vlist-rows';
vlist.x = 700;
vlist.y = 300;
scene.add(vlist);

// --- Static text: readable, searchable, selectable -------------------------

const caption = new Text(
  'Canvas text projected into the DOM so screen readers, Ctrl+F and text selection all work.',
  { font: '15px sans-serif', maxWidth: 420 },
);
caption.id = 'text-caption';
caption.x = 20;
caption.y = 280;
scene.add(caption);

// --- Live region ------------------------------------------------------------

/**
 * A polite live region. Announcements must reach the accessibility tree without
 * moving focus, which is the whole point of the pattern.
 */
class LiveRegion extends Entity {
  public message = '';
  constructor() {
    super('live-status');
    this.interactive = true;
    this.width = 420;
    this.height = 24;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  override getA11yAttributes() {
    return {
      role: 'status',
      live: 'polite' as const,
      label: this.message || 'Idle',
    };
  }
}
const live = new LiveRegion();
live.x = 20;
live.y = 340;
scene.add(live);

// --- Modal (created on demand, to test focus trap and restoration) ---------

let modal: Modal | null = null;

window.__a11yFixture = {
  scene,
  events,
  announce(message: string) {
    live.message = message;
    scene.markDirty();
  },
  recycleRows() {
    vlist.scrollToIndex(ROW_COUNT - 1);
  },
  openMenu() {
    if (menu) return;
    menu = new ContextMenu({
      items: [
        { label: 'Cut', shortcut: 'Ctrl+X', onClick: () => log('menu-cut', 'click') },
        { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => log('menu-copy', 'click') },
        { separator: true },
        { label: 'Paste', disabled: true },
      ],
      width: 200,
    });
    menu.id = 'menu-edit';
    menu.showAtPoint(420, 300, scene);
  },
  closeMenu() {
    if (!menu) return;
    scene.hideOverlay(menu);
    menu = null;
  },
  openModal() {
    if (modal) return;
    modal = new Modal('Confirm', { width: 320, height: 180 });
    modal.id = 'modal-confirm';
    const ok = new Button('OK', { width: 100, height: 36 });
    ok.id = 'modal-ok';
    ok.x = 20;
    ok.y = 100;
    ok.on('click', () => log('modal-ok', 'click'));
    modal.add(ok);
    // showOverlay, not add: Modal's own close() calls hideOverlay, so mounting it
    // into the main tree would leave open/close asymmetric and never exercise the
    // real path.
    scene.showOverlay(modal);
  },
  async closeModal() {
    if (!modal) return;
    // Drive the component's own close(), which is what restores focus.
    await modal.close();
    modal = null;
  },
};

scene.start();

// Signal readiness only once the semantic layer actually exists, rather than
// after a fixed number of frames: a11y sync runs inside the render loop and can
// lag the first paints, so a frame counter races an empty tree.
const waitForProjection = (): void => {
  const projected = document.querySelectorAll('[data-vecto-id]').length;
  if (projected > 0) {
    document.body.setAttribute('data-a11y-projected', String(projected));
    document.body.setAttribute('data-a11y-ready', '1');
    return;
  }
  requestAnimationFrame(waitForProjection);
};
requestAnimationFrame(waitForProjection);
