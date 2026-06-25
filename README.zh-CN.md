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

用 `bun run benchmark` 复现(headless Chrome、Canvas 2D、简单填充圆形实体、关闭 vsync/帧率上限;当前每帧都全量重绘 —— 还没有 dirty-checking 或 culling)。数值与机器及实体复杂度相关。

| 实体数  | 每帧平均 ms | 最大 FPS | 稳定 60 FPS |
| ------- | ----------- | -------- | ----------- |
| 1,000   | ~5 ms       | ~180     | 是          |
| 10,000  | ~23 ms      | ~44      | 暂未        |
| 100,000 | ~180 ms     | ~6       | 暂未        |

> 这是早期、未优化的数据。把 10k+ 实体拉回 60 FPS 是正在进行的工作 —— 通过 spatial hash 做视口 culling、dirty-region 渲染、用 `OffscreenCanvas` 离屏计算,以及在 `IRenderer` 之下接入 WebGL/WebGPU 后端。

## 架构

```
.----------------------------------------------.
|          Demo Applications                   |
|  (Hooke's Law / Bad Apple / Bubbles)         |
'----------------------.------------------------'
                       |
.----------------------v------------------------.
|            @vecto-ui/core                     |
|  .----------.  .----------------------------. |
|  |  Scene   |  |   LayoutEngine             | |
|  |  Entity  |  |   SpatialHashGrid (O(1))   | |
|  |  ECS     |  |   LayoutResultBuffer (GC0) | |
|  '----------'  '----------------------------' |
'----------------------.------------------------'
                       |
.----------------------v------------------------.
|        CanvasRenderer (Canvas 2D)             |
|              HTML <canvas>                    |
'-----------------------------------------------'
```

## 包

| 包                | 状态   | 说明                                              |
| ----------------- | ------ | ------------------------------------------------- |
| `@vecto-ui/core`  | 活跃   | ECS 引擎、LayoutEngine、SpatialHashGrid、数学工具 |
| `@vecto-ui/ui`    | 规划中 | 高层可交互组件                                    |
| `@vecto-ui/three` | 规划中 | WebGL / Three.js 适配器                           |

## 开发

```bash
bun install                          # 安装依赖
cd apps/demo && bun run dev          # 启动 demo 开发服务器
cd packages/core && bunx vitest run  # 运行单元测试
bun run benchmark                    # 渲染基准(headless Chrome)
bun run compare                      # 与 pretext 的文字排版对比
```

## 贡献

欢迎提 Issue 和 PR。有想法或疑问?来开一个 [Discussion](https://github.com/Xuepoo/vecto-ui/discussions)。工作流见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可

MIT © 2026 Xuepoo
