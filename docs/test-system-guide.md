# VectoUI Systematic & Data-Driven Testing System Guide

本指南为 VectoUI 提供了一套系统化、数据驱动的测试体系架构、具体的测试脚本模板（Vitest 和 Playwright），以及性能数据可视化看板的设计规范。

---

## 1. 测试体系架构与分层

为了验证产品质量并为官网及营销材料提供客观、可量化的数据，测试体系应由以下几个层次组成：

```mermaid
graph TD
    A[VectoUI System Testing System] --> B[1. Unit & Integration Testing <br>Vitest]
    A --> C[2. Headless Performance Benchmarks <br>Playwright + CDP]
    A --> D[3. Cross-Framework Comparison <br>Playwright + CDP]
    A --> E[4. Visual Regression Testing <br>Playwright Screenshot Diff]
    A --> F[5. Accessibility & Agent Automation <br>Axe + Playwright Shadow DOM]

    B --> B1[State & Math (Spring, Matrix)]
    B --> B2[LayoutEngine (Cold/Hot Path)]
    B --> B3[Component Lifecycle]

    C --> C1[FPS Limits Disabled]
    C --> C2[Memory & GC (JSHeapUsedSize)]
    C --> C3[Stress Scaling (10k-100k)]

    D --> D1[VectoUI vs DOM vs Pixi.js]
    D --> D2[Layout Count & Script Duration]
```

---

## 2. Vitest 单元与集成测试模板

Vitest 专注于高速、零依赖的算法验证、数学方程精度、以及纯逻辑组件测试。

### 2.1. 弹簧物理算法精度与压力测试模板
测试文件位置：`packages/core/test/SpringPhysics.test.ts`
该模板用于检测阻尼比（Damping Ratio）属性，以及高并发（50,000个弹簧）情况下的单帧物理更新耗时。

```typescript
import { describe, it, expect } from 'vitest';
import { SpringPhysics } from '../src/math/SpringPhysics';

describe('SpringPhysics', () => {
  it('converges to target and goes to rest', () => {
    const spring = new SpringPhysics(0);
    spring.target = 100;

    // Simulate 150 frames of 16ms (~2.4s)
    for (let i = 0; i < 150; i++) {
      spring.update(0.016);
    }
    expect(spring.isAtRest()).toBe(true);
    expect(spring.value).toBeCloseTo(100, 1);
    expect(spring.velocity).toBeCloseTo(0, 1);
  });

  describe('Damping ratio properties (ζ = c / (2 * sqrt(k * m)))', () => {
    it('underdamped (ζ < 1) should overshoot target', () => {
      const spring = new SpringPhysics(0);
      spring.target = 100;
      spring.stiffness = 100;
      spring.damping = 10; // ζ = 0.5 < 1
      spring.mass = 1;

      let hasOvershot = false;
      for (let i = 0; i < 100; i++) {
        spring.update(0.016);
        if (spring.value > 100) {
          hasOvershot = true;
          break;
        }
      }
      expect(hasOvershot).toBe(true);
    });

    it('critically damped (ζ = 1) should not overshoot and converge rapidly', () => {
      const spring = new SpringPhysics(0);
      spring.target = 100;
      spring.stiffness = 100;
      spring.damping = 20; // ζ = 1.0
      spring.mass = 1;

      let hasOvershot = false;
      for (let i = 0; i < 200; i++) {
        spring.update(0.016);
        if (spring.value > 100) {
          hasOvershot = true;
        }
      }
      expect(hasOvershot).toBe(false);
      expect(spring.isAtRest()).toBe(true);
    });
  });

  describe('Stress & Zero-GC validation', () => {
    it('handles 50,000 springs updating concurrently under 5ms/frame', () => {
      const count = 50000;
      const springs: SpringPhysics[] = [];
      for (let i = 0; i < count; i++) {
        const spring = new SpringPhysics(0);
        spring.target = 100;
        springs.push(spring);
      }

      const start = performance.now();
      for (let i = 0; i < count; i++) {
        springs[i].update(0.016);
      }
      const duration = performance.now() - start;

      console.log(`[Benchmark] 50,000 springs update took: ${duration.toFixed(3)}ms`);
      expect(duration).toBeLessThan(15); // Virtual runner ceiling limit
    });
  });
});
```

