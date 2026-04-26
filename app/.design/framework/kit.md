# Kit 套件设计文档

## 文件信息
- **源文件路径**: `app/source/framework/kit/`
- **模块名/类名**: `Kit`
- **功能**: 套件是一个插件包，用于批量启动、关闭功能互相关联的插件

## 模块/类结构图

```mermaid
classDiagram
    class Kit {
        -_path: string
        -_json: KitJSON
        +name: string
        +path: string
        +layout: object
        +window: object
        +constructor(path: string)
        +init(): Promise&lt;void&gt;
    }

    class KitModule {
        -nameMap: Map&lt;string, Kit&gt;
        +register()
        +load()
        +load(path: string): Promise&lt;void&gt;
        +unload(path: string): Promise&lt;void&gt;
        +getLayout(kitName?: string, layoutName?: string): Promise&lt;string&gt;
        +getWindow(name?: string): Promise&lt;object&gt;
    }

    KitModule --&gt; Kit: 管理
```

## 数据结构

### KitJSON

```typescript
type KitJSON = {
    name: string;
    version: string;
    harbors: {
        window: {
            file: string;
            width: number;
            height: number;
        };
        layout: {
            [key: string]: string;
        };
        plugin?: string[];
    };
}
```

**说明**: 套件配置文件结构，定义了套件的基本信息、窗口配置、布局配置和关联插件列表

## 主要方法

### Kit.constructor

**功能**: 初始化 Kit 实例，读取并解析套件的 package.json 配置文件

**参数**:
- `path`: 套件在磁盘上的绝对路径地址

**流程**:
1. 读取套件目录下的 package.json 文件
2. 解析 JSON 内容为 KitJSON 对象
3. 补全默认配置信息
4. 将相对路径转换为绝对路径

### Kit.init

**功能**: 初始化套件，启动套件关联的所有插件

**流程**:
1. 遍历套件配置中的插件列表
2. 对每个插件执行 register 操作
3. 对每个插件执行 load 操作

### KitModule.load

**功能**: 加载一个套件

**参数**:
- `path`: 套件在磁盘上的绝对路径地址

**流程**:
1. 创建 Kit 实例
2. 调用 kit.init() 初始化套件
3. 将套件添加到 nameMap 中
4. 更新当前套件名称

### KitModule.unload

**功能**: 卸载一个套件

**参数**:
- `path`: 套件在磁盘上的绝对路径地址

**流程**:
1. 遍历 nameMap 查找匹配的套件
2. 从 nameMap 中删除该套件

### KitModule.getLayout

**功能**: 获取套件的布局配置

**参数**:
- `kitName?: string`: 套件名称，默认为 'default'
- `layoutName?: string`: 布局名称，默认为 'default'

**返回值**: `string` - 布局文件的绝对路径

### KitModule.getWindow

**功能**: 获取套件的窗口配置

**参数**:
- `name?: string`: 套件名称，默认为 'default'

**返回值**: `object` - 窗口配置对象

## 流程图

### 套件加载流程图

```mermaid
flowchart TD
    A[开始] --&gt; B[调用 KitModule.load]
    B --&gt; C[创建 Kit 实例]
    C --&gt; D[读取 package.json]
    D --&gt; E[解析配置]
    E --&gt; F[调用 Kit.init]
    F --&gt; G[遍历插件列表]
    G --&gt; H[注册插件]
    H --&gt; I[启动插件]
    I --&gt; J{还有插件?}
    J --&gt;|是| G
    J --&gt;|否| K[添加到 nameMap]
    K --&gt; L[结束]
```

## 依赖关系

- 依赖: `../plugin` - 插件模块，用于管理插件的注册和加载
- 依赖: `@itharbors/module` - 模块生成工具

## 使用示例

```typescript
import { instance as Kit } from '@framework/kit';

// 加载套件
await Kit.execture('load', '/path/to/kit');

// 获取布局配置
const layoutPath = await Kit.execture('getLayout', 'default', 'default');

// 获取窗口配置
const windowConfig = await Kit.execture('getWindow', 'default');

// 卸载套件
await Kit.execture('unload', '/path/to/kit');
```

## 注意事项

1. 套件必须包含 package.json 文件，且必须包含 harbors 配置
2. 套件配置中的路径会自动转换为绝对路径
3. 套件会批量管理关联插件的生命周期
4. 同一时间只能有一个同名套件处于活动状态
