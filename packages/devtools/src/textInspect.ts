import type { Entity, Scene } from '@vectojs/core';
import { BidiResolver, prepareContentGrid, type PreparedContentGrid } from '@vectojs/core';
import type { PluginInspector, PluginRow } from './plugin';

/**
 * Text-shaping readout.
 *
 * VectoJS shapes its own text, so it can report things a DOM inspector cannot:
 * the resolved bidi level of each character, which glyph fell back to the canvas
 * measurer, the visual order the reversal segments produce. What it cannot report
 * is listed honestly in {@link TextInspection.unavailable} rather than guessed at,
 * because a debug tool that invents a plausible number is worse than one that
 * says it does not know.
 */
export interface TextInspection {
  /** Source text as the entity holds it. */
  source: string;
  /** Paragraph base direction resolved by UAX #9. */
  baseLevel: number;
  baseDirection: 'ltr' | 'rtl';
  /** Per-character bidi levels, one entry per UTF-16 code unit of `source`. */
  levels: number[];
  /**
   * Level runs: maximal spans of equal level, which is what a level bar draws and
   * what makes a mixed-direction line legible.
   */
  levelRuns: Array<{
    start: number;
    end: number;
    level: number;
    direction: 'ltr' | 'rtl';
  }>;
  /**
   * L2 reversal segments, highest level first — the reordering the algorithm
   * actually performs, as opposed to the final permutation.
   */
  reversalSegments: Array<[number, number]>;
  /** Visual order of source indices; `visualOrder[0]` is drawn leftmost. */
  visualOrder: number[];
  /** Grapheme clusters, which are the units a caret may sit between. */
  clusters: Array<{ text: string; start: number; length: number }>;
  /** Per-glyph detail, when the entity exposes a shaped grid or prepared text. */
  glyphs: TextGlyphInfo[];
  /** Baseline and line metrics, when derivable. */
  metrics?: { lineHeight: number; baseline: number; cellWidth?: number };
  /** Line boundaries, when the entity exposes them. */
  lines?: Array<{
    index: number;
    text: string;
    sourceStart: number;
    sourceEnd: number;
  }>;
  /** Capabilities that could not be reported, each with the reason. */
  unavailable: Array<{ capability: string; reason: string }>;
}

export interface TextGlyphInfo {
  /** The shaped glyph — a grapheme cluster, not necessarily one code point. */
  glyph: string;
  /** Visual x within the entity, when the source provides it. */
  x?: number;
  /** Advance width, when the source provides it. */
  advance?: number;
  /** Resolved bidi level. */
  level?: number;
  /** Source range this glyph came from. */
  sourceStart?: number;
  sourceEnd?: number;
  /** Set when the glyph atlas had no entry and the advance came from the measurer. */
  atlasMiss?: true;
}

/** Capabilities the engine genuinely does not expose, with why. */
const ABSENT_CAPABILITIES: ReadonlyArray<{
  capability: string;
  reason: string;
}> = [
  {
    capability: 'glyph ids',
    reason: 'the atlas is keyed by codepoint; this engine has no glyph-id concept',
  },
  {
    capability: 'script runs',
    reason: 'no itemizer exists; only a whole-string isComplexScript boolean',
  },
  {
    capability: 'font fallback spans',
    reason: 'per-glyph atlasMiss is reported instead; no API names the font actually used',
  },
];

type GridHolder = { getPreparedContentGrid?: () => PreparedContentGrid | null };
type PreparedHolder = {
  getPreparedText?: () => {
    paragraphs: Array<{
      words: Array<{
        glyphs: Array<{
          char: string;
          width: number;
          level: number;
          sourceIndex: number;
          sourceLength: number;
          atlasMiss?: true;
        }>;
      }>;
    }>;
  } | null;
};

/** Duck-typed text extraction, matching how the rest of DevTools finds text. */
function sourceTextOf(entity: Entity): string | undefined {
  const candidate = entity as unknown as { text?: unknown; value?: unknown };
  if (typeof candidate.text === 'string') return candidate.text;
  if (typeof candidate.value === 'string') return candidate.value;
  return undefined;
}

