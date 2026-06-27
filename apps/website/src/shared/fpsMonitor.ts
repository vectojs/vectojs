/**
 * Shared FPS + Memory monitor for all VectoUI demos.
 * Call `setupFPSMonitor(label, isRunningRef)` to attach a live counter.
 */

/**
 * Append a live FPS/memory counter to the bottom-right corner of the page.
 *
 * @param label - Short demo name shown after the FPS reading.
 * @param getRunning - Callback that returns `false` when the demo is torn down (HMR).
 */
export function setupFPSMonitor(label: string, getRunning: () => boolean): void {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;bottom:10px;right:10px;
    color:#38bdf8;font-family:monospace;font-size:14px;
    pointer-events:none;z-index:9998;
    background:rgba(0,0,0,0.5);padding:4px 8px;border-radius:4px;
  `;
  document.body.appendChild(el);

  let frames = 0;
  let lastTime = performance.now();

  function tick() {
    if (!getRunning()) return;
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      const mem = (performance as any).memory;
      const memStr = mem ? ` | ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB` : '';
      el.textContent = `${frames} FPS${memStr} | ${label}`;
      frames = 0;
      lastTime = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
