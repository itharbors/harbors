# 模块标准规范

## 1. 模块结构

### 1.1 基本结构

每个标准模块应遵循以下目录结构：

```
framework/
├── module-name/
│   ├── index.ts         # 模块导出文件
│   └── module-name.ts    # 模块核心实现（可选，用于复杂模块）
```

### 1.2 核心文件

#### index.ts

`index.ts` 是模块的导出文件，负责创建和导出模块实例。它应包含以下内容：

1. **模块描述**：顶部添加模块的简短描述
2. **导入依赖**：导入必要的依赖项
3. **模块实例创建**：使用 `generateModule` 函数创建模块实例
4. **模块配置**：定义模块的数据、生命周期方法和公共方法
5. **导出实例**：导出模块实例

#### module-name.ts（可选）

对于复杂的模块，可以创建一个单独的文件来实现核心功能，然后在 `index.ts` 中引用。

## 2. 模块实例结构

使用 `generateModule` 函数创建的模块实例应包含以下部分：

### 2.1 数据定义

通过 `data()` 方法定义模块的初始数据：

```typescript
data(): {
    // 定义模块的数据结构
    name: string;
    // 其他数据...
} {
    return {
        name: '',
        // 初始值...
    };
}
```

### 2.2 生命周期方法

模块应实现以下生命周期方法：

- **register()**：模块注册时执行，用于初始化模块状态
- **load()**：模块加载时执行，用于启动模块功能

### 2.3 公共方法

在 `method` 对象中定义模块的公共方法：

```typescript
method: {
    /**
     * 方法描述
     * @param param 参数描述
     * @returns 返回值描述
     */
    async methodName(param: string): Promise<any> {
        // 方法实现
    },
    // 其他方法...
}
```

## 3. 模块间引用

模块之间通过导入其他模块的 `instance` 来相互引用：

```typescript
import { instance as OtherModule } from '../other-module';

// 在方法中使用
const result = await OtherModule.execture('methodName', param);
```

## 4. 代码规范

### 4.1 命名规范

- 模块目录名：使用小写字母，单词间用连字符（-）分隔
- 文件名：使用小写字母，单词间用连字符（-）分隔
- 类名：使用 PascalCase
- 方法名：使用 camelCase
- 变量名：使用 camelCase
- 常量名：使用 UPPER_SNAKE_CASE

### 4.2 注释规范

- 模块描述：在文件顶部添加模块的简短描述
- 方法注释：使用 JSDoc 格式为每个公共方法添加注释
- 代码注释：对复杂的逻辑添加适当的注释

### 4.3 错误处理

- 使用 try-catch 捕获并处理可能的错误
- 抛出错误时提供清晰的错误信息
- 错误信息应包含模块名称和具体错误原因

## 5. 示例模块

### 5.1 简单模块示例（panel）

```typescript
// panel/index.ts
import type { PanelInfo } from '@itharbors/electron-panel/browser';
import { generateModule } from '@itharbors/module';
import { register, unregister } from '@itharbors/electron-panel/browser';

export const instance = generateModule({
    data(): {} {
        return {};
    },

    register() {

    },

    load() {

    },

    method: {
        /**
         * 注册一个面板
         * @param name 面板名称
         * @param info 面板信息
         */
        async register(name: string, info: PanelInfo) {
            register(name, info);
        },

        /**
         * 卸载一个面板
         * @param name 面板名称
         */
        async unregister(name: string) {
            unregister(name);
        },
    },
});
```

### 5.2 复杂模块示例（kit）

```typescript
// kit/kit.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { instance as Plugin } from '../plugin';

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

export class Kit {
    private _path: string;
    private _json: KitJSON;

    get name() {
        return this._json.name;
    }

    get path() {
        return this._path;
    }

    get layout() {
        return this._json.harbors?.layout;
    }

    get window() {
        return this._json.harbors?.window;
    }

    constructor(path: string) {
        this._path = path;
        const infoFilePath = join(path, 'package.json');
        if (!existsSync(infoFilePath)) {
            throw new Error(`[Kit]] 启动失败，读取文件失败: ${infoFilePath}`);
        }

        try {
            this._json = JSON.parse(readFileSync(infoFilePath, 'utf8')) as KitJSON;

            // 补全必要信息
            this._json.name = this._json.name || '';
            this._json.harbors = this._json.harbors || {};
            this._json.harbors.window = this._json.harbors.window || {};
            this._json.harbors.window.file = this._json.harbors.window.file || '';
            this._json.harbors.window.width = this._json.harbors.window.width || 800;
            this._json.harbors.window.height = this._json.harbors.window.height || 600;
            this._json.harbors.layout = this._json.harbors.layout || {};
            this._json.harbors.plugin = this._json.harbors.plugin || [];

            // 相对路径转绝对路径
            this._json.harbors.window.file = join(path, this._json.harbors.window.file);
            for (let name in this._json.harbors.layout) {
                this._json.harbors.layout[name] = join(path, this._json.harbors.layout[name]);
            }
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`[Kit]] 启动失败，读取文件失败: ${infoFilePath}\n  ${message}`);
        }
    }

    async init() {
        for (let plugin of this._json.harbors!.plugin!) {
            const pluginPath = join(this._path, plugin);
            await Plugin.execture('register', pluginPath);
            await Plugin.execture('load', pluginPath);
        }
    }
}

// kit/index.ts
/**
 * 套件是一个插件包
 * 用于批量启动、关闭功能互相关联的插件
 */
import { basename } from 'path';
import { generateModule } from '@itharbors/module';
import { Kit } from './kit';

export const instance = generateModule<{
    nameMap: Map<string, Kit>;
}>({
    data(): {
        name: string;
    } {
        return {
            name: '',
        };
    },

    register() {
        this.nameMap = new Map();
    },

    load() {

    },

    method: {
        /**
         * 加载一个套件
         * @param path 套件路径
         */
        async load(path: string) {
            console.log(`[Kit] 启动: ${basename(path)}`);
            const kit = new Kit(path);
            await kit.init();
            this.nameMap.set(kit.name, kit);
            this.data.set('name', kit.name);
        },

        /**
         * 卸载一个套件
         * @param path 套件路径
         */
        async unload(path: string) {
            console.log(`[Kit] 关闭: ${basename(path)}`);
            this.nameMap.forEach((kit, name) => {
                if (kit.path === path) {
                    this.nameMap.delete(name);
                }
            });
        },

        async getLayout(kitName?: string, layoutName?: string) {
            kitName = kitName || 'default';
            const kit = this.nameMap.get(kitName);
            return kit?.layout[layoutName || 'default'];
        },

        async getWindow(name?: string) {
            name = name || 'default';
            const kit = this.nameMap.get(name);
            return kit?.window;
        },
    },
});
```

## 6. 总结

标准模块应遵循以下原则：

1. **清晰的目录结构**：每个模块有自己的目录，包含必要的文件
2. **统一的模块创建方式**：使用 `generateModule` 函数创建模块实例
3. **完整的生命周期**：实现必要的生命周期方法
4. **明确的公共接口**：通过 `method` 对象暴露公共方法
5. **规范的代码风格**：遵循命名规范和注释规范
6. **良好的错误处理**：捕获并处理可能的错误

遵循这些规范可以确保模块的一致性和可维护性，便于团队协作和代码管理。