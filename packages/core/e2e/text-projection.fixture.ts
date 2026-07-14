import { cssLineBoxBaseline, Entity, type IRenderer, Scene } from '../../core/src/index';
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
class FlowProjectionEntity extends Entity {
  readonly source = 'flow α middle Ω tail';

  constructor() {
    super();
    this.width = 280;
    this.height = 40;
  }

  override getContentProjection() {
    return {
      text: this.source,
      font: '22px sans-serif',
      lineHeight: 40,
      baseline: 30,
      selectable: true,
    };
  }

  override render(renderer: IRenderer): void {
    renderer.fillText(this.source, 0, 30, '22px sans-serif', '#e2e8f0');
  }
}

const text = new Text('alpha beta gamma delta epsilon zeta eta theta', {
  font: '20px sans-serif',
  lineHeight: 30,
  maxWidth: 170,
}).setPosition(40, 30);
const codeSource = 'office ffi\n你好\nA👩‍💻B\nمرحبا';
const code = new CodeBlock(codeSource, 'ts', 420, theme).setPosition(40, 190);
const transformedCode = new CodeBlock('A👩‍💻B\r\nبلا\r\nabc مرحبا 123', 'ts', 320, theme).setPosition(
  760,
  320,
);
transformedCode.rotation = Math.PI / 6;
transformedCode.scaleX = 1.2;
transformedCode.scaleY = 0.8;
const largeCodeSource = Array.from({ length: 100 }, () =>
  'const value = office_affinity_123; '.repeat(3).slice(0, 80),
).join('\n');
const largeCode = new CodeBlock(largeCodeSource, 'ts', 800, theme).setPosition(2000, 1100);
const rich = new RichText(
  [
    { text: 'small ', style: { fontSize: 12 } },
    { text: 'office ', style: { bold: true } },
    { text: 'مرحبا VectoJS', style: { fontSize: 20 } },
  ],
  { font: '16px serif', maxWidth: 190 },
).setPosition(40, 330);
const rotatedText = new Text('rotated ordinary caret', {
  font: '22px sans-serif',
  lineHeight: 32,
  maxWidth: 360,
}).setPosition(900, 40);
rotatedText.rotation = Math.PI / 2;
rotatedText.scaleX = 1.3;
rotatedText.scaleY = 0.8;
const mirroredRich = new RichText(
  [
    { text: 'mirror ', style: { fontSize: 15 } },
    { text: 'rich caret', style: { bold: true, fontSize: 21 } },
  ],
  { font: '16px serif', maxWidth: 260 },
).setPosition(1150, 500);
mirroredRich.scaleX = -1;
mirroredRich.scaleY = 1.2;
mirroredRich.rotation = Math.PI / 12;
const flowProjection = new FlowProjectionEntity().setPosition(820, 230);
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
scene.add(transformedCode);
scene.add(largeCode);
scene.add(rich);
scene.add(rotatedText);
scene.add(mirroredRich);
scene.add(flowProjection);
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
  transformedCode,
  largeCode,
  rich,
  rotatedText,
  mirroredRich,
  flowProjection,
  rtl,
  ligature,
  area,
  markdown,
  table,
  lineBaseline,
};
(window as unknown as { __ready: boolean }).__ready = true;