/** True when this entity has text worth inspecting. */
export function isTextEntity(entity: Entity): boolean {
  return sourceTextOf(entity) !== undefined;
}

function directionOf(level: number): 'ltr' | 'rtl' {
  // Odd levels are right-to-left in UAX #9.
  return level % 2 === 0 ? 'ltr' : 'rtl';
}

/** Collapse per-character levels into maximal runs of equal level. */
function runsOf(levels: number[]): TextInspection['levelRuns'] {
  const runs: TextInspection['levelRuns'] = [];
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    const start = i;
    while (i + 1 < levels.length && levels[i + 1] === level) i++;
    runs.push({ start, end: i, level, direction: directionOf(level) });
  }
  return runs;
}

/**
 * Grapheme clusters via `Intl.Segmenter`.
 *
 * Both engine segmenters are private, so this re-segments rather than reaching
 * into them. That is a deliberate duplication: the alternative is widening an
 * engine API purely for a debug tool, and cluster boundaries for a readout do not
 * need to be the same object the engine used.
 */
function clustersOf(text: string): TextInspection['clusters'] {
  const out: TextInspection['clusters'] = [];
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const part of seg.segment(text)) {
      out.push({
        text: part.segment,
        start: part.index,
        length: part.segment.length,
      });
    }
    return out;
  }
  // Code-point fallback for an engine without Intl.Segmenter: wrong for combining
  // marks and flags, but better than reporting nothing.
  let index = 0;
  for (const ch of text) {
    out.push({ text: ch, start: index, length: ch.length });
    index += ch.length;
  }
  return out;
}

/**
 * Inspect the text of one entity.
 *
 * Reads a prepared content grid or prepared text when the entity exposes one,
 * since those carry shaped glyphs with visual x, advance and level already
 * resolved. Falls back to bidi analysis of the raw source otherwise, which still
 * answers the direction questions without needing the entity's cooperation.
 */
export function inspectText(entity: Entity): TextInspection | null {
  const source = sourceTextOf(entity);
  if (source === undefined) return null;

  // One bidi pass per inspection: `levels` (for the readout) and `resolved`
  // (for segment reordering, which wants the resolver's own Uint8Array) view
  // the same resolution.
  const resolved = BidiResolver.resolveLevels(source);
  const levels = Array.from(resolved);
  const baseLevel = BidiResolver.getBaseLevel(source);
  const unavailable = [...ABSENT_CAPABILITIES];

  const inspection: TextInspection = {
    source,
    baseLevel,
    baseDirection: directionOf(baseLevel),
    levels,
    levelRuns: runsOf(levels),
    reversalSegments: BidiResolver.reorderSegments(source, resolved, baseLevel),
    visualOrder: BidiResolver.reorderIndices(source),
    clusters: clustersOf(source),
    glyphs: [],
    unavailable,
  };

  const grid = readGrid(entity);
  if (grid) {
    inspection.metrics = {
      lineHeight: grid.lineHeight,
      baseline: grid.baseline,
      cellWidth: grid.cellWidth,
    };
    inspection.lines = grid.lines.map((line, index) => ({
      index,
      text: source.slice(line.sourceStart, line.sourceEnd),
      sourceStart: line.sourceStart,
      sourceEnd: line.sourceEnd,
    }));
    for (const line of grid.lines) {
      for (const cell of line.cells) {
        inspection.glyphs.push({
          glyph: cell.glyph,
          x: cell.x,
          advance: cell.advance,
          level: cell.level,
          sourceStart: cell.sourceStart,
          sourceEnd: cell.sourceEnd,
        });
      }
    }
    return inspection;
  }

  const prepared = readPrepared(entity);
  if (prepared) {
    for (const paragraph of prepared.paragraphs) {
      for (const word of paragraph.words) {
        for (const glyph of word.glyphs) {
          inspection.glyphs.push({
            glyph: glyph.char,
            advance: glyph.width,
            level: glyph.level,
            sourceStart: glyph.sourceIndex,
            sourceEnd: glyph.sourceIndex + glyph.sourceLength,
            ...(glyph.atlasMiss ? { atlasMiss: true as const } : {}),
          });
        }
      }
    }
    unavailable.push({
      capability: 'visual x per glyph',
      reason: 'prepared text carries advances but not placed positions; lay out to get x',
    });
    unavailable.push({
      capability: 'line boundaries',
      reason: 'LayoutResult is a flat node list with no line index; group by y after layout',
    });
    return inspection;
  }

  unavailable.push({
    capability: 'per-glyph detail',
    reason: 'entity exposes neither a prepared content grid nor prepared text',
  });
  return inspection;
}

