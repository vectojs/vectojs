// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Entity, Scene, prepareContentGrid } from '@vectojs/core';
import {
  auditTextShaping,
  formatTextInspection,
  inspectText,
  isTextEntity,
  shapeProbe,
  textInspector,
} from '../src/textInspect';

class Plain extends Entity {
  constructor(
    id: string,
    public text: string,
  ) {
    super(id);
    this.width = 100;
    this.height = 20;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

class NoText extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

/** A component exposing its shaped grid, as a CodeBlock-like entity does. */
class Gridded extends Plain {
  getPreparedContentGrid() {
    return prepareContentGrid(this.text, {
      font: '12px monospace',
      cellWidth: 7,
      lineHeight: 16,
      baseline: 12,
    });
  }
}

/** A component exposing prepared text with an atlas miss recorded. */
class Prepared extends Plain {
  getPreparedText() {
    return {
      paragraphs: [
        {
          words: [
            {
              glyphs: [
                {
                  char: 'a',
                  width: 8,
                  level: 0,
                  sourceIndex: 0,
                  sourceLength: 1,
                },
                {
                  char: 'z',
                  width: 8,
                  level: 0,
                  sourceIndex: 1,
                  sourceLength: 1,
                  atlasMiss: true as const,
                },
              ],
            },
          ],
        },
      ],
    };
  }
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return new Scene(canvas, { disableWindowResize: true });
}

describe('isTextEntity', () => {
  it('duck-types on text and value, not on the constructor name', () => {
    expect(isTextEntity(new Plain('a', 'hi'))).toBe(true);
    expect(isTextEntity(new NoText('b'))).toBe(false);
  });
});

describe('inspectText', () => {
  it('returns null for an entity with no text', () => {
    expect(inspectText(new NoText('a'))).toBeNull();
  });

  it('resolves an LTR base direction and a uniform level run', () => {
    const info = inspectText(new Plain('a', 'hello'))!;
    expect(info.baseDirection).toBe('ltr');
    expect(info.baseLevel).toBe(0);
    expect(info.levels).toHaveLength(5);
    expect(info.levelRuns).toHaveLength(1);
    expect(info.levelRuns[0]).toMatchObject({
      start: 0,
      end: 4,
      level: 0,
      direction: 'ltr',
    });
  });

  it('resolves an RTL base direction for Arabic', () => {
    const info = inspectText(new Plain('a', 'مرحبا'))!;
    expect(info.baseDirection).toBe('rtl');
    expect(info.baseLevel).toBe(1);
    expect(info.levelRuns.every((r) => r.direction === 'rtl')).toBe(true);
  });

  it('splits mixed-direction text into multiple level runs', () => {
    const info = inspectText(new Plain('a', 'abc مرحبا def'))!;
    expect(info.levelRuns.length).toBeGreaterThan(1);
    // Both directions present, which is exactly what a level bar must show.
    const dirs = new Set(info.levelRuns.map((r) => r.direction));
    expect(dirs.has('ltr')).toBe(true);
    expect(dirs.has('rtl')).toBe(true);
  });

  it('reports reversal segments and a visual order that is a permutation', () => {
    const text = 'abc مرحبا';
    const info = inspectText(new Plain('a', text))!;
    expect(info.visualOrder).toHaveLength(text.length);
    // A permutation: every source index appears exactly once.
    expect([...info.visualOrder].sort((x, y) => x - y)).toEqual(
      Array.from({ length: text.length }, (_, i) => i),
    );
    expect(info.reversalSegments.length).toBeGreaterThan(0);
  });

  it('counts grapheme clusters rather than code units', () => {
    // A family emoji is many code units and one cluster.
    const info = inspectText(new Plain('a', '👨‍👩‍👧'))!;
    expect(info.source.length).toBeGreaterThan(1);
    expect(info.clusters).toHaveLength(1);
    expect(info.clusters[0]!.text).toBe('👨‍👩‍👧');
  });

  it('reads glyphs, metrics and lines from a prepared content grid', () => {
    const info = inspectText(new Gridded('a', 'ab\ncd'))!;
    expect(info.metrics).toEqual({
      lineHeight: 16,
      baseline: 12,
      cellWidth: 7,
    });
    expect(info.lines).toHaveLength(2);
    expect(info.lines![0]!.text).toBe('ab');
    expect(info.lines![1]!.text).toBe('cd');
    expect(info.glyphs).toHaveLength(4);
    // Visual x and advance come from the grid, not guessed.
    expect(info.glyphs[0]!.x).toBe(0);
    expect(info.glyphs[0]!.advance).toBe(7);
    expect(info.glyphs[1]!.x).toBe(7);
  });

  it('reads glyphs from prepared text and surfaces the atlas miss', () => {
    const info = inspectText(new Prepared('a', 'az'))!;
    expect(info.glyphs).toHaveLength(2);
    expect(info.glyphs[0]!.atlasMiss).toBeUndefined();
    expect(info.glyphs[1]!.atlasMiss).toBe(true);
    // Prepared text has advances but no placed x, and says so.
    expect(info.glyphs[0]!.advance).toBe(8);
    expect(info.unavailable.map((u) => u.capability)).toContain('visual x per glyph');
    expect(info.unavailable.map((u) => u.capability)).toContain('line boundaries');
  });

  it('names the capabilities the engine genuinely lacks, with reasons', () => {
    const info = inspectText(new Plain('a', 'hi'))!;
    const caps = info.unavailable.map((u) => u.capability);
    // Reported as absent rather than fabricated: this engine has no glyph ids at
    // all, and no script itemizer exists.
    expect(caps).toContain('glyph ids');
    expect(caps).toContain('script runs');
    expect(caps).toContain('font fallback spans');
    expect(caps).toContain('per-glyph detail');
    for (const item of info.unavailable) expect(item.reason.length).toBeGreaterThan(10);
  });

  it('survives a component whose grid getter throws', () => {
    class Hostile extends Plain {
      getPreparedContentGrid(): never {
        throw new Error('nope');
      }
    }
    const info = inspectText(new Hostile('a', 'hi'));
    expect(info).not.toBeNull();
    // Falls back to source-only analysis rather than failing.
    expect(info!.baseDirection).toBe('ltr');
  });

  it('handles empty text without throwing', () => {
    const info = inspectText(new Plain('a', ''))!;
    expect(info.levels).toEqual([]);
    expect(info.clusters).toEqual([]);
    expect(info.levelRuns).toEqual([]);
  });
});

describe('shapeProbe', () => {
  it('shapes a string that is not in the scene at all', () => {
    const info = shapeProbe('ab');
    expect(info.glyphs).toHaveLength(2);
    expect(info.metrics!.cellWidth).toBe(7);
    expect(info.lines).toHaveLength(1);
  });

  it('reports bidi levels for a probe string', () => {
    const info = shapeProbe('مرحبا');
    expect(info.baseDirection).toBe('rtl');
    expect(info.glyphs.every((g) => g.level === 1)).toBe(true);
  });

  it('gives wide clusters two columns', () => {
    // A CJK glyph occupies two monospace cells; the advance must show it.
    const info = shapeProbe('中a', { cellWidth: 10 });
    expect(info.glyphs[0]!.advance).toBe(20);
    expect(info.glyphs[1]!.advance).toBe(10);
  });
});

describe('formatTextInspection', () => {
  it('renders direction, clusters, metrics and glyph detail', () => {
    const rows = formatTextInspection(inspectText(new Gridded('a', 'ab'))!);
    const text = rows.map((r) => `${r.label} ${r.value}`).join('\n');
    expect(text).toContain('base ltr');
    expect(text).toContain('clusters 2');
    expect(text).toContain('metrics');
    expect(text).toContain('glyphs 2');
  });

  it('reports level runs for mixed text and uniform otherwise', () => {
    const uniform = formatTextInspection(inspectText(new Plain('a', 'abc'))!);
    expect(uniform.find((r) => r.label === 'bidi')?.value).toBe('uniform');

    const mixed = formatTextInspection(inspectText(new Plain('a', 'abc مرحبا'))!);
    expect(mixed.find((r) => r.label === 'bidi')?.value).toContain('level runs');
  });

  it('surfaces atlas misses with the offending glyphs', () => {
    const rows = formatTextInspection(inspectText(new Prepared('a', 'az'))!);
    const row = rows.find((r) => r.label === 'atlas misses');
    expect(row?.value).toBe('1');
    expect(row?.note).toContain('z');
  });

  it('lists unavailable capabilities as rows so they are not silently missing', () => {
    const rows = formatTextInspection(inspectText(new Plain('a', 'hi'))!);
    expect(rows.some((r) => r.label === 'no glyph ids')).toBe(true);
  });
});

describe('textInspector plugin', () => {
  it('applies only to entities with text', () => {
    expect(textInspector.appliesTo!(new Plain('a', 'hi'))).toBe(true);
    expect(textInspector.appliesTo!(new NoText('b'))).toBe(false);
  });

  it('produces rows through the plugin contract', () => {
    const scene = makeScene();
    const entity = new Gridded('a', 'hi');
    scene.add(entity);
    const rows = textInspector.rows({ scene, selection: entity });
    expect(rows.length).toBeGreaterThan(3);
    scene.destroy();
  });
});

describe('auditTextShaping', () => {
  it('reports entities whose glyphs missed the atlas', () => {
    const scene = makeScene();
    scene.add(new Prepared('bad', 'az'));
    scene.add(new Gridded('fine', 'ok'));

    const findings = auditTextShaping(scene);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'atlas-miss',
      entityId: 'bad',
      severity: 'warn',
    });
    expect(findings[0]!.message).toContain('"z"');
    scene.destroy();
  });

  it('is quiet when nothing missed the atlas', () => {
    const scene = makeScene();
    scene.add(new Gridded('fine', 'ok'));
    expect(auditTextShaping(scene)).toEqual([]);
    scene.destroy();
  });

  it('walks nested children', () => {
    const scene = makeScene();
    const wrapper = new NoText('wrap');
    wrapper.add(new Prepared('deep', 'az'));
    scene.add(wrapper);
    expect(auditTextShaping(scene).map((f) => f.entityId)).toEqual(['deep']);
    scene.destroy();
  });
});
