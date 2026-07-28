// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import {
  auditMarkdownStreaming,
  formatMarkdownStream,
  inspectMarkdownStream,
  isMarkdownEntity,
  markdownStreamInspector,
} from '../src/markdownInspect';

interface Stats {
  sourceLength?: number;
  topLevelTokens?: number;
  childEntities?: number;
  appends?: number;
  workerResponses?: number;
  tokensPrefixMatched?: number;
  tokensReturned?: number;
  lexerMs?: number;
  sourceCharsLexed?: number;
  workerMsAvg?: number;
  workerMsMax?: number;
  stablePrefixChars?: number;
  changedTailChars?: number;
  entitiesReused?: number;
  entitiesRebuilt?: number;
  inPlaceUpdates?: number;
}

/**
 * A stand-in reproducing the real Markdown descriptor's shape.
 *
 * The inspector reads the descriptor rather than importing @vectojs/markdown, so
 * a fixture that matches the shape is the honest unit under test — and it keeps
 * the heavy parser dependency out of this suite.
 */
class FakeMarkdown extends Entity {
  constructor(
    id: string,
    private stats: Stats,
    private notes?: string[],
  ) {
    super(id);
    this.width = 200;
    this.height = 100;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  override getDevtoolsDescriptor() {
    const s = this.stats;
    return {
      kind: 'Markdown',
      groups: [
        {
          label: 'Source',
          fields: [
            { label: 'sourceLength', value: s.sourceLength ?? 0 },
            { label: 'topLevelTokens', value: s.topLevelTokens ?? 0 },
            { label: 'childEntities', value: s.childEntities ?? 0 },
          ],
        },
        {
          label: 'Streaming',
          fields: [
            { label: 'appends', value: s.appends ?? 0 },
            { label: 'workerResponses', value: s.workerResponses ?? 0 },
            { label: 'workerMsAvg', value: s.workerMsAvg ?? 0 },
            { label: 'workerMsMax', value: s.workerMsMax ?? 0 },
          ],
        },
        {
          label: 'Incremental reuse',
          fields: [
            { label: 'tokensPrefixMatched', value: s.tokensPrefixMatched ?? 0 },
            { label: 'tokensReturned', value: s.tokensReturned ?? 0 },
            { label: 'lexerMs', value: s.lexerMs ?? 0 },
            { label: 'sourceCharsLexed', value: s.sourceCharsLexed ?? 0 },
          ],
        },
        {
          label: 'Delta shape',
          fields: [
            { label: 'stablePrefixChars', value: s.stablePrefixChars ?? 0 },
            { label: 'changedTailChars', value: s.changedTailChars ?? 0 },
            { label: 'entitiesReused', value: s.entitiesReused ?? 0 },
            { label: 'entitiesRebuilt', value: s.entitiesRebuilt ?? 0 },
            { label: 'inPlaceUpdates', value: s.inPlaceUpdates ?? 0 },
          ],
        },
      ],
      ...(this.notes ? { notes: this.notes } : {}),
    };
  }
}

class Other extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  override getDevtoolsDescriptor() {
    return { kind: 'Slider', fields: [] };
  }
}

class Bare extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return new Scene(canvas, { disableWindowResize: true });
}

/** A healthy stream: small tail, high reuse, fast worker. */
const healthy: Stats = {
  sourceLength: 4000,
  topLevelTokens: 40,
  childEntities: 40,
  appends: 100,
  workerResponses: 96,
  tokensPrefixMatched: 3900,
  tokensReturned: 100,
  workerMsAvg: 1.2,
  workerMsMax: 3.4,
  stablePrefixChars: 3960,
  changedTailChars: 40,
  entitiesReused: 3800,
  entitiesRebuilt: 60,
  inPlaceUpdates: 90,
};

describe('isMarkdownEntity', () => {
  it('identifies by descriptor kind, not constructor name', () => {
    expect(isMarkdownEntity(new FakeMarkdown('a', {}))).toBe(true);
    expect(isMarkdownEntity(new Other('b'))).toBe(false);
    expect(isMarkdownEntity(new Bare('c'))).toBe(false);
  });

  it('tolerates a throwing descriptor', () => {
    class Hostile extends Entity {
      isPointInside(): boolean {
        return false;
      }
      render(): void {}
      override getDevtoolsDescriptor(): never {
        throw new Error('nope');
      }
    }
    expect(isMarkdownEntity(new Hostile('a'))).toBe(false);
  });
});

