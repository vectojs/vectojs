import { ForceLayout2D, type GraphLink, type GraphNode } from '../src';

const canvas = document.getElementById('graph') as HTMLCanvasElement;
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D is unavailable');

const nodes: GraphNode[] = [{ id: 0 }];
const links: GraphLink[] = [];
const layout = new ForceLayout2D({
  collisionRadius: 7,
  linkDistance: 34,
  repulsion: 180,
});
layout.setGraph({ nodes, links });

let dragged = -1;
let frame = 0;

function appendPage(size = 50): void {
  const first = nodes.length;
  const addedNodes = Array.from({ length: size }, (_, offset) => ({ id: first + offset }));
  const addedLinks = addedNodes.map((node, offset) => ({
    source: offset % 4 === 0 ? 0 : Math.floor((first + offset) / 2),
    target: node.id,
  }));
  nodes.push(...addedNodes);
  links.push(...addedLinks);
  layout.appendGraph({ nodes: addedNodes, links: addedLinks });
}

function resize(): void {
  const dpr = devicePixelRatio;
  const width = Math.round(innerWidth * dpr);
  const height = Math.round(innerHeight * dpr);
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw(): void {
  resize();
  const width = innerWidth;
  const height = innerHeight;
  const positions = layout.positions;
  context.clearRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, height / 2);

  context.strokeStyle = 'rgba(106, 168, 255, 0.22)';
  context.lineWidth = 1;
  context.beginPath();
  for (const link of links) {
    const source = Number(link.source) * 2;
    const target = Number(link.target) * 2;
    context.moveTo(positions[source], positions[source + 1]);
    context.lineTo(positions[target], positions[target + 1]);
  }
  context.stroke();

  for (let index = 0; index < nodes.length; index++) {
    context.beginPath();
    context.arc(
      positions[index * 2],
      positions[index * 2 + 1],
      index === 0 ? 8 : 4,
      0,
      Math.PI * 2,
    );
    context.fillStyle = index === dragged ? '#ffcf66' : index === 0 ? '#f08b55' : '#70b7ff';
    context.fill();
  }
  context.restore();

  context.fillStyle = '#d7e7ff';
  context.font = '14px system-ui, sans-serif';
  context.fillText(`${nodes.length} nodes | double-click to append 50 | drag to pin`, 18, 28);

  if (layout.step()) frame = requestAnimationFrame(draw);
  else frame = 0;
}

function graphPoint(event: PointerEvent): [number, number] {
  return [event.clientX - innerWidth / 2, event.clientY - innerHeight / 2];
}

canvas.addEventListener('dblclick', () => {
  appendPage();
  if (!frame) frame = requestAnimationFrame(draw);
});

canvas.addEventListener('pointerdown', (event) => {
  const [x, y] = graphPoint(event);
  const positions = layout.positions;
  let bestDistance = 100;
  for (let index = 0; index < nodes.length; index++) {
    const dx = positions[index * 2] - x;
    const dy = positions[index * 2 + 1] - y;
    const distance = dx * dx + dy * dy;
    if (distance >= bestDistance) continue;
    dragged = index;
    bestDistance = distance;
  }
  if (dragged < 0) return;
  canvas.setPointerCapture(event.pointerId);
  layout.pinNode(dragged, x, y);
  layout.reheat();
  if (!frame) frame = requestAnimationFrame(draw);
});

canvas.addEventListener('pointermove', (event) => {
  if (dragged < 0) return;
  const [x, y] = graphPoint(event);
  layout.pinNode(dragged, x, y);
  layout.reheat();
});

function releasePointer(): void {
  if (dragged < 0) return;
  layout.unpinNode(dragged);
  dragged = -1;
  layout.reheat();
  if (!frame) frame = requestAnimationFrame(draw);
}

canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
addEventListener('resize', () => {
  if (!frame) frame = requestAnimationFrame(draw);
});

appendPage();
frame = requestAnimationFrame(draw);
