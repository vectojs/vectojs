// RTL Markdown list surface: confirms list markers sit on the reading-start
// (RIGHT) side for RTL items and the LEFT for LTR, on real hardware. Also runs
// the selection audit (lists are selectable), so drive.sh gets its JSON verdict.
import { Scene } from '@vectojs/core';
import { Markdown } from '@vectojs/markdown';
import { reportSelectionAudit } from '../harness';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = new Scene(canvas);

// LTR list (markers on the left) beside an RTL Arabic list (markers on the
// right) and an RTL ordered list.
const ltr = new Markdown('- first item\n- second item\n- third item', {
  maxWidth: 260,
});
ltr.setPosition(20, 20);
scene.add(ltr);

const rtlBullets = new Markdown(
  '- \u0627\u0644\u0639\u0646\u0635\u0631 \u0627\u0644\u0623\u0648\u0644\n' +
    '- \u0627\u0644\u0639\u0646\u0635\u0631 \u0627\u0644\u062b\u0627\u0646\u064a\n' +
    '- \u0627\u0644\u0639\u0646\u0635\u0631 \u0627\u0644\u062b\u0627\u0644\u062b',
  { maxWidth: 260 },
);
rtlBullets.setPosition(320, 20);
scene.add(rtlBullets);

const rtlOrdered = new Markdown(
  '1. \u0627\u0644\u0623\u0648\u0644\n2. \u0627\u0644\u062b\u0627\u0646\u064a\n3. \u0627\u0644\u062b\u0627\u0644\u062b',
  { maxWidth: 260 },
);
rtlOrdered.setPosition(620, 20);
scene.add(rtlOrdered);

scene.start();
setTimeout(() => void reportSelectionAudit(scene), 500);
