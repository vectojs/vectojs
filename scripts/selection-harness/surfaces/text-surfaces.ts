// Reference surface for the selection harness: Text (justify) + RichText
// (justify) + RTL Text. Copy this file to add a surface — mount your entities,
// then call reportSelectionAudit(scene). @vectojs/devtools' auditSceneSelection
// walks every selectable projection and reports DOM-vs-canvas drift, so the
// surface itself stays trivial. `?zoom=` applies CSS zoom for fractional scale.
import { Scene } from '@vectojs/core';
import { Text, RichText } from '@vectojs/ui';
import { reportSelectionAudit } from '../harness';

const zoom = Number(new URLSearchParams(location.search).get('zoom') ?? '1');
if (zoom !== 1) document.body.style.zoom = String(zoom);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = new Scene(canvas);

const PARA = 'VectoJS renders every glyph to a single canvas while projecting an accessible DOM.';
scene.add(
  new Text(PARA, {
    maxWidth: 300,
    lineHeight: 22,
    textAlign: 'justify',
  }).setPosition(20, 20),
);
scene.add(
  new RichText(
    [
      { text: 'VectoJS ' },
      { text: 'renders every glyph', style: { bold: true, color: '#38bdf8' } },
      { text: ' to a single canvas while projecting an accessible DOM.' },
    ],
    { maxWidth: 300, textAlign: 'justify' },
  ).setPosition(340, 20),
);
scene.add(
  new Text('مرحبا بك في VectoJS', {
    maxWidth: 220,
    lineHeight: 30,
    font: '20px sans-serif',
  }).setPosition(20, 260),
);
scene.start();

setTimeout(() => void reportSelectionAudit(scene), 500);
