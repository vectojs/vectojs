import type { Entity, Scene } from '@vectojs/core';
import type { PluginAudit, PluginFinding, PluginInspector, PluginRow } from './plugin';

/**
 * Streaming readout for a Markdown entity.
 *
 * Reads the entity's own `getDevtoolsDescriptor()` rather than importing
 * `@vectojs/markdown`: that keeps the dependency pointing the right way (the
 * component describes itself, DevTools does not know its type) and keeps this
 * module out of the headless bundle's forbidden-import set.
 */
export interface MarkdownStreamInfo {
  entityId: string;
  sourceLength: number;
  topLevelTokens: number;
  childEntities: number;
  appends: number;
  workerResponses: number;
  /** Fewer responses than appends means chunks coalesced while a request was in flight. */
  coalesced: number;
  /**
   * Leading tokens whose `raw` was unchanged, so the main thread kept its existing
   * token objects and child entities. A prefix match — the worker still lexed them.
   */
  tokensPrefixMatched: number;
  /** Tokens in the changed suffix the worker cloned back: the transfer payload. */
  tokensReturned: number;
  /**
   * `matched / (matched + returned)`. Near 1 means small transfers and high entity
   * reuse. It does **not** mean less lexing — see {@link lexerMs}.
   */
  tokenPrefixReuseRatio: number;
  /**
   * Total ms inside `marked.lexer()`. `marked` has no incremental lexing API, so
   * this covers the whole accumulated source on every append and is the one cost
   * in the pipeline that is still O(document) per chunk.
   */
  lexerMs: number;
  /**
   * Characters handed to the lexer, summed across appends. Grows ~O(n^2) over a
   * stream of n chunks.
   */
  sourceCharsLexed: number;
  workerMsAvg: number;
  workerMsMax: number;
  stablePrefixChars: number;
  changedTailChars: number;
  entitiesReused: number;
  entitiesRebuilt: number;
  inPlaceUpdates: number;
  /**
   * Fraction of the document whose token raws CHANGED on the most recent append.
   *
   * Not the fraction lexed — that is always 1.0, because the worker lexes the whole
   * accumulated source every time. This is the share that had to be transferred back
   * and have its entities rebuilt.
   *
   * This is what answers the "is the delta actually a delta" question, and it can be
   * bad while the prefix-reuse ratio looks healthy: matching 95% of tokens still
   * means transferring and rebuilding most of the document if those 5% cover most of
   * the characters.
   */
  tailFraction: number;
  notes: string[];
}

type DescriptorField = { label: string; value: unknown; hint?: string };
type DescriptorGroup = { label: string; fields: DescriptorField[] };
type Descriptor = {
  kind?: string;
  groups?: DescriptorGroup[];
  fields?: DescriptorField[];
  notes?: string[];
};

function readDescriptor(entity: Entity): Descriptor | null {
  const holder = entity as unknown as {
    getDevtoolsDescriptor?: () => Descriptor | null;
  };
  if (typeof holder.getDevtoolsDescriptor !== 'function') return null;
  try {
    return holder.getDevtoolsDescriptor() ?? null;
  } catch {
    return null;
  }
}

/** True when this entity describes itself as a Markdown renderer. */
export function isMarkdownEntity(entity: Entity): boolean {
  return readDescriptor(entity)?.kind === 'Markdown';
}

function numberField(descriptor: Descriptor, label: string): number {
  const groups = descriptor.groups ?? [];
  const all: DescriptorField[] = [...(descriptor.fields ?? [])];
  for (const group of groups) all.push(...group.fields);
  const field = all.find((f) => f.label === label);
  return typeof field?.value === 'number' ? field.value : 0;
}

/**
 * Read the streaming state of a Markdown entity, or null when it is not one.
 *
 * Every value already exists in the component's descriptor; this shapes it into
 * the derived quantities worth looking at — the coalescing count, and the fraction
 * of the document whose tokens changed on the last append.
 */
export function inspectMarkdownStream(entity: Entity): MarkdownStreamInfo | null {
  const descriptor = readDescriptor(entity);
  if (descriptor?.kind !== 'Markdown') return null;

  const sourceLength = numberField(descriptor, 'sourceLength');
  const appends = numberField(descriptor, 'appends');
  const workerResponses = numberField(descriptor, 'workerResponses');
  const tokensPrefixMatched = numberField(descriptor, 'tokensPrefixMatched');
  const tokensReturned = numberField(descriptor, 'tokensReturned');
  const changedTailChars = numberField(descriptor, 'changedTailChars');
  // Tokens that went through the diff, which is NOT the number lexed: the worker
  // lexes the whole source every time regardless of how the diff turns out.
  const diffedTokens = tokensPrefixMatched + tokensReturned;

  return {
    entityId: entity.id,
    sourceLength,
    topLevelTokens: numberField(descriptor, 'topLevelTokens'),
    childEntities: numberField(descriptor, 'childEntities'),
    appends,
    workerResponses,
    // Coalescing is healthy, not a fault: chunks arrived faster than the worker
    // could answer and were folded together instead of queued. Reported as 0 when
    // the worker never answered at all — `appends - 0` would otherwise claim every
    // append was coalesced on a main-thread parse, where no coalescing happened.
    coalesced: workerResponses > 0 ? Math.max(0, appends - workerResponses) : 0,
    tokensPrefixMatched,
    tokensReturned,
    tokenPrefixReuseRatio: diffedTokens > 0 ? tokensPrefixMatched / diffedTokens : 0,
    lexerMs: numberField(descriptor, 'lexerMs'),
    sourceCharsLexed: numberField(descriptor, 'sourceCharsLexed'),
    workerMsAvg: numberField(descriptor, 'workerMsAvg'),
    workerMsMax: numberField(descriptor, 'workerMsMax'),
    stablePrefixChars: numberField(descriptor, 'stablePrefixChars'),
    changedTailChars,
    entitiesReused: numberField(descriptor, 'entitiesReused'),
    entitiesRebuilt: numberField(descriptor, 'entitiesRebuilt'),
    inPlaceUpdates: numberField(descriptor, 'inPlaceUpdates'),
    tailFraction: sourceLength > 0 ? changedTailChars / sourceLength : 0,
    notes: descriptor.notes ?? [],
  };
}

