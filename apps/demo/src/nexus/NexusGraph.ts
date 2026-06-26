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
  private lastW = window.innerWidth;
  private lastH = window.innerHeight;
  private currentColors = ['#00f0ff', '#ff00aa', '#0a84ff', '#bf5af2'];

  constructor(count: number) {
    super('NexusGraph');
    this.interactive = true; // Receive pointer events
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    // Create Nodes
    for (let i = 0; i < count; i++) {
      const radius = Math.random() * 2 + 1;
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      const color = this.currentColors[Math.floor(Math.random() * this.currentColors.length)];
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
    const startIndex = this.nodes.length;
    for (let i = 0; i < count; i++) {
      const radius = Math.random() * 2 + 1;
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      const color = this.currentColors[Math.floor(Math.random() * this.currentColors.length)];
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

  removeNodes(count: number) {
    const removeCount = Math.min(count, this.nodes.length);
    if (removeCount <= 0) return;

    const removed = this.nodes.splice(this.nodes.length - removeCount, removeCount);
    for (const node of removed) {
      this.remove(node);
    }

    const removedSet = new Set(removed);
    this.edges = this.edges.filter((e) => !removedSet.has(e.a) && !removedSet.has(e.b));
  }

  changeTheme(theme: string) {
    switch (theme) {
      case 'Matrix':
        this.currentColors = ['#00ff00', '#33ff33', '#00cc00', '#ccffcc'];
        break;
      case 'Fire':
        this.currentColors = ['#ff0000', '#ff5a00', '#ff9a00', '#ffce00'];
        break;
      case 'Monochrome':
        this.currentColors = ['#ffffff', '#cccccc', '#999999', '#666666'];
        break;
      case 'Cyberpunk':
      default:
        this.currentColors = ['#00f0ff', '#ff00aa', '#0a84ff', '#bf5af2'];
        break;
    }
    for (const node of this.nodes) {
      node.color = this.currentColors[Math.floor(Math.random() * this.currentColors.length)];
    }
  }

  update(dt: number) {
    // Handle Window Resize explicitly to stretch the universe
    // This prevents the particles from clustering in the top-left when maximizing
    if (this.lastW !== window.innerWidth || this.lastH !== window.innerHeight) {
      const scaleX = window.innerWidth / this.lastW;
      const scaleY = window.innerHeight / this.lastH;
      for (const node of this.nodes) {
        node.x *= scaleX;
        node.y *= scaleY;
      }
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.lastW = window.innerWidth;
      this.lastH = window.innerHeight;
    }

    if (!this.physicsEnabled) return;

    const friction = 0.94;
    const frames = Math.min(dt, 32) / 16.67;

    const padding = 100;
    const domainW = window.innerWidth + padding * 2;
    const domainH = window.innerHeight + padding * 2;

    // 1. Spring Forces (O(E)) with Toroidal Topology
    for (const edge of this.edges) {
      let dx = edge.b.x - edge.a.x;
      let dy = edge.b.y - edge.a.y;

      if (dx > domainW / 2) dx -= domainW;
      else if (dx < -domainW / 2) dx += domainW;
      if (dy > domainH / 2) dy -= domainH;
      else if (dy < -domainH / 2) dy += domainH;

      const dist = Math.hypot(dx, dy);
      if (dist > 0.1) {
        const diff = dist - edge.rest;
        // Hooke's law: F = -k * x
        const force = diff * 0.0005;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        edge.a.vx += fx * frames;
        edge.a.vy += fy * frames;
        edge.b.vx -= fx * frames;
        edge.b.vy -= fy * frames;
      }
    }

    // 2. Ripple & Wandering & Integration (O(N))
    for (const node of this.nodes) {
      // Ripple (Mouse Repulsion)
      if (this.rippleActive) {
        let dx = node.x - this.rippleX;
        let dy = node.y - this.rippleY;
        // Apply toroidal wrap to mouse interaction too!
        if (dx > domainW / 2) dx -= domainW;
        else if (dx < -domainW / 2) dx += domainW;
        if (dy > domainH / 2) dy -= domainH;
        else if (dy < -domainH / 2) dy += domainH;

        const dist = Math.hypot(dx, dy) || 0.1;
        const radius = this.pointerDown ? 450 : 350;
        if (dist < radius) {
          const intensity = Math.pow(1 - dist / radius, 2);
          const force = intensity * (this.pointerDown ? 15 : 8);
          node.vx += (dx / dist) * force * frames;
          node.vy += (dy / dist) * force * frames;
        }
      }

      // Gentle drift
      node.vx += (Math.random() - 0.5) * 0.1 * frames;
      node.vy += (Math.random() - 0.5) * 0.1 * frames;

      // Integration
      node.vx *= friction;
      node.vy *= friction;
      node.x += node.vx * frames;
      node.y += node.vy * frames;

      // Toroidal Wrap
      if (node.x < -padding) node.x += domainW;
      else if (node.x > window.innerWidth + padding) node.x -= domainW;

      if (node.y < -padding) node.y += domainH;
      else if (node.y > window.innerHeight + padding) node.y -= domainH;
    }
  }

  render(r: IRenderer) {
    r.beginPath();
    r.setGlobalAlpha(0.15);

    let count = 0;
    for (const edge of this.edges) {
      let dx = edge.a.x - edge.b.x;
      let dy = edge.a.y - edge.b.y;
      // Cull wrapped edges (they span across the screen)
      if (Math.abs(dx) > window.innerWidth / 2 || Math.abs(dy) > window.innerHeight / 2) continue;
      // Cull broken edges
      if (dx * dx + dy * dy > 60000) continue;
      r.moveTo(edge.a.x, edge.a.y);
      r.lineTo(edge.b.x, edge.b.y);

      count++;
      // Chunk the stroke path to fix Firefox's superlinear path rasterization performance
      if (count >= 400) {
        r.stroke('#00f0ff', 1);
        r.beginPath();
        count = 0;
      }
    }

    if (count > 0) {
      r.stroke('#00f0ff', 1);
    }
  }
}
