const STRIDE = 6;
const kRest = 0.02;
const kNeighbor = 0.15;
const damp = 0.75;
const maxV = 20;

self.onmessage = (e: MessageEvent) => {
  const { type, buffer, count, isDragging, mouseX, mouseY } = e.data;
  if (type !== 'update') return;

  const arr = new Float32Array(buffer);

  for (let i = 0; i < count; i++) {
    const xi = i * STRIDE;
    let x = arr[xi],
      y = arr[xi + 1],
      vx = arr[xi + 2],
      vy = arr[xi + 3];
    const tx = arr[xi + 4],
      ty = arr[xi + 5];

    let fx = (tx - x) * kRest;
    let fy = (ty - y) * kRest;

    if (i > 0) {
      const li = (i - 1) * STRIDE;
      if (Math.abs(arr[li + 5] - ty) < 10) {
        fx += (arr[li] + (tx - arr[li + 4]) - x) * kNeighbor;
        fy += (arr[li + 1] + (ty - arr[li + 5]) - y) * kNeighbor;
      }
    }
    if (i < count - 1) {
      const ri = (i + 1) * STRIDE;
      if (Math.abs(arr[ri + 5] - ty) < 10) {
        fx += (arr[ri] + (tx - arr[ri + 4]) - x) * kNeighbor;
        fy += (arr[ri + 1] + (ty - arr[ri + 5]) - y) * kNeighbor;
      }
    }

    if (isDragging) {
      const dx = mouseX - x;
      const dy = mouseY - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 150 && dist > 0) {
        const force = (150 - dist) * 0.15;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }
    }

    vx = (vx + fx) * damp;
    vy = (vy + fy) * damp;

    const vMag = Math.sqrt(vx * vx + vy * vy);
    if (vMag > maxV) {
      vx = (vx / vMag) * maxV;
      vy = (vy / vMag) * maxV;
    }

    arr[xi] = x + vx;
    arr[xi + 1] = y + vy;
    arr[xi + 2] = vx;
    arr[xi + 3] = vy;
  }

  self.postMessage({ type: 'done', buffer, count });
};
