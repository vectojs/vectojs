// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { TextEntity } from '../src/components/TextEntity';
import { LayoutEngine } from '../src/layout/LayoutEngine';

// jsdom doesn't implement canvas getContext; stub it so the shared font
// measurer takes its portable null-fallback without logging "Not implemented".
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const mockAtlas = {
  A: {
    width: 24,
    baseSize: 24,
    ast: {
      paths: [
        {
          commands: [
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 10, y: 10 },
            { type: 'C', x1: 5, y1: 5, x2: 15, y2: 15, x: 20, y: 20 },
            { type: 'Z' },
          ],
        },
      ],
    },
  },
};

const mockRenderer = {
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  bezierCurveTo: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  fillText: vi.fn(),
};

describe('TextEntity', () => {
  it('constructor lays out text and sets size', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    expect(textEntity.text).toBe('A');
    // width is the actual laid-out text width (glyph 'A' = 24 at fontSize 24),
    // not maxWidth — see LayoutEngine.totalWidth fix.
    expect(textEntity.width).toBe(24);
    expect(textEntity.height).toBe(36); // fontSize (24) * 1.5
  });

  it('isPointInside check bounds', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    textEntity.setPosition(10, 10);
    expect(textEntity.isPointInside(10, 10)).toBe(true);
    expect(textEntity.isPointInside(20, 20)).toBe(true);
    expect(textEntity.isPointInside(5, 5)).toBe(false);
    expect(textEntity.isPointInside(250, 50)).toBe(false);
  });

  it('hit-tests through rotation and non-uniform scale', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    textEntity.setPosition(40, 60);
    textEntity.scaleX = 2;
    textEntity.scaleY = 0.5;
    textEntity.rotation = Math.PI / 3;

    const inside = textEntity.localToWorld(12, 18);
    const outside = textEntity.localToWorld(textEntity.width + 1, 18);
    expect(textEntity.isPointInside(inside.x, inside.y)).toBe(true);
    expect(textEntity.isPointInside(outside.x, outside.y)).toBe(false);
  });

  it('renders vector glyph from atlas', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    mockRenderer.save.mockClear();
    mockRenderer.translate.mockClear();
    mockRenderer.scale.mockClear();
    mockRenderer.beginPath.mockClear();
    mockRenderer.moveTo.mockClear();
    mockRenderer.lineTo.mockClear();
    mockRenderer.bezierCurveTo.mockClear();
    mockRenderer.closePath.mockClear();
    mockRenderer.fill.mockClear();

    textEntity.render(mockRenderer as any);

    expect(mockRenderer.save).toHaveBeenCalled();
    expect(mockRenderer.translate).toHaveBeenCalledWith(0, 0);
    expect(mockRenderer.scale).toHaveBeenCalledWith(1, 1);
    expect(mockRenderer.beginPath).toHaveBeenCalled();
    expect(mockRenderer.moveTo).toHaveBeenCalledWith(0, 0);
    expect(mockRenderer.lineTo).toHaveBeenCalledWith(10, 10);
    expect(mockRenderer.bezierCurveTo).toHaveBeenCalledWith(5, 5, 15, 15, 20, 20);
    expect(mockRenderer.closePath).toHaveBeenCalled();
    expect(mockRenderer.fill).toHaveBeenCalledWith('#94a3b8');
    expect(mockRenderer.restore).toHaveBeenCalled();
  });

  it('renders native text when glyph is missing in atlas', () => {
    const textEntity = new TextEntity('B', mockAtlas, 200, 24);
    mockRenderer.save.mockClear();
    mockRenderer.translate.mockClear();
    mockRenderer.fillText.mockClear();
    mockRenderer.restore.mockClear();

    textEntity.render(mockRenderer as any);

    expect(mockRenderer.save).toHaveBeenCalled();
    expect(mockRenderer.translate).toHaveBeenCalledWith(0, 24 * 0.8);
    expect(mockRenderer.fillText).toHaveBeenCalledWith('B', 0, 0, '24px sans-serif', '#94a3b8');
    expect(mockRenderer.restore).toHaveBeenCalled();
  });

  it('hover event updates style', () => {
    const textEntity = new TextEntity('A', mockAtlas, 200, 24);
    expect((textEntity as any).isHovered).toBe(false);

    textEntity.emit('hover', {});
    expect((textEntity as any).isHovered).toBe(true);

    mockRenderer.fill.mockClear();
    textEntity.render(mockRenderer as any);
    expect(mockRenderer.fill).toHaveBeenCalledWith('#ffffff');

    textEntity.emit('pointerleave', {});
    expect((textEntity as any).isHovered).toBe(false);
  });

  it('setMaxWidth reflows via the hot path only; setText re-prepares (cold/hot)', () => {
    const prepSpy = vi.spyOn(LayoutEngine.prototype, 'prepare');
    const hotSpy = vi.spyOn(LayoutEngine.prototype, 'layoutPrepared');

    const t = new TextEntity('hello world foo bar', {}, 1000, 24);
    const prepAfterCtor = prepSpy.mock.calls.length; // cold pass ran in ctor
    const hotAfterCtor = hotSpy.mock.calls.length;
    expect(prepAfterCtor).toBeGreaterThan(0);

    t.setMaxWidth(40); // resize → hot only, reuse the cached PreparedText
    expect(prepSpy.mock.calls.length).toBe(prepAfterCtor); // no re-prepare
    expect(hotSpy.mock.calls.length).toBe(hotAfterCtor + 1);

    t.setText('changed text'); // content change → must re-prepare
    expect(prepSpy.mock.calls.length).toBe(prepAfterCtor + 1);

    prepSpy.mockRestore();
    hotSpy.mockRestore();
  });

  it('setMaxWidth re-wraps the cached text (taller when narrower)', () => {
    const t = new TextEntity('aaaa bbbb cccc', {}, 1000, 24); // wide → one line
    const tallBefore = t.height;
    t.setMaxWidth(30); // narrow → wraps → taller
    expect(t.height).toBeGreaterThan(tallBefore);
  });

  it('setText updates text and box, returns this for chaining', () => {
    const t = new TextEntity('A', mockAtlas, 200, 24);
    const ret = t.setText('AA');
    expect(ret).toBe(t);
    expect(t.text).toBe('AA');
    expect(t.width).toBe(48); // two 'A' glyphs at 24 each
  });
});

describe('TextEntity content projection', () => {
  it('exposes its text and font for the DOM content mirror', () => {
    const e = new TextEntity('Findable canvas text', mockAtlas, 400, 24);
    const proj = e.getContentProjection()!;
    expect(proj.text).toBe('Findable canvas text');
    expect(proj.font).toBe('24px sans-serif');

    e.setText('changed');
    expect(e.getContentProjection()!.text).toBe('changed');
  });

  it('setTextAlign and setHyphenator reflow through the layout engine', () => {
    const e = new TextEntity('aa bb cc dd', mockAtlas, 400, 24);
    expect(e.setTextAlign('justify')).toBe(e);
    expect((e as any).layout.textAlign).toBe('justify');
    const hyph = (w: string) => [w];
    expect(e.setHyphenator(hyph)).toBe(e);
    expect((e as any).layout.hyphenate).toBe(hyph);
  });
});
