# Module Standard Specification

## 1. Module Structure

### 1.1 Basic Structure

Each standard module should follow the directory structure below:

```
framework/
├── module-name/
│   ├── index.ts         # Module export file
│   └── module-name.ts    # Module core implementation (optional, for complex modules)
```

### 1.2 Core Files

#### index.ts

`index.ts` is the module's export file, responsible for creating and exporting the module instance. It should contain the following:

1. **Module Description**: Add a brief description of the module at the top
2. **Import Dependencies**: Import necessary dependencies
3. **Module Instance Creation**: Create module instance using `generateModule` function
4. **Module Configuration**: Define module data, lifecycle methods, and public methods
5. **Export Instance**: Export the module instance

#### module-name.ts (Optional)

For complex modules, a separate file can be created to implement core functionality, then referenced in `index.ts`.

## 2. Module Instance Structure

Module instances created using the `generateModule` function should include the following parts:

### 2.1 Data Definition

Define initial module data through the `data()` method:

```typescript
data(): {
    // Define module data structure
    name: string;
    // Other data...
} {
    return {
        name: '',
        // Initial values...
    };
}
```

### 2.2 Lifecycle Methods

Modules should implement the following lifecycle methods:

- **register()**: Executed when the module is registered, used to initialize module state
- **load()**: Executed when the module is loaded, used to start module functionality

### 2.3 Public Methods

Define module public methods in the `method` object:

```typescript
method: {
    /**
     * Method description
     * @param param Parameter description
     * @returns Return value description
     */
    async methodName(param: string): Promise<any> {
        // Method implementation
    },
    // Other methods...
}
```

## 3. Inter-module References

Modules reference each other by importing `instance` from other modules:

```typescript
import { instance as OtherModule } from '../other-module';

// Use in methods
const result = await OtherModule.execute('methodName', param);
```

## 4. Code Specifications

### 4.1 Naming Conventions

- Module directory names: Use lowercase letters, separated by hyphens (-)
- File names: Use lowercase letters, separated by hyphens (-)
- Class names: Use PascalCase
- Method names: Use camelCase
- Variable names: Use camelCase
- Constant names: Use UPPER_SNAKE_CASE

### 4.2 Comment Conventions

- Module description: Add a brief module description at the top of the file
- Method comments: Use JSDoc format to add comments for each public method
- Code comments: Add appropriate comments for complex logic

### 4.3 Error Handling

- Use try-catch to catch and handle possible errors
- Provide clear error messages when throwing errors
- Error messages should include module name and specific error reason

## 5. Example Modules

### 5.1 Simple Module Example (panel)

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
         * Register a panel
         * @param name Panel name
         * @param info Panel info
         */
        async register(name: string, info: PanelInfo) {
            register(name, info);
        },

        /**
         * Unregister a panel
         * @param name Panel name
         */
        async unregister(name: string) {
            unregister(name);
        },
    },
});
```

### 5.2 Complex Module Example (kit)

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
            throw new Error(`[Kit]] Startup failed, file read failed: ${infoFilePath}`);
        }

        try {
            this._json = JSON.parse(readFileSync(infoFilePath, 'utf8')) as KitJSON;

            // Complete necessary information
            this._json.name = this._json.name || '';
            this._json.harbors = this._json.harbors || {};
            this._json.harbors.window = this._json.harbors.window || {};
            this._json.harbors.window.file = this._json.harbors.window.file || '';
            this._json.harbors.window.width = this._json.harbors.window.width || 800;
            this._json.harbors.window.height = this._json.harbors.window.height || 600;
            this._json.harbors.layout = this._json.harbors.layout || {};
            this._json.harbors.plugin = this._json.harbors.plugin || [];

            // Convert relative paths to absolute paths
            this._json.harbors.window.file = join(path, this._json.harbors.window.file);
            for (let name in this._json.harbors.layout) {
                this._json.harbors.layout[name] = join(path, this._json.harbors.layout[name]);
            }
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`[Kit]] Startup failed, file read failed: ${infoFilePath}\n  ${message}`);
        }
    }

    async init() {
        for (let plugin of this._json.harbors!.plugin!) {
            const pluginPath = join(this._path, plugin);
            await Plugin.execute('register', pluginPath);
            await Plugin.execute('load', pluginPath);
        }
    }
}

// kit/index.ts
/**
 * A kit is a plugin package
 * Used to batch start and close functionally related plugins
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
         * Load a kit
         * @param path Kit path
         */
        async load(path: string) {
            console.log(`[Kit] Starting: ${basename(path)}`);
            const kit = new Kit(path);
            await kit.init();
            this.nameMap.set(kit.name, kit);
            this.data.set('name', kit.name);
        },

        /**
         * Unload a kit
         * @param path Kit path
         */
        async unload(path: string) {
            console.log(`[Kit] Closing: ${basename(path)}`);
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

## 6. Summary

Standard modules should follow these principles:

1. **Clear Directory Structure**: Each module has its own directory with necessary files
2. **Unified Module Creation**: Use the `generateModule` function to create module instances
3. **Complete Lifecycle**: Implement necessary lifecycle methods
4. **Clear Public Interface**: Expose public methods through the `method` object
5. **Standard Code Style**: Follow naming and comment conventions
6. **Good Error Handling**: Capture and handle possible errors

Following these specifications ensures module consistency and maintainability, facilitating team collaboration and code management.