/** Render the readout as rows. */
export function formatMarkdownStream(info: MarkdownStreamInfo): PluginRow[] {
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const rows: PluginRow[] = [
    {
      label: 'source',
      value: `${info.sourceLength} chars`,
      note: `${info.topLevelTokens} tokens`,
    },
    {
      label: 'appends',
      value: String(info.appends),
      note: info.coalesced > 0 ? `${info.coalesced} coalesced` : undefined,
    },
    {
      label: 'worker',
      value: `${info.workerResponses} responses`,
      note:
        info.workerResponses > 0
          ? `avg ${info.workerMsAvg}ms max ${info.workerMsMax}ms`
          : 'none yet',
    },
    {
      label: 'token prefix reuse',
      value: pct(info.tokenPrefixReuseRatio),
      note: `${info.tokensPrefixMatched} matched / ${info.tokensReturned} returned`,
    },
    {
      label: 'lexer',
      value: `${Math.round(info.lexerMs * 10) / 10}ms`,
      note: `${info.sourceCharsLexed} chars lexed — the whole source, every append`,
    },
    {
      label: 'last delta',
      value: `${info.changedTailChars} chars changed`,
      note: `${pct(info.tailFraction)} of document`,
    },
    { label: 'stable prefix', value: `${info.stablePrefixChars} chars` },
    {
      label: 'entities',
      value: `${info.entitiesReused} reused / ${info.entitiesRebuilt} rebuilt`,
      note: info.inPlaceUpdates > 0 ? `${info.inPlaceUpdates} in-place` : undefined,
    },
  ];
  for (const note of info.notes) rows.push({ label: 'note', value: note });
  return rows;
}

/** Above this share of the document CHANGED per append, the delta is not a delta. */
const TAIL_FRACTION_LIMIT = 0.5;
/** Below this token reuse ratio, the incremental path is not paying off. */
const REUSE_RATIO_FLOOR = 0.5;
/**
 * Worker round trip above which a chunk cannot be absorbed in one frame.
 *
 * Two frames at 240Hz (8.3ms): one round trip that overruns a single frame is
 * normal under load, but a worst case past two has certainly dropped one.
 */
const WORKER_MS_LIMIT = 8.3;

/** The streaming inspector, as a plugin inspector. */
export const markdownStreamInspector: PluginInspector = {
  id: 'markdown-stream',
  label: 'MD',
  appliesTo: isMarkdownEntity,
  rows: ({ selection }) => {
    const info = inspectMarkdownStream(selection);
    return info ? formatMarkdownStream(info) : [];
  },
};

/**
 * Audit every Markdown entity in the scene for streaming pathologies.
 *
 * Reports the tail fraction separately from the prefix-reuse ratio because they fail
 * independently: a document can match most of its tokens while the changed tail still
 * covers most of its characters. Note neither explains lexer cost, which is
 * O(document) per append by construction — `lexerMs` is the field for that.
 */
export function auditMarkdownStreaming(scene: Scene): PluginFinding[] {
  const findings: PluginFinding[] = [];
  const walk = (entity: Entity): void => {
    const info = inspectMarkdownStream(entity);
    if (info && info.appends > 0) {
      if (info.tailFraction > TAIL_FRACTION_LIMIT && info.sourceLength > 200) {
        findings.push({
          kind: 'tail-not-a-delta',
          entityId: entity.id,
          severity: 'warn',
          message: `last append changed ${info.changedTailChars} of ${info.sourceLength} chars (${Math.round(info.tailFraction * 100)}%), so the delta is nearly the whole document and almost nothing is reused`,
        });
      }
      if (info.tokenPrefixReuseRatio > 0 && info.tokenPrefixReuseRatio < REUSE_RATIO_FLOOR) {
        findings.push({
          kind: 'low-token-reuse',
          entityId: entity.id,
          severity: 'warn',
          message: `only ${Math.round(info.tokenPrefixReuseRatio * 100)}% of tokens matched the prior prefix, so most entities are rebuilt per chunk`,
        });
      }
      if (info.workerMsMax > WORKER_MS_LIMIT) {
        findings.push({
          kind: 'slow-worker-roundtrip',
          entityId: entity.id,
          severity: 'info',
          message: `worst lex round trip ${info.workerMsMax}ms, past a two-frame budget at 240Hz`,
        });
      }
      if (info.workerResponses === 0) {
        findings.push({
          kind: 'no-worker',
          entityId: entity.id,
          severity: 'info',
          message:
            'no worker responses: parsing ran on the main thread, or the first request is in flight',
        });
      }
      if (info.entitiesRebuilt > info.entitiesReused && info.appends > 2) {
        findings.push({
          kind: 'entities-mostly-rebuilt',
          entityId: entity.id,
          severity: 'warn',
          message: `${info.entitiesRebuilt} entities rebuilt vs ${info.entitiesReused} reused; the reconciler is not matching the prefix`,
        });
      }
    }
    for (const child of entity.children) walk(child);
  };
  walk(scene.rootEntity);
  return findings;
}

/** The streaming audit, as a plugin audit. */
export const markdownStreamAudit: PluginAudit = {
  id: 'streaming',
  run: ({ scene }) => auditMarkdownStreaming(scene),
};
