# ITHARBORS

[![NPM](https://img.shields.io/npm/v/@itharbors/harbors)](https://www.npmjs.com/package/@itharbors/harbors)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@itharbors/harbors)](https://nodejs.org/)

> 📖 This document is in English. For Chinese version, see [readme_cn.md](./readme_cn.md).

A desktop application development framework based on Electron, featuring a plugin-based architecture and rich development tools to help developers quickly build cross-platform desktop applications.

## 📋 Features

- **Plugin Architecture**: Based on plugin system, supports dynamic loading and unloading of functional modules
- **Kit Management**: Batch management of related plugins through kits, simplifying application configuration
- **Panel System**: Built-in panel management, supports registration and management of custom panels
- **Menu System**: Flexible menu management, supports dynamic menu contributions
- **Message Communication**: Inter-plugin communication through message system
- **Cross-Platform**: Based on Electron, supports Windows, macOS, and Linux
- **TypeScript Support**: Complete type definitions for a great development experience

## 🚀 Quick Start

### Requirements

- Node.js >= 16.0.0
- npm >= 7.0.0
- Electron >= 20.0.0

### Installation

```bash
npm install @itharbors/harbors
```

### Usage

```typescript
import { Editor } from '@itharbors/harbors';

// Initialize the framework
Editor.initialize();

// Load a kit
await Editor.Kit.execute('load', '/path/to/kit');

// Register a plugin
await Editor.Plugin.execute('register', '/path/to/plugin');

// Start a plugin
await Editor.Plugin.execute('load', '/path/to/plugin');

// Call plugin method
const result = await Editor.Plugin.execute('callPlugin', 'plugin-name', 'method', args);
```

## 📚 Documentation

### Framework Design

- [Kit Design Document](./app/.design/framework/kit.md)
- [Plugin Design Document](./app/.design/framework/plugin.md)
- [Panel Design Document](./app/.design/framework/panel.md)
- [Window Design Document](./app/.design/framework/window.md)
- [Module Standard Specification](./app/.design/framework/module-standard.md)

### Module Design

- [Layout Design Document](./app/.design/module/layout.md)
- [Preload-Panel Design Document](./app/.design/module/preload-panel.md)
- [Preload-Window Design Document](./app/.design/module/preload-window.md)

### Service Design

- [Electron Service Design Document](./app/.design/service/electron.md)

### Built-in Plugins Design

- [Main Menu Plugin Design Document](./plugin/main-menu/.design/index.md)
- [Message Plugin Design Document](./plugin/message/.design/index.md)
- [Panel Plugin Design Document](./plugin/panel/.design/index.md)

## 📁 Project Structure

```
├── app/             # Core application
│   ├── dist/        # Compiled output
│   ├── type/         # Type definitions
│   └── .design/      # Design documents
├── plugin/          # Built-in plugins
│   ├── main-menu/    # Main menu plugin
│   ├── message/      # Message plugin
│   └── panel/        # Panel plugin
├── kit/             # Built-in kits
├── workflow/        # Build workflow
└── package.json     # Project configuration
```

## 🔧 Development Guide

### Development Setup

```bash
# Clone the repository
git clone https://github.com/itharbors/harbors.git
cd harbors

# Install dependencies
npm install

# Build project
npm run build

# Run tests
npm run test
```

### Plugin Development

1. **Create plugin directory structure**
2. **Write package.json configuration**
3. **Implement plugin logic**
4. **Register plugin contributions**

### Kit Development

1. **Create kit directory structure**
2. **Write package.json configuration**
3. **Configure kit plugin list**

## 🤝 Contributing

We welcome community contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to participate.

### Contribution Process

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 📞 Contact

- **GitHub Issues**: [https://github.com/itharbors/harbors/issues](https://github.com/itharbors/harbors/issues)
- **Email**: contact@itharbors.com

---

**Made with ❤️ by the ITHARBORS team**
