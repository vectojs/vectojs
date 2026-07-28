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
  tokensReused: number;
  tokensRelexed: number;
  reuseRatio: number;
  workerMsAvg: number;
  workerMsMax: number;
  stablePrefixChars: number;
  changedTailChars: number;
  entitiesReused: number;
  entitiesRebuilt: number;
  inPlaceUpdates: number;
  /**
   * Fraction of the document re-lexed on the most recent append.
   *
   * This is the number that answers the O(appended) vs O(document) question, and
   * it can be bad while the token reuse ratio looks healthy: reusing 95% of tokens
   * still means re-reading the whole tail if the tail is most of the characters.
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
 * of the document re-lexed on the last append.
 */
export function inspectMarkdownStream(entity: Entity): MarkdownStreamInfo | null {
  const descriptor = readDescriptor(entity);
  if (descriptor?.kind !== 'Markdown') return null;

  const sourceLength = numberField(descriptor, 'sourceLength');
  const appends = numberField(descriptor, 'appends');
  const workerResponses = numberField(descriptor, 'workerResponses');
  const tokensReused = numberField(descriptor, 'tokensReused');
  const tokensRelexed = numberField(descriptor, 'tokensRelexed');
  const changedTailChars = numberField(descriptor, 'changedTailChars');
  const lexed = tokensReused + tokensRelexed;

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
    tokensReused,
    tokensRelexed,
    reuseRatio: lexed > 0 ? tokensReused / lexed : 0,
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
      label: 'token reuse',
      value: pct(info.reuseRatio),
      note: `${info.tokensReused} reused / ${info.tokensRelexed} re-lexed`,
    },
    {
      label: 'last delta',
      value: `${info.changedTailChars} chars re-lexed`,
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

/** Above this share of the document re-lexed per append, the delta is not a delta. */
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
 * Reports the tail fraction separately from the token reuse ratio because they
 * fail independently: a document can reuse most of its tokens while still
 * re-reading most of its characters, and only the second one explains why a long
 * stream gets slower as it goes.
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
          message: `last append re-lexed ${info.changedTailChars} of ${info.sourceLength} chars (${Math.round(info.tailFraction * 100)}%), which is O(document) per chunk`,
        });
      }
      if (info.reuseRatio > 0 && info.reuseRatio < REUSE_RATIO_FLOOR) {
        findings.push({
          kind: 'low-token-reuse',
          entityId: entity.id,
          severity: 'warn',
          message: `only ${Math.round(info.reuseRatio * 100)}% of lexed tokens reused`,
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
