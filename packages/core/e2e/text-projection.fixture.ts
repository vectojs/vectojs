import { cssLineBoxBaseline, Scene } from '../../core/src/index';
import { CodeBlock } from '../../ui/src/Markdown';
import { RichText } from '../../ui/src/RichText';
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
  codeFont: 'monospace',
  fontSize: 16,
};

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const scene = new Scene(canvas, { disableWindowResize: true });
const text = new Text('Wrapped text', { font: '20px sans-serif', lineHeight: 30 }).setPosition(
  40,
  30,
);
const code = new CodeBlock('const value = 42;\nconsole.log(value);', 'ts', 420, theme).setPosition(
  40,
  100,
);
const rich = new RichText(
  [{ text: 'small ' }, { text: 'large', style: { bold: true, fontSize: 28 } }],
  { font: '16px sans-serif' },
).setPosition(40, 230);
const area = new TextArea({
  width: 260,
  height: 120,
  value: 'first\nsecond',
  font: '16px sans-serif',
  lineHeight: 1.4,
}).setPosition(460, 40);
scene.add(text);
scene.add(code);
scene.add(rich);
scene.add(area);
scene.start();

function lineBaseline(root: HTMLElement, lineIndex: number): number {
  const line = root.children[lineIndex] as HTMLElement;
  const rect = line.getBoundingClientRect();
  const style = getComputedStyle(line);
  const lineHeight =
    Number.parseFloat(style.lineHeight) || Number.parseFloat(line.style.lineHeight);
  return rect.top + cssLineBoxBaseline(style.font, lineHeight);
}

(window as unknown as { __vecto: unknown; __ready: boolean }).__vecto = {
  scene,
  text,
  code,
  rich,
  area,
  lineBaseline,
};
(window as unknown as { __ready: boolean }).__ready = true;
