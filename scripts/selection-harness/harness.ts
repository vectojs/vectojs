// Reusable in-page reporter for the selection harness (CTX-0018). The actual
// DOM-vs-canvas selection-overlap check lives in @vectojs/devtools
// (`auditSceneSelection`) — authoritative projection geometry, no fragile
// fillText-trace text matching. This module just runs that audit on a real
// browser, POSTs the findings to `/results` for the shell driver, and paints an
// on-page <pre> so screenshots capture the verdict too.
//
// The whole point is REAL hardware: the audit needs live DOM layout + Range
// geometry, and the drift sources (bidi reorder, justify gaps, ligation,
// fractional DPR/zoom) only appear on a real Chrome/Firefox at a real scale.
import type { Scene } from '@vectojs/core';
import { auditSceneSelection, type SelectionAuditOptions } from '@vectojs/devtools';

export async function reportSelectionAudit(
  scene: Scene,
  opts: SelectionAuditOptions = {},
): Promise<void> {
  const findings = auditSceneSelection(scene, opts);
  const verdict = {
    engine: /Firefox/.test(navigator.userAgent) ? 'firefox' : 'chrome',
    dpr: window.devicePixelRatio,
    clean: findings.length === 0,
    findings,
  };
  (window as unknown as { __SELECTION_AUDIT__?: unknown }).__SELECTION_AUDIT__ = verdict;
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(verdict),
    });
  } catch {
    /* screenshot-only mode: no server to POST to */
  }
  const pre = document.createElement('pre');
  pre.id = 'selection-audit';
  pre.style.cssText =
    'position:fixed;left:12px;bottom:12px;margin:0;padding:8px;color:#e2e8f0;font:12px monospace;white-space:pre-wrap;background:#0f172a;max-width:920px;z-index:9999;';
  pre.textContent =
    (verdict.clean ? '✓ selection clean' : `✗ ${findings.length} drift`) +
    ` (${verdict.engine} dpr=${verdict.dpr})\n` +
    JSON.stringify(findings, null, 2);
  document.body.appendChild(pre);
  document.title = 'selection-audit ready';
}
