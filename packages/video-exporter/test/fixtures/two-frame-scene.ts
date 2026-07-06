const canvas = document.querySelector('canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Fixture canvas is missing');

const context = canvas.getContext('2d');
if (!context) throw new Error('Fixture 2D context is unavailable');

let frame = 0;
(window as unknown as { vectoScene: { stop(): void; step(dt: number): void } }).vectoScene = {
  stop() {},
  step(dt) {
    frame += 1;
    context.fillStyle = frame % 2 === 0 ? '#00ff88' : '#6633ff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.fillText(`${frame}:${dt}`, 4, 12);
  },
};
