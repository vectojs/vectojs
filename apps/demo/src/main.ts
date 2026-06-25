const hash = window.location.hash || '#physics';

async function loadDemo() {
  if (hash === '#physics') {
    await import('./physics.ts');
  } else if (hash === '#bad-apple-lyrics') {
    await import('./bad-apple-lyrics.ts');
  } else if (hash === '#bad-apple-classic') {
    await import('./bad-apple-classic.ts');
  } else {
    await import('./physics.ts');
  }
}

loadDemo();
