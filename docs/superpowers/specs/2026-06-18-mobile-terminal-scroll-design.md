# 移动端终端回滚触摸修复设计

日期：2026-06-18

## 背景

用户反馈移动端“触屏滑动失效，滑动条滑动效果不佳”。经只读排查和用户确认，本次范围限定为终端回滚区域：xterm scrollback 的手指上下滑动，以及终端右侧滚动条拖拽手感。

RSSH 是面向开发者与运维/SRE 的跨平台 SSH 工作台。终端回滚是移动端核心路径：用户需要在长输出中回看日志、错误堆栈和命令结果，因此修复应优先保证终端可滑、滚动条可用，并保持短按终端唤起软键盘的现有行为。

## 目标

- 移动端在终端长输出中可以稳定用手指上下滑动回滚。
- 终端滚动条在触屏设备上更容易拖动，命中区和视觉反馈不再过窄。
- 短按终端仍能聚焦并唤起移动端软键盘。
- 不改变设置页、AI/SFTP 面板、横向标签栏等非终端区域行为。
- 不修改全局 app shell 的 `body overflow: hidden` 滚动模型。

## 非目标

- 不处理 AI/SFTP 面板宽度拖拽条的触屏支持。
- 不重做 StripBar 横向滑动提示或标签栏交互。
- 不升级、降级或替换 `@xterm/xterm`。
- 不重构终端折叠、命令块、高亮或 AI 相关逻辑。
- 不引入新的滚动库或手势库。

## 关键现状

- `src/lib/components/TerminalPane.svelte` 中移动端软键盘逻辑会监听终端容器的 `pointerdown`、`pointermove`、`pointerup`、`pointercancel`。
- 当前移动逻辑在拖动超过阈值后会隐藏并锁定 helper textarea，用于避免滑动时误唤起键盘。
- 同一逻辑会在 `window` / `visualViewport` scroll 或 resize 后调用 `resetDocumentScroll()`，强制文档滚动回到原点。
- `src/styles/global.css` 中 `html, body` 使用 `overflow: hidden`，终端必须依赖 xterm 内部 viewport 滚动。
- 全局 WebKit scrollbar 宽高为 `6px`，触屏拖拽命中区偏小。
- xterm 当前版本为 `@xterm/xterm@6.0.0`，滚动区域和滚动条实现可能不同于旧版 DOM scrollbar。

## 推荐方案

采用“终端专用最小修复”：只针对 TerminalPane/xterm viewport 增强触屏滚动和滚动条命中，不改变全局滚动架构。

### 1. 终端触摸意图判定

在移动端 pointer 处理里明确区分短按与垂直滑动：

- `pointerdown` 记录起点、时间、pointerType 和目标元素。
- `pointermove` 超过垂直滑动阈值后，将本次手势标记为 terminal scroll gesture。
- 一旦标记为滚动手势，本次手势不再尝试显示键盘。
- `pointerup` 时只有在未发生滚动、移动距离很小、不是长按/右键菜单状态时，才唤起键盘。

这样保留“点一下终端输入”的能力，同时避免“想滑动回看却被键盘 helper 状态切换打断”。

### 2. 限制 document scroll reset 的触发面

保留 `resetDocumentScroll()` 作为防止 WebView/软键盘把页面整体推开的保护，但避免它在终端滚动手势中反复触发：

- 滚动手势进行期间，不主动执行会抵消终端滑动的 reset。
- reset 只用于 visualViewport/窗口偏移异常修正，不用于处理 xterm 内部 scrollback。
- 结束触摸后再恢复原有键盘保护状态。

### 3. xterm viewport 触摸样式

在 TerminalPane 的样式层为 xterm viewport 添加终端专属滚动语义：

- `touch-action: pan-y`，让垂直滑动优先成为滚动。
- `overscroll-behavior: contain`，避免内部滚动传播到 shell 或窗口。
- `-webkit-overflow-scrolling: touch`，改善移动 WebKit/WebView 的惯性滚动体验。
- 不在终端内强制开启页面级滚动。

### 4. 终端滚动条命中区优化

针对 xterm viewport 或 xterm 6 实际 scrollbar DOM 做局部样式增强：

- 移动/粗指针环境下增大终端滚动条可拖区域。
- 保持桌面端紧凑外观，避免把全局滚动条全部放大。
- 如果 xterm 6 使用自定义 scrollbar，优先适配其内部 class；如果仍暴露 `.xterm-viewport` 原生滚动条，则覆盖该区域的 scrollbar 宽度。

### 5. 保持命令块覆盖层不抢滚动

检查命令块 overlay 的 `pointer-events`：

- 保持装饰层穿透到 xterm。
- 如果左侧 `.block-hit` 影响从左边缘起手滑动，只在触摸滚动时避免抢占垂直 pan。
- 不改变命令块点击、折叠、右键菜单的桌面行为。

## 方案权衡

### 推荐：终端专用最小修复

优点：范围小，直接命中终端回滚问题；桌面端风险低；不改变整体布局和其它页面。  
缺点：需要根据 xterm 6 实际 DOM 做针对性样式，可能需要移动端运行验证。

### 备选：全局滚动条和触摸目标统一优化

优点：能改善多个滚动容器和触摸命中尺寸。  
缺点：范围扩大，容易改变当前紧凑工具风格；不适合作为首个修复。

### 备选：调整 xterm 版本或重写 viewport 适配

优点：如果根因完全来自 xterm 6 viewport 变更，可能更彻底。  
缺点：风险高，会影响折叠、高亮、搜索、私有 viewport 同步等多处终端能力。

## 实现边界

预计修改文件：

- `src/lib/components/TerminalPane.svelte`
- 必要时修改 `src/styles/global.css`，但仅添加终端局部覆盖，不改全局 body 滚动模型。

不预计修改：

- `src/lib/components/AppShell.svelte`
- `src/lib/components/StripBar.svelte`
- `src/lib/terminal/folds.ts`
- `package.json` / lockfile

## 验证计划

自动化验证：

- 运行项目现有测试：`npm run test`。
- 如测试或类型构建暴露相关问题，再运行 `npm run build`。

手动/运行时验证：

- 生成足够长的终端输出后，在移动视口中从终端中部上下滑动。
- 点按终端确认软键盘仍能唤起。
- 先点按终端唤起键盘，再收起键盘，再滑动回滚。
- 尝试拖动终端右侧滚动条，确认命中区和跟手感改善。
- 从左侧命令块区域和终端中部起手分别滑动，确认命令块 overlay 不阻断常规回滚。

若当前环境无法运行真实移动端验证，最终报告需明确说明未做真机验证，并列出已完成的替代验证。

## 成功标准

- 终端长输出在移动端触屏下可回滚。
- 滚动手势不会误触发软键盘显示。
- 短按终端仍可进入输入状态。
- 滚动条在粗指针/移动环境中不再只有 6px 级别的有效拖动区域。
- 现有测试通过，且没有引入与本问题无关的大范围 UI 改动。