describe('inspectMarkdownStream', () => {
  it('returns null for a non-Markdown entity', () => {
    expect(inspectMarkdownStream(new Other('a'))).toBeNull();
    expect(inspectMarkdownStream(new Bare('b'))).toBeNull();
  });

  it('reads every field out of the descriptor groups', () => {
    const info = inspectMarkdownStream(new FakeMarkdown('md', healthy))!;
    expect(info.sourceLength).toBe(4000);
    expect(info.appends).toBe(100);
    expect(info.workerResponses).toBe(96);
    expect(info.workerMsMax).toBe(3.4);
    expect(info.stablePrefixChars).toBe(3960);
    expect(info.inPlaceUpdates).toBe(90);
  });

  it('derives coalescing from appends minus responses', () => {
    const info = inspectMarkdownStream(new FakeMarkdown('md', healthy))!;
    expect(info.coalesced).toBe(4);
  });

  it('never reports negative coalescing', () => {
    // More responses than appends should not produce a nonsense negative.
    const info = inspectMarkdownStream(new FakeMarkdown('md', { appends: 2, workerResponses: 5 }))!;
    expect(info.coalesced).toBe(0);
  });

  it('computes the tail fraction, which fails independently of token reuse', () => {
    // 95% of TOKENS reused, but the tail is 60% of the CHARACTERS: the document
    // is still being re-read every chunk, and only tailFraction shows it.
    const info = inspectMarkdownStream(
      new FakeMarkdown('md', {
        sourceLength: 1000,
        changedTailChars: 600,
        tokensPrefixMatched: 95,
        tokensReturned: 5,
      }),
    )!;
    expect(info.tokenPrefixReuseRatio).toBeCloseTo(0.95);
    expect(info.tailFraction).toBeCloseTo(0.6);
  });

  it('reports a zero ratio rather than dividing by zero', () => {
    const info = inspectMarkdownStream(new FakeMarkdown('md', {}))!;
    expect(info.tokenPrefixReuseRatio).toBe(0);
    expect(info.tailFraction).toBe(0);
  });

  it('carries the component notes through', () => {
    const info = inspectMarkdownStream(new FakeMarkdown('md', {}, ['worker unavailable']))!;
    expect(info.notes).toEqual(['worker unavailable']);
  });
});

describe('formatMarkdownStream', () => {
  it('renders source, appends, worker timing, reuse and delta', () => {
    const rows = formatMarkdownStream(inspectMarkdownStream(new FakeMarkdown('md', healthy))!);
    const text = rows.map((r) => `${r.label}|${r.value}|${r.note ?? ''}`).join('\n');
    expect(text).toContain('source|4000 chars');
    expect(text).toContain('4 coalesced');
    expect(text).toContain('avg 1.2ms max 3.4ms');
    expect(text).toContain('token prefix reuse|98%');
    expect(text).toContain('3900 matched / 100 returned');
    // "changed", not "re-lexed": the lexer reads the whole source every append, so
    // describing the delta as the amount lexed was the defect this row used to have.
    expect(text).toContain('40 chars changed');
    expect(text).toContain('1% of document');
    expect(text).toContain('90 in-place');
  });

  it('reports lexer cost separately from token reuse', () => {
    // The whole point of the rename: a high prefix-reuse ratio must not be readable
    // as "the parser did less work". These are different rows with different numbers.
    const rows = formatMarkdownStream(
      inspectMarkdownStream(
        new FakeMarkdown('md', {
          ...healthy,
          lexerMs: 12.34,
          sourceCharsLexed: 250_000,
        }),
      )!,
    );
    const text = rows.map((r) => `${r.label}|${r.value}|${r.note ?? ''}`).join('\n');
    expect(text).toContain('lexer|12.3ms');
    expect(text).toContain('250000 chars lexed');
    // Reuse is near-perfect and the lexer still read a quarter of a million chars.
    expect(text).toContain('token prefix reuse|98%');
  });

  it('says so when the worker has not answered', () => {
    const rows = formatMarkdownStream(
      inspectMarkdownStream(new FakeMarkdown('md', { appends: 3, workerResponses: 0 }))!,
    );
    expect(rows.find((r) => r.label === 'worker')?.note).toBe('none yet');
  });

  it('renders notes as rows', () => {
    const rows = formatMarkdownStream(
      inspectMarkdownStream(new FakeMarkdown('md', {}, ['a problem']))!,
    );
    expect(rows.some((r) => r.label === 'note' && r.value === 'a problem')).toBe(true);
  });
});