function readGrid(entity: Entity): PreparedContentGrid | null {
  const holder = entity as unknown as GridHolder;
  if (typeof holder.getPreparedContentGrid !== 'function') return null;
  try {
    return holder.getPreparedContentGrid() ?? null;
  } catch {
    return null;
  }
}

function readPrepared(
  entity: Entity,
): ReturnType<NonNullable<PreparedHolder['getPreparedText']>> | null {
  const holder = entity as unknown as PreparedHolder;
  if (typeof holder.getPreparedText !== 'function') return null;
  try {
    return holder.getPreparedText() ?? null;
  } catch {
    return null;
  }
}

/**
 * Shape an arbitrary string through the real content-grid pipeline.
 *
 * Lets the inspector answer "how would this text shape?" for a string that is
 * not in the scene at all, which is how a bidi or cluster question gets settled
 * without editing the app.
 */
export function shapeProbe(
  text: string,
  options: {
    font?: string;
    cellWidth?: number;
    lineHeight?: number;
    baseline?: number;
  } = {},
): TextInspection {
  const grid = prepareContentGrid(text, {
    font: options.font ?? '12px monospace',
    cellWidth: options.cellWidth ?? 7,
    lineHeight: options.lineHeight ?? 16,
    baseline: options.baseline ?? 12,
  });
  const resolved = BidiResolver.resolveLevels(text);
  const levels = Array.from(resolved);
  const baseLevel = BidiResolver.getBaseLevel(text);
  return {
    source: text,
    baseLevel,
    baseDirection: directionOf(baseLevel),
    levels,
    levelRuns: runsOf(levels),
    reversalSegments: BidiResolver.reorderSegments(text, resolved, baseLevel),
    visualOrder: BidiResolver.reorderIndices(text),
    clusters: clustersOf(text),
    glyphs: grid.lines.flatMap((line) =>
      line.cells.map((cell) => ({
        glyph: cell.glyph,
        x: cell.x,
        advance: cell.advance,
        level: cell.level,
        sourceStart: cell.sourceStart,
        sourceEnd: cell.sourceEnd,
      })),
    ),
    metrics: {
      lineHeight: grid.lineHeight,
      baseline: grid.baseline,
      cellWidth: grid.cellWidth,
    },
    lines: grid.lines.map((line, index) => ({
      index,
      text: text.slice(line.sourceStart, line.sourceEnd),
      sourceStart: line.sourceStart,
      sourceEnd: line.sourceEnd,
    })),
    unavailable: [...ABSENT_CAPABILITIES],
  };
}

