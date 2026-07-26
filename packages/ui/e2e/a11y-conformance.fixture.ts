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
import { Scene, Entity, type A11yAttributes, type IRenderer } from '@vectojs/core';
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Link,
  Modal,
  RadioGroup,
  Slider,
  Tabs,
  Text,
  TextArea,
  Toggle,
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
      openModal(): void;
      closeModal(): void;
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

/**
 * A disabled button.
 *
 * `@vectojs/ui`'s `Button` has **no** disabled state — not visually and not
 * semantically — even though `A11yAttributes` supports `disabled`. So this is a
 * local entity rather than a component, and the e2e asserts the invariant that
 * matters regardless of who implements it: whatever is drawn as unavailable must
 * project `disabled`, or sighted and screen-reader users are told opposite
 * things. Replace this with a component-level disabled state once Button grows one.
 */
class DisabledButton extends Entity {
  public isDisabled = true;
  constructor() {
    super('btn-disabled');
    this.interactive = true;
    this.width = 140;
    this.height = 40;
  }
  isPointInside(gx: number, gy: number): boolean {
    const p = this.worldToLocal(gx, gy);
    return !!p && p.x >= 0 && p.y >= 0 && p.x <= this.width && p.y <= this.height;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 6);
    r.fill(this.isDisabled ? '#334155' : '#2563eb');
    r.fillText('Disabled', 16, 26, '15px sans-serif', this.isDisabled ? '#64748b' : '#f8fafc');
  }
  override getA11yAttributes(): A11yAttributes {
    return { tag: 'button', label: 'Disabled', disabled: this.isDisabled };
  }
}
const disabled = new DisabledButton();
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

/**
 * A required field in an invalid state.
 *
 * `Input` does not expose `required`/`invalid` either, though `A11yAttributes`
 * carries both. Constraint state has to reach the accessibility tree — a red
 * border alone is invisible to a screen reader.
 */
class RequiredField extends Entity {
  constructor() {
    super('input-email');
    this.interactive = true;
    this.width = 220;
    this.height = 40;
  }
  isPointInside(gx: number, gy: number): boolean {
    const p = this.worldToLocal(gx, gy);
    return !!p && p.x >= 0 && p.y >= 0 && p.x <= this.width && p.y <= this.height;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 6);
    r.fill('#0f172a');
    r.fillText('Email (required)', 10, 26, '15px sans-serif', '#94a3b8');
  }
  override getA11yAttributes(): A11yAttributes {
    return {
      tag: 'input',
      inputType: 'email',
      label: 'Email',
      required: true,
      invalid: true,
    };
  }
}
const required = new RequiredField();
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
    scene.add(modal);
  },
  closeModal() {
    if (!modal) return;
    scene.remove(modal);
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