describe('auditMarkdownStreaming', () => {
  it('is quiet for a healthy stream', () => {
    const scene = makeScene();
    scene.add(new FakeMarkdown('md', healthy));
    expect(auditMarkdownStreaming(scene)).toEqual([]);
    scene.destroy();
  });

  it('is quiet before any append', () => {
    const scene = makeScene();
    // Zeroed stats must not be read as pathology; nothing has streamed yet.
    scene.add(new FakeMarkdown('md', { sourceLength: 5000 }));
    expect(auditMarkdownStreaming(scene)).toEqual([]);
    scene.destroy();
  });

  it('flags a tail that is most of the document', () => {
    const scene = makeScene();
    scene.add(
      new FakeMarkdown('md', {
        appends: 10,
        workerResponses: 10,
        sourceLength: 5000,
        changedTailChars: 4000,
        tokensPrefixMatched: 100,
        tokensReturned: 5,
      }),
    );
    const kinds = auditMarkdownStreaming(scene).map((f) => f.kind);
    expect(kinds).toContain('tail-not-a-delta');
    // Token reuse is healthy here, so that finding must NOT also fire.
    expect(kinds).not.toContain('low-token-reuse');
    scene.destroy();
  });

  it('does not flag a large tail on a short document', () => {
    // Early in a stream the tail IS the document; that is not a pathology.
    const scene = makeScene();
    scene.add(
      new FakeMarkdown('md', {
        appends: 2,
        workerResponses: 2,
        sourceLength: 80,
        changedTailChars: 80,
      }),
    );
    expect(auditMarkdownStreaming(scene).map((f) => f.kind)).not.toContain('tail-not-a-delta');
    scene.destroy();
  });

  it('flags low token reuse', () => {
    const scene = makeScene();
    scene.add(
      new FakeMarkdown('md', {
        appends: 10,
        workerResponses: 10,
        sourceLength: 1000,
        changedTailChars: 10,
        tokensPrefixMatched: 20,
        tokensReturned: 80,
      }),
    );
    expect(auditMarkdownStreaming(scene).map((f) => f.kind)).toContain('low-token-reuse');
    scene.destroy();
  });

  it('flags a worker round trip past the two-frame budget', () => {
    const scene = makeScene();
    scene.add(
      new FakeMarkdown('md', {
        appends: 5,
        workerResponses: 5,
        sourceLength: 500,
        workerMsMax: 22,
      }),
    );
    const finding = auditMarkdownStreaming(scene).find((f) => f.kind === 'slow-worker-roundtrip');
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('22ms');
    scene.destroy();
  });

  it('reports no worker responses', () => {
    const scene = makeScene();
    scene.add(
      new FakeMarkdown('md', {
        appends: 4,
        workerResponses: 0,
        sourceLength: 100,
      }),
    );
    expect(auditMarkdownStreaming(scene).map((f) => f.kind)).toContain('no-worker');
    scene.destroy();
  });

  it('flags a reconciler rebuilding more than it reuses', () => {
    const scene = makeScene();
    scene.add(
      new FakeMarkdown('md', {
        appends: 10,
        workerResponses: 10,
        sourceLength: 500,
        entitiesReused: 5,
        entitiesRebuilt: 50,
      }),
    );
    const finding = auditMarkdownStreaming(scene).find((f) => f.kind === 'entities-mostly-rebuilt');
    expect(finding?.message).toContain('50 entities rebuilt');
    scene.destroy();
  });

  it('walks nested children and attributes findings to the right entity', () => {
    const scene = makeScene();
    const wrapper = new Bare('wrap');
    wrapper.add(
      new FakeMarkdown('deep', {
        appends: 3,
        workerResponses: 0,
        sourceLength: 50,
      }),
    );
    scene.add(wrapper);
    const findings = auditMarkdownStreaming(scene);
    expect(findings.every((f) => f.entityId === 'deep')).toBe(true);
    scene.destroy();
  });
});

describe('markdownStreamInspector plugin', () => {
  it('applies only to Markdown entities', () => {
    expect(markdownStreamInspector.appliesTo!(new FakeMarkdown('a', {}))).toBe(true);
    expect(markdownStreamInspector.appliesTo!(new Other('b'))).toBe(false);
  });

  it('produces rows through the plugin contract', () => {
    const scene = makeScene();
    const entity = new FakeMarkdown('md', healthy);
    scene.add(entity);
    expect(markdownStreamInspector.rows({ scene, selection: entity }).length).toBeGreaterThan(5);
    scene.destroy();
  });
});

describe('coalescing with no worker', () => {
  it('does not claim coalescing when the worker never answered', () => {
    // Verified against the real component: in an environment without a worker,
    // every append parses synchronously, so `appends - 0` would report all of
    // them as coalesced when none were.
    const info = inspectMarkdownStream(
      new FakeMarkdown('md', { appends: 4, workerResponses: 0, sourceLength: 62 }),
    )!;
    expect(info.coalesced).toBe(0);
  });
});