/** Render an inspection as readout rows. */
export function formatTextInspection(inspection: TextInspection): PluginRow[] {
  const rows: PluginRow[] = [
    { label: 'chars', value: String(inspection.source.length) },
    {
      label: 'base',
      value: `${inspection.baseDirection} (level ${inspection.baseLevel})`,
    },
    { label: 'clusters', value: String(inspection.clusters.length) },
  ];

  const mixed = inspection.levelRuns.length > 1;
  rows.push({
    label: 'bidi',
    value: mixed ? `${inspection.levelRuns.length} level runs` : 'uniform',
    note: mixed
      ? inspection.levelRuns
          .slice(0, 4)
          .map((r) => `${r.start}-${r.end}:${r.level}`)
          .join(' ')
      : undefined,
  });
  if (inspection.reversalSegments.length > 0) {
    rows.push({
      label: 'reversals',
      value: String(inspection.reversalSegments.length),
      note: inspection.reversalSegments
        .slice(0, 3)
        .map(([a, b]) => `${a}-${b}`)
        .join(' '),
    });
  }

  if (inspection.metrics) {
    const m = inspection.metrics;
    rows.push({
      label: 'metrics',
      value: `line ${round(m.lineHeight)} base ${round(m.baseline)}`,
      note: m.cellWidth !== undefined ? `cell ${round(m.cellWidth)}` : undefined,
    });
  }
  if (inspection.lines) rows.push({ label: 'lines', value: String(inspection.lines.length) });

  if (inspection.glyphs.length > 0) {
    rows.push({ label: 'glyphs', value: String(inspection.glyphs.length) });
    const misses = inspection.glyphs.filter((g) => g.atlasMiss);
    if (misses.length > 0) {
      rows.push({
        label: 'atlas misses',
        value: String(misses.length),
        note: misses
          .slice(0, 6)
          .map((g) => JSON.stringify(g.glyph))
          .join(' '),
      });
    }
    // A few glyphs in detail: the readout is a fixed height, so showing every
    // glyph would push everything else off and a truncated dump is what a reader
    // actually scans.
    for (const glyph of inspection.glyphs.slice(0, 6)) {
      const parts: string[] = [];
      if (glyph.x !== undefined) parts.push(`x ${round(glyph.x)}`);
      if (glyph.advance !== undefined) parts.push(`adv ${round(glyph.advance)}`);
      if (glyph.level !== undefined) parts.push(`lvl ${glyph.level}`);
      rows.push({
        label: JSON.stringify(glyph.glyph),
        value: parts.join(' '),
        note: glyph.atlasMiss ? 'atlas miss' : undefined,
      });
    }
  }

  for (const item of inspection.unavailable) {
    rows.push({ label: `no ${item.capability}`, value: item.reason });
  }
  return rows;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The text inspector, as a DevTools plugin inspector.
 *
 * Registered by the consumer rather than automatically, so a build that never
 * inspects text does not carry it.
 */
export const textInspector: PluginInspector = {
  id: 'text',
  label: 'Text',
  appliesTo: isTextEntity,
  rows: ({ selection }) => {
    const inspection = inspectText(selection);
    if (!inspection) return [];
    return formatTextInspection(inspection);
  },
};

/** Scene-wide audit: report glyphs that missed the atlas, which cost measurer calls. */
export function auditTextShaping(scene: Scene): Array<{
  kind: string;
  entityId: string;
  message: string;
  severity: 'info' | 'warn';
}> {
  const findings: Array<{
    kind: string;
    entityId: string;
    message: string;
    severity: 'info' | 'warn';
  }> = [];
  const walk = (entity: Entity): void => {
    const inspection = isTextEntity(entity) ? inspectText(entity) : null;
    if (inspection) {
      const misses = inspection.glyphs.filter((g) => g.atlasMiss);
      if (misses.length > 0) {
        const sample = [...new Set(misses.map((g) => g.glyph))].slice(0, 5).join('');
        findings.push({
          kind: 'atlas-miss',
          entityId: entity.id,
          message: `${misses.length} glyph(s) absent from the atlas, measured on the canvas instead: ${JSON.stringify(sample)}`,
          severity: 'warn',
        });
      }
    }
    for (const child of entity.children) walk(child);
  };
  // Overlay-mounted text (showOverlay) misses the atlas too; audit.ts treats
  // the overlay root as first-class and so does every other scene walk.
  walk(scene.rootEntity);
  walk(scene.overlayRootEntity);
  return findings;
}
