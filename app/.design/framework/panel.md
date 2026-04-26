# Panel 面板设计文档

## 文件信息
- **源文件路径**: `app/source/framework/panel/`
- **模块名/类名**: `Panel`
- **功能**: 提供面板注册和卸载功能，是 electron-panel 的封装模块

## 模块/类结构图

```mermaid
classDiagram
    class PanelModule {
        +register()
        +load()
        +register(name: string, info: PanelInfo): Promise&lt;void&gt;
        +unregister(name: string): Promise&lt;void&gt;
    }

    PanelModule --&gt; "@itharbors/electron-panel/browser": 使用
```

## 主要方法

### PanelModule.register

**功能**: 注册一个面板

**参数**:
- `name`: 面板名称
- `info`: 面板配置信息，类型为 PanelInfo

**流程**:
1. 调用 @itharbors/electron-panel/browser 的 register 方法
2. 完成面板注册

### PanelModule.unregister

**功能**: 卸载一个面板

**参数**:
- `name`: 面板名称

**流程**:
1. 调用 @itharbors/electron-panel/browser 的 unregister 方法
2. 完成面板卸载

## 依赖关系

- 依赖: `@itharbors/electron-panel/browser` - 提供面板的核心注册和卸载功能
- 依赖: `@itharbors/module` - 模块生成工具

## 使用示例

```typescript
import { instance as Panel } from '@framework/panel';

// 注册面板
await Panel.execture('register', 'my-panel', {
    title: '我的面板',
    width: 400,
    height: 300,
    // 其他配置
});

// 卸载面板
await Panel.execture('unregister', 'my-panel');
```

## 注意事项

1. 该模块是 electron-panel 的轻量封装
2. 面板的具体配置参数请参考 @itharbors/electron-panel 的文档
3. 面板名称应保持唯一性
