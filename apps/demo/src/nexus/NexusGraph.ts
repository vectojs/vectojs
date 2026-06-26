import { Entity, type IRenderer } from '@vecto-ui/core';

export class NexusNode extends Entity {
  public vx = 0;
  public vy = 0;
  public radius: number;
  public color: string;
  public mass: number;

  constructor(x: number, y: number, radius: number, color: string) {
    super();
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.color = color;
    this.mass = radius * 0.5;
    this.interactive = false; // Fast path!
  }

  getBatchCircle() {
    return { radius: this.radius, color: this.color };
  }

  getBounds() {
    return { x: -this.radius, y: -this.radius, width: this.radius * 2, height: this.radius * 2 };
  }

  render() {}
}

export class NexusGraph extends Entity {
  public nodes: NexusNode[] = [];
  public edges: { a: NexusNode; b: NexusNode; rest: number; alpha: number }[] = [];
  public physicsEnabled = true;
  private rippleActive = false;
  private rippleX = 0;
  private rippleY = 0;
  private pointerDown = false;

  constructor(count: number) {
    super('NexusGraph');
    this.interactive = true; // Receive pointer events

    // Create Nodes
    const colors = ['#00f0ff', '#ff00aa', '#0a84ff', '#bf5af2'];
    for (let i = 0; i < count; i++) {
      const radius = Math.random() * 2 + 1;
      const x = (Math.random() - 0.5) * window.innerWidth * 2.5;
      const y = (Math.random() - 0.5) * window.innerHeight * 2.5;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const node = new NexusNode(x, y, radius, color);
      this.nodes.push(node);
      this.add(node);
    }

    // Connect some edges (Spatial clustering simulation without O(N^2) overhead)
    // We'll connect nodes that are close-ish initially.
    // To do this quickly, just connect consecutive nodes or random nodes.
    this.addNodes(count);

    this.on('pointerdown', (e) => {
      this.pointerDown = true;
      this.rippleActive = true;
      this.rippleX = e.clientX;
      this.rippleY = e.clientY;
    });

    this.on('pointerup', () => {
      this.pointerDown = false;
    });

    this.on('pointermove', (e) => {
      if (this.pointerDown) {
        this.rippleX = e.clientX;
        this.rippleY = e.clientY;
      } else {
        // Light ripple on hover
        this.rippleActive = true;
        this.rippleX = e.clientX;
        this.rippleY = e.clientY;
      }
    });

    this.on('pointerleave', () => {
      this.rippleActive = false;
      this.pointerDown = false;
    });
  }

  isPointInside() {
    return true; // Catch all pointer events on the screen
  }

  addNodes(count: number) {
    const colors = ['#00f0ff', '#ff00aa', '#0a84ff', '#bf5af2'];
    const startIndex = this.nodes.length;
    for (let i = 0; i < count; i++) {
      const radius = Math.random() * 2 + 1;
      const x = (Math.random() - 0.5) * window.innerWidth * 2.5;
      const y = (Math.random() - 0.5) * window.innerHeight * 2.5;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const node = new NexusNode(x, y, radius, color);
      this.nodes.push(node);
      this.add(node);
    }
    const total = this.nodes.length;
    for (let i = 0; i < count * 1.5; i++) {
      const a = this.nodes[Math.floor(Math.random() * count) + startIndex];
      const b = this.nodes[Math.floor(Math.random() * total)];
      if (a === b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 400) {
        this.edges.push({ a, b, rest: dist * 0.8, alpha: Math.random() * 0.4 + 0.1 });
      }
    }
  }

  update(dt: number) {
    if (!this.physicsEnabled) return;

    const friction = 0.92;
    const centerGravity = 0.0005;
    const frames = Math.min(dt, 32) / 16.67;

    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    // 1. Spring Forces (O(E))
    for (const edge of this.edges) {
      const dx = edge.b.x - edge.a.x;
      const dy = edge.b.y - edge.a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.1) {
        const diff = dist - edge.rest;
        // Hooke's law: F = -k * x
        const force = diff * 0.001;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        edge.a.vx += fx * frames;
        edge.a.vy += fy * frames;
        edge.b.vx -= fx * frames;
        edge.b.vy -= fy * frames;
      }
    }

    // 2. Ripple & Gravity & Integration (O(N))
    for (const node of this.nodes) {
      // Ripple (Mouse Repulsion)
      if (this.rippleActive) {
        const dx = node.x - this.rippleX;
        const dy = node.y - this.rippleY;
        const dist = Math.hypot(dx, dy) || 0.1;
        const radius = this.pointerDown ? 400 : 250;
        if (dist < radius) {
          const force = (1 - dist / radius) * (this.pointerDown ? 8 : 2);
          node.vx += (dx / dist) * force * frames;
          node.vy += (dy / dist) * force * frames;
        }
      }

      // Center Gravity
      node.vx += (cx - node.x) * centerGravity * frames;
      node.vy += (cy - node.y) * centerGravity * frames;

      // Integration
      node.vx *= friction;
      node.vy *= friction;
      node.x += node.vx * frames;
      node.y += node.vy * frames;
    }
  }

  render(r: IRenderer) {
    r.beginPath();
    r.setGlobalAlpha(0.15);

    for (const edge of this.edges) {
      // Cull edges that are too long (they broke the spring and fly across the screen)
      const dx = edge.a.x - edge.b.x;
      const dy = edge.a.y - edge.b.y;
      if (dx * dx + dy * dy > 60000) continue;
      r.moveTo(edge.a.x, edge.a.y);
      r.lineTo(edge.b.x, edge.b.y);
    }
    r.stroke('#00f0ff', 1);
  }
}