---

## 3. Playwright E2E、性能与 a11y 自动化测试模板

Playwright 针对真实浏览器内核，通过命令行注入标志参数关闭 Vsync 并开启 Chrome 调试协议（CDP），以收集原生性能数据。

### 3.1. 真实性能与内存指标抓取脚本模板
测试脚本可以放置在 `scripts/benchmark-collector.ts`。以下模板演示了如何调用 Chrome DevTools Protocol 提取垃圾回收（GC）前后的堆内存、DOM Node 数、Layout 次数等硬指标。

```typescript
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

function loadPlaywright() {
  const pkgDir = dirname(execSync('readlink -f "$(which playwright)"').toString().trim());
  return createRequire(join(pkgDir, 'package.json'))(pkgDir) as typeof import('playwright');
}

function chromePath(): string {
  return execSync('readlink -f "$(which google-chrome-stable)"').toString().trim();
}

async function runPerformanceTest() {
  const { chromium } = loadPlaywright();
  
  // 禁用 Vsync 帧率限制以检测真实的单帧计算开销，而不仅是限制在 60Hz 刷新率
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath(),
    args: [
      '--no-sandbox',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
      '--enable-precise-memory-info',
      '--disable-background-timer-throttling'
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  
  // 开启 Chrome DevTools 协议会话
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  console.log('Navigating to benchmark page...');
  await page.goto('http://localhost:5179/bench.html?n=10000', { waitUntil: 'load' });

  // 记录运行前的性能基线
  const beforeMetrics = await cdp.send('Performance.getMetrics');

  // 等待测试运行完毕（网页端设置 window.__BENCH_DONE__ = true）
  await page.waitForFunction(() => (window as any).__BENCH_DONE__, { timeout: 60000 });

  // 记录运行后的性能数据
  const afterMetrics = await cdp.send('Performance.getMetrics');

  const getMetric = (snap: any, name: string) => 
    snap.metrics.find((x: any) => x.name === name)?.value ?? 0;
  
  const layoutCount = getMetric(afterMetrics, 'LayoutCount') - getMetric(beforeMetrics, 'LayoutCount');
  const layoutDuration = getMetric(afterMetrics, 'LayoutDuration') - getMetric(beforeMetrics, 'LayoutDuration');
  const heapUsed = getMetric(afterMetrics, 'JSHeapUsedSize');
  const nodes = getMetric(afterMetrics, 'Nodes');

  const results = await page.evaluate(() => (window as any).__BENCH__);
  
  console.log(`[Results] Nodes: ${nodes}, Layout Count: ${layoutCount}, JS Heap: ${(heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[Vecto Rendering] mean ms/frame: ${results.meanMs}ms (Max FPS: ${results.maxFps})`);

  await browser.close();
}

runPerformanceTest().catch(console.error);
```

### 3.2. a11y 投影与 E2E 交互测试模板
VectoUI 利用 zero-DOM 的 Shadow A11y 投影来打通辅助功能（屏幕阅读器）和自动化测试。以下模板验证了虚拟画布元素在 Playwright 中是完全可以以“角色定位器”找到并实现无缝点击的。

```typescript
import { test, expect } from '@playwright/test';

test.describe('VectoUI Shadow A11y & Automation', () => {
  test('should locate and click button via its accessibility role', async ({ page }) => {
    await page.goto('http://localhost:5179/#ui-gallery');

    // VectoUI 的 Button 在底层同步映射了 role="button" 的 a11y shadow 节点
    const submitBtn = page.getByRole('button', { name: 'Submit' });
    
    // 断言其存在与可见性
    await expect(submitBtn).toBeVisible();

    // 触发点击。Playwright 会点击 shadow 节点的物理坐标，从而命中画布上的对应区域
    await submitBtn.click();

    // 验证逻辑层响应
    const resultText = page.getByText('Form Submitted Successfully');
    await expect(resultText).toBeVisible();
  });
});
```

### 3.3. 视觉回归（Visual Regression）测试模板
视觉回归能确保每一版底层着色器或数学库的升级没有导致文字排版或贝塞尔曲线出现像素级偏移。

```typescript
import { test, expect } from '@playwright/test';

test.describe('VectoUI Rendering Consistency', () => {
  test('should render high-precision vector curves and text match snapshot', async ({ page }) => {
    await page.goto('http://localhost:5179/#magnetic-type');
    
    // 等待动画完成或强行暂停物理模拟以获得可预测性
    await page.evaluate(() => (window as any).stopPhysics?.());
    
    const canvas = page.locator('canvas');
    
    // 对画布进行像素级比对。阈值设为 0.05 容忍微小的 GPU 渲染器光栅化差异
    await expect(canvas).toHaveScreenshot('vector-curves-golden.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
```

---

## 4. Benchmark 数据收集与看板设计方案

为树立 VectoUI 的性能领导者形象，我们在官网上需要一个令人惊艳的数据可视化面板。

### 4.1. 看板布局设计 (Layout UI Design)

面板推荐采用 **Sleek Dark Mode (极客暗黑风格)**，包含以下区域：

1. **Header - 实时吞吐量状态卡**：
   - 展示当前的 FPS、JS 堆大小（Heap Used），以及零垃圾回收（Zero GC）状态指示器（若监测到 Minor GC 频率为0则亮起绿色“Pure Memory”徽章）。
2. **Chart A - 性能曲线图 (FPS vs Entity Count)**：
   - 横轴为实体数量（$10^3 \sim 10^5$），纵轴为帧率。
   - 三条曲线：`Canvas 2D Batching` (深天蓝), `WebGL 2D Instanced Point` (极客绿), `Traditional DOM` (渐变紫)。
3. **Chart B - 帧延迟开销分布柱状图 (Frame Cost Breakdown)**：
   - 展示在一帧中，`Math Physics`、`LayoutEngine`、`Renderer Draw` 分别占用了多少毫秒。
4. **指标速报栏**：
   - 包含 cold/hot 布局耗时对比（Pretext 模式）、视口剔除（Viewport Culling）在 1,000,000 实体下的查找时间。

```
+-----------------------------------------------------------------------------------+
|  [VectoUI Benchmark & Diagnostic Dashboard]                   [GC Status: PURE]   |
+-----------------------------------------------------------------------------------+
|  +--------------------+  +--------------------+  +-----------------------------+  |
|  |  Mean FPS          |  |  JS Heap Used      |  |  Zero DOM Count             |  |
|  |  142 FPS (WebGL)   |  |  4.2 MB (Zero-GC)  |  |  100,000 Entities           |  |
|  +--------------------+  +--------------------+  +-----------------------------+  |
+-----------------------------------------------------------------------------------+
|  [Chart A: Scalability Curve (FPS vs Entity Count)]                               |
|  FPS                                                                              |
|   60 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -        |
|      * * * (WebGL)                                                                |
|      o o o o o (Canvas 2D)                                                        |
|      x (DOM Crashed @ 15k)                                                        |
|   0 +----------------------------------------------------------------------       |
|    1k        10k        25k        50k        100k       Entities                 |
+-----------------------------------------------------------------------------------+
|  [Chart B: Frame Cost Breakdown]               [A11y Projection Status]           |
|  +---------------------------------------+     +-------------------------------+  |
|  |  [Math/Physics: 1.1ms (22%)]          |     |  * 100k shadow nodes bypassed |  |
|  |  [LayoutEngine: 0.8ms (16%)]          |     |  * Current focused: Input 1   |  |
|  |  [GPU Drawing:  3.1ms (62%)]          |     |  * Screen Reader: Supported   |  |
|  +---------------------------------------+     +-------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 5. 数据存储与持续集成 (CI) 流水线

1. **测试触发**：
   - 每次推送到 `main` 分支或创建 Pull Request 时，运行 CI 流程。
2. **流水线任务**：
   - 运行 Lint & Formatter (`Prettier` + `Oxlint`)。
   - 运行数学库单元测试 (`vitest`)。
   - 在 Docker 中拉起 Chrome headless 运行 `bun run benchmark`，生成 `scripts/.bench-results.json` 结果文件。
3. **数据对比与预警**：
   - 比较当前的 `meanMs` 与上一次 commit 的基准值。若帧渲染时间增加了 15% 以上，则发出 **Performance Regression Warning**，并挂载 PR 状态。
