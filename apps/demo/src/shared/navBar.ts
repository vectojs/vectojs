/**
 * Shared navigation bar for all VectoUI demos.
 * Each demo calls `setupNavBar(currentHash)` to render a consistent top bar.
 */

export type DemoHash =
  | '#ui-components'
  | '#spline'
  | '#tight-bubbles'
  | '#physics'
  | '#bad-apple-lyrics'
  | '#bad-apple-classic'
  | '#bad-apple-variable';

const DEMOS: { hash: DemoHash; label: string }[] = [
  { hash: '#ui-components', label: '🧩 UI Components' },
  { hash: '#spline', label: '🌀 Spline (vectomancy)' },
  { hash: '#tight-bubbles', label: '💬 Tight Bubbles' },
  { hash: '#physics', label: '📚 Physics Text' },
  { hash: '#bad-apple-lyrics', label: '🎵 Lyrics Reflow' },
  { hash: '#bad-apple-classic', label: '🍎 Classic Matrix' },
  { hash: '#bad-apple-variable', label: '✨ Variable Font ASCII' },
];

/**
 * Append a shared navigation bar to `document.body`.
 *
 * @param current - The hash of the currently active demo, used to highlight the active link.
 */
export function setupNavBar(current: DemoHash): void {
  const nav = document.createElement('nav');
  nav.id = 'vecto-nav';
  nav.style.cssText = `
    position:fixed;top:0;left:0;width:100%;z-index:9999;
    background:rgba(0,0,0,0.85);color:white;
    padding:0 16px;height:44px;box-sizing:border-box;
    font-family:monospace;font-size:13px;
    display:flex;gap:18px;align-items:center;
    border-bottom:1px solid #334155;
    backdrop-filter:blur(8px);
  `;

  const brand = document.createElement('b');
  brand.style.color = '#38bdf8';
  brand.style.marginRight = '4px';
  brand.textContent = 'VectoUI';
  nav.appendChild(brand);

  for (const demo of DEMOS) {
    const a = document.createElement('a');
    a.href = demo.hash;
    a.textContent = demo.label;
    const isActive = demo.hash === current;
    a.style.cssText = `
      color:${isActive ? '#fca5a5' : '#94a3b8'};
      text-decoration:none;
      font-weight:${isActive ? '600' : '400'};
      transition:color 0.15s;
    `;
    a.addEventListener('mouseenter', () => {
      if (!isActive) a.style.color = '#e2e8f0';
    });
    a.addEventListener('mouseleave', () => {
      if (!isActive) a.style.color = '#94a3b8';
    });
    a.addEventListener('click', () => {
      setTimeout(() => location.reload(), 10);
    });
    nav.appendChild(a);
  }

  document.body.appendChild(nav);
}
