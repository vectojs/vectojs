const hash = window.location.hash || '#physics';

async function loadDemo() {
  if (hash === '#ui-components') {
    await import('./ui-components.ts');
  } else if (hash === '#physics') {
    await import('./physics.ts');
  } else if (hash === '#bad-apple-lyrics') {
    await import('./bad-apple-lyrics.ts');
  } else if (hash === '#bad-apple-classic') {
    await import('./bad-apple-classic.ts');
  } else if (hash === '#bad-apple-variable') {
    await import('./bad-apple-variable.ts');
  } else if (hash === '#tight-bubbles') {
    await import('./tight-bubbles.ts');
  } else {
    await import('./physics.ts');
  }
}

loadDemo();
