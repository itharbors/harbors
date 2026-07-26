# iframe 主题与表面契约修复设计

## 背景

当前面板样式由三条相互独立的路径控制：Kit 面板 CSS 声明自身背景和 `color-scheme`，`ce-panel` 在 iframe 加载后强制将 `html` 与 `body` 改为透明，`EditorApp` 再向 iframe 注入主题变量和基础控件样式。Default Kit 的标题栏和状态栏只在 `body` 上绘制背景，因此宿主的透明覆盖会暴露工作台或浏览器底色；同时基础样式把 Kit 声明的深色 `color-scheme` 覆盖成 `normal`。

## 目标

- 明确宿主与 iframe 的绘制边界，消除无条件透明覆盖。
- 只保留一条 iframe 文档主题绑定路径，并正确处理重复绑定与卸载。
- 让深色主题同步影响原生表单控件和滚动条。
- 对从 Kit `package.json` 读取的主题对象进行运行时校验。
- 修复 Default Kit 标题栏和状态栏的背景，并提供回归测试。

## 非目标

- 本次不迁移全仓所有硬编码颜色。
- 本次不重写 `EditorApp` 的整体渲染机制。
- 本次不修改布局尺寸协议、Tabs、Divider 或 Dialog。
- 本次不引入新的主题配置格式或第三方 CSS 解析依赖。

## 方案比较

### 方案 A：继续透明 iframe，仅逐个补根节点背景

改动最小，但保留宿主覆盖 Kit CSS 的隐式行为。任何新面板只要把背景写在 `body` 上，就会再次出现同类问题，因此不采用。

### 方案 B：宿主不改写 iframe 文档，Kit 绘制内容表面

移除 `ce-panel` 对 iframe `html/body` 的透明注入；iframe 元素本身保持无边框和透明底色，面板文档决定实际背景。主题绑定集中到一个帮助函数中。该方案职责清楚、兼容现有完整面板，也能直接修复白底问题，因此采用。

### 方案 C：宿主统一绘制所有面板背景

可保证一致性，但会限制透明覆盖层、关系图和未来特殊 Panel 的表现，并要求宿主理解每个 Kit 的视觉意图，因此不采用。

## 详细设计

### 1. iframe 文档所有权

`ce-panel` 只创建和承载 iframe，不再读取或修改 `iframe.contentDocument`。它可以保留 iframe 元素自身的透明背景，确保没有加载内容时不额外绘制表面，但不得向子文档注入 `!important` 规则。

Kit 面板拥有其文档内容表面。普通面板应在 `body` 或根节点绘制背景；需要透明的特殊面板可以显式声明透明。Default Kit 的标题栏和状态栏将在 `#panel-root` 上使用语义主题变量绘制背景，避免依赖 `body` 的默认行为。

### 2. 统一主题绑定

在 `packages/client/src/styles/iframe-theme.ts` 提供 `bindThemeToIframe(iframe, getTokens)`：

- 立即尝试向已加载文档应用主题。
- 监听 iframe `load`，对后续导航重新应用主题。
- 返回幂等的清理函数以移除监听器。

`EditorApp` 通过 `Map<HTMLIFrameElement, () => void>` 保存绑定清理函数；同步时只绑定新 iframe，并遍历清理由当前工作区移除的 iframe。组件断开连接时清理全部绑定。`Panel` 不再拥有第二条 iframe load 监听路径。

### 3. 主题变量与 color-scheme

默认主题增加 `--ce-color-scheme: dark`。基础 iframe 样式使用：

```css
:root {
  color-scheme: var(--ce-color-scheme, dark);
}
```

主题变量通过 `document.documentElement.style.setProperty()` 写入，避免把外部字符串拼接为 `<style>` 内容。重复应用主题时先移除上一轮由 Harbors 写入、但新主题已不包含的 token，防止 iframe 导航或 Kit 切换后残留旧值。基础控件 CSS 继续使用固定 ID 的 `<style>` 元素进行幂等更新。

宿主工作台根元素同样通过 DOM `style.setProperty()` 应用主题变量，不再把 theme 值直接拼接进 `style` attribute。

### 4. Kit 主题运行时校验

服务端读取 Kit 描述时校验 `theme`：

- 缺失时保持 `undefined`。
- 必须是非数组对象。
- key 必须匹配 `^--ce-[a-z0-9-]+$`。
- value 必须是字符串。
- 非法配置直接拒绝 Kit，并在错误中指出 Kit 名称和非法 token。

CSS 值的浏览器语法有效性由 `style.setProperty()` 决定；本次不实现不完整的自制 CSS 解析器。Kit 本身属于可执行代码信任域，校验目标是稳定配置契约，而不是建立新的安全沙箱。

### 5. 错误与兼容处理

- 对尚未完成加载或跨源不可访问的 iframe，主题应用保持无操作；下一次 `load` 会重试。
- 清理函数可重复调用，不抛出异常。
- 现有 `--ce-*` token 名称和 Kit theme JSON 结构保持兼容。
- 未声明 `--ce-color-scheme` 的 Kit 自动继承默认值 `dark`。

## 测试策略

- `panel.test.ts`：先删除“强制子文档透明”的旧契约，新增断言确保 Panel 不改写 iframe 文档背景。
- `iframe-theme.test.ts`：覆盖默认深色 scheme、变量写入、旧变量清理、load 重绑和 cleanup。
- `editor-app` 相关测试：验证主题 token 通过 DOM 属性应用，且同一 iframe 不重复绑定。
- 服务端 Kit 测试：覆盖合法 theme、非对象 theme、非法 token key 和非字符串 value。
- Default Kit 面板样式测试或源码契约测试：确保标题栏和状态栏根节点使用语义背景变量。
- 完成后运行客户端、服务端和 Default Kit 的聚焦测试，再运行仓库完整测试与构建。

## 验收标准

- Default Kit 顶部标题栏和底部状态栏不再显示白色背景。
- iframe 中原生控件的计算 `color-scheme` 为 `dark`，除非 Kit 显式覆盖。
- `ce-panel` 不再向 iframe 文档写入透明背景样式。
- 每个 iframe 只有主题绑定路径负责 document 级样式注入。
- 非法 Kit theme 在服务端加载阶段给出明确错误。
- 所有新增回归测试、完整测试和构建通过。
