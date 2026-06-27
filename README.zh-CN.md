# VectoUI

> 一个 zero-DOM 的 Canvas 2D 实体组件系统(ECS)渲染框架 —— 纯数学驱动的 UI:把 layout、hit-testing、动画与物理全部计算后派发到单个 `<canvas>`。

[English](./README.md) · **简体中文**

[![CI](https://github.com/Xuepoo/vecto-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/Xuepoo/vecto-ui/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@vecto-ui/core)](https://www.npmjs.com/package/@vecto-ui/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 为什么是 VectoUI?

传统 DOM 框架(React、Vue)在同时动画成千上万个元素时会遇到 Reflow/Repaint 瓶颈。VectoUI 完全绕开 DOM:layout、hit-testing、动画与物理都作为纯数学运算,在一棵 **Virtual Math Tree (VMT)** 上计算,再派发给 `<canvas>` 渲染器。`a11yRoot` 影子层会把可交互实体映射为真实 DOM 节点,因此 canvas 依然可访问(accessible),也能被自动化工具 / agent 点击。

## 安装

```bash
bun add @vecto-ui/core
# 或
npm install @vecto-ui/core
```

## 快速开始

```typescript
import { Scene, Entity, IRenderer } from '@vecto-ui/core';

class CircleEntity extends Entity {
  isPointInside(x: number, y: number) {
    return Math.hypot(x - this.x, y - this.y) < 50;
  }
  render(r: IRenderer) {
    r.beginPath();
    r.arc(0, 0, 50, 0, Math.PI * 2);
    r.fill('#38bdf8');
  }
}

const canvas = document.querySelector('canvas')!;
const scene = new Scene(canvas);
scene.add(new CircleEntity().setPosition(100, 100));
scene.start();
```

## 性能实测

诚实、可复现,不做杜撰对比。用 `bun run benchmark` 复现(headless Chrome、Canvas 2D、简单填充圆形实体)。默认 vsync 受限(CI/sandbox 安全);加 `--uncapped` 得到下表的真实每帧成本。数值与机器及实体复杂度相关。

| 实体数  | 全部在屏       | 多数在屏外(culling)   | 静止空闲(`onDemand`) |
| ------- | -------------- | --------------------- | -------------------- |
| 1,000   | ~4 ms(240 fps) | ~2.4 ms(410 fps)      | ~0(帧成本 ⟂ N)       |
| 10,000  | ~19 ms(52 fps) | **~16 ms(63 fps ✅)** | ~0(帧成本 ⟂ N)       |
| 100,000 | ~156 ms(6 fps) | ~137 ms(7 fps)        | **~0(帧成本 ⟂ N)**   |

- **视口 culling**(每实体 `getBounds()`):屏外实体跳过,10k 屏外场景稳定 60 FPS。
- **按需重绘**(`scene.renderMode = 'onDemand'` + `markDirty()`):静止场景渲染一次后空闲,无变化时 100k 实体与空场景同价。
- **WebGL2 点层**(`new Scene(canvas, { pointBackend: 'webgl' })`):批量圆形单次 draw call;100k 点 7→25 fps(软件 GL)。
- 完整测试维度见英文 [README](./README.md#testing--quality)。

## 包

| 包                | 状态   | 说明                                                                                                                                      |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@vecto-ui/core`  | 活跃   | ECS 引擎、LayoutEngine(冷/热 + 段落 memo)、MSDF GPU 文本、Web Worker 异步排版、a11y 影子层、Canvas2D + WebGL2 渲染器                      |
| `@vecto-ui/ui`    | 活跃   | 高层组件:Text、RichText(行内样式/链接/绕流/流式)、Markdown(流式)、Button、Stack、Flow、Input、TextArea、Table、Dropdown、Slider、Modal 等 |
| `@vecto-ui/three` | 规划中 | 3D 空间 / WebXR 适配器(里程碑)                                                                                                            |

## 演示

演示与文档站点放在独立的开源仓库 [vecto-website](https://github.com/Xuepoo/vecto-website)(→ https://vecto-ui.xuepoo.xyz),本仓库只保留精简引擎。每个 demo 同时是引擎的真实压力测试。

## 开发

```bash
bun install          # 安装依赖
bun run test    # core + ui 单元测试
bun run lint         # oxlint
bun run benchmark    # 渲染基准(headless Chrome,真实帧时间)
bun run compare:dom  # 与 DOM 的 CDP 指标对比
```

## 贡献

欢迎提 Issue 和 PR。有想法或疑问?来开一个 [Discussion](https://github.com/Xuepoo/vecto-ui/discussions)。工作流见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可

MIT © 2026 Xuepoo
