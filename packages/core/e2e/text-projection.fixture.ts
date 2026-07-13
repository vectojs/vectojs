import { cssLineBoxBaseline, Scene } from '../../core/src/index';
import { CodeBlock } from '../../ui/src/Markdown';
import { Markdown } from '../../ui/src/Markdown';
import { RichText } from '../../ui/src/RichText';
import { Table } from '../../ui/src/Table';
import { Text } from '../../ui/src/Text';
import { TextArea } from '../../ui/src/TextArea';

const theme = {
  textColor: '#e2e8f0',
  headingColor: '#f8fafc',
  codeColor: '#a5f3fc',
  codeBgColor: '#0f172a',
  quoteBorderColor: '#6366f1',
  quoteTextColor: '#94a3b8',
  hrColor: '#334155',
  tableBgColor: '#0f172a',
  tableHeaderBgColor: '#1e293b',
  bodyFont: 'sans-serif',
  codeFont: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
  fontSize: 16,
};

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const scene = new Scene(canvas, { disableWindowResize: true });
const text = new Text('alpha beta gamma delta epsilon zeta eta theta', {
  font: '20px sans-serif',
  lineHeight: 30,
  maxWidth: 170,
}).setPosition(40, 30);
const code = new CodeBlock('const value = 42;\nconsole.log(value);', 'ts', 420, theme).setPosition(
  40,
  190,
);
const rich = new RichText(
  [
    { text: 'small ', style: { fontSize: 12 } },
    { text: 'office ', style: { bold: true } },
    { text: 'مرحبا VectoJS', style: { fontSize: 20 } },
  ],
  { font: '16px serif', maxWidth: 190 },
).setPosition(40, 330);
const rtl = new Text('مرحبا بك في VectoJS', {
  font: '24px serif',
  lineHeight: 36,
  maxWidth: 220,
}).setPosition(40, 500);
const ligature = new Text('office affinity ffi', {
  font: '32px "Noto Serif", serif',
  lineHeight: 44,
  maxWidth: 500,
}).setPosition(40, 620);
const area = new TextArea({
  width: 260,
  height: 120,
  value: 'first\nsecond',
  font: '16px sans-serif',
  lineHeight: 1.4,
}).setPosition(460, 40);
const markdown = new Markdown(
  '- Item A\n- Item B\n\n1. First\n2. Second\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |',
  { maxWidth: 430, selectable: true },
).setPosition(40, 740);
const table = new Table({
  headers: ['Name', 'Value'],
  rows: [['Alpha', '1']],
  width: 400,
  selectable: true,
}).setPosition(600, 740);
scene.add(text);
scene.add(code);
scene.add(rich);
scene.add(rtl);
scene.add(ligature);
scene.add(area);
scene.add(markdown);
scene.add(table);
scene.start();

function lineBaseline(root: HTMLElement, lineIndex: number): number {
  const line = root.children[lineIndex] as HTMLElement;
  const rect = line.getBoundingClientRect();
  const style = getComputedStyle(line);
  const lineHeight =
    Number.parseFloat(style.lineHeight) || Number.parseFloat(line.style.lineHeight);
  const scale = lineHeight > 0 ? rect.height / lineHeight : 1;
  return rect.top + cssLineBoxBaseline(style.font, lineHeight) * scale;
}

(window as unknown as { __vecto: unknown; __ready: boolean }).__vecto = {
  scene,
  text,
  code,
  rich,
  rtl,
  ligature,
  area,
  markdown,
  table,
  lineBaseline,
};
(window as unknown as { __ready: boolean }).__ready = true;
