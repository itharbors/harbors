# ITHARBORS

[![NPM](https://img.shields.io/npm/v/@itharbors/itharbors)](https://www.npmjs.com/package/@itharbors/itharbors)
[![CI Status](https://github.com/itharbors/itharbors/actions/workflows/ci.yaml/badge.svg)](https://github.com/itharbors/itharbors/actions/workflows/ci.yaml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@itharbors/itharbors)](https://nodejs.org/)

一款基于 Electron 的程序开发框架，提供插件化架构和丰富的开发工具，帮助开发者快速构建跨平台桌面应用。

## 📋 特性

- **插件化架构**：基于插件系统，支持动态加载和卸载功能模块
- **套件管理**：通过套件批量管理相关插件，简化应用配置
- **面板系统**：内置面板管理，支持自定义面板的注册和管理
- **菜单系统**：灵活的菜单管理，支持动态菜单贡献
- **消息通信**：插件间通过消息系统进行通信
- **跨平台**：基于 Electron，支持 Windows、macOS、Linux
- **TypeScript 支持**：完整的类型定义，提供良好的开发体验

## 🚀 快速开始

### 环境要求

- Node.js >= 16.0.0
- npm >= 7.0.0
- Electron >= 20.0.0

### 安装

```bash
npm install @itharbors/itharbors
```

### 基本用法

```typescript
import { Editor } from '@itharbors/itharbors';

// 初始化框架
Editor.initialize();

// 加载套件
await Editor.Kit.execture('load', '/path/to/kit');

// 注册插件
await Editor.Plugin.execture('register', '/path/to/plugin');

// 启动插件
await Editor.Plugin.execture('load', '/path/to/plugin');

// 调用插件方法
const result = await Editor.Plugin.execture('callPlugin', 'plugin-name', 'method', args);
```

## 📁 项目结构

```
├── app/             # 核心应用
│   ├── source/       # 源代码
│   ├── type/         # 类型定义
│   └── .design/      # 设计文档
├── plugin/          # 内置插件
│   ├── main-menu/    # 主菜单插件
│   ├── message/      # 消息插件
│   └── panel/        # 面板插件
├── kit/             # 内置套件
├── workflow/        # 构建工作流
├── test/            # 测试代码
└── package.json     # 项目配置
```

## 📚 文档

### 框架文档

- [Kit 套件设计文档](app/.design/framework/kit.md)
- [Plugin 插件设计文档](app/.design/framework/plugin.md)
- [Panel 面板设计文档](app/.design/framework/panel.md)
- [Window 窗口设计文档](app/.design/framework/window.md)
- [模块标准设计文档](app/.design/framework/module-standard.md)

### 模块文档

- [Layout 布局设计文档](app/.design/module/layout.md)
- [Preload Panel 预加载面板设计文档](app/.design/module/preload-panel.md)
- [Preload Window 预加载窗口设计文档](app/.design/module/preload-window.md)

### 服务文档

- [Electron 服务设计文档](app/.design/service/electron.md)

### 内置插件文档

- [Main Menu 主菜单插件设计文档](plugin/main-menu/.design/index.md)
- [Message 消息插件设计文档](plugin/message/.design/index.md)
- [Panel 面板插件设计文档](plugin/panel/.design/index.md)

## 🔧 开发指南

### 开发环境设置

```bash
# 克隆仓库
git clone https://github.com/itharbors/itharbors.git
cd itharbors

# 安装依赖
npm install

# 构建项目
npm run build

# 运行测试
npm run test
```

### 插件开发

1. **创建插件目录结构**
2. **编写 package.json 配置**
3. **实现插件逻辑**
4. **注册插件贡献**

### 套件开发

1. **创建套件目录结构**
2. **编写 package.json 配置**
3. **配置套件插件列表**

## 🤝 贡献

我们欢迎社区贡献！请查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解如何参与。

### 贡献流程

1. Fork 仓库
2. 创建特性分支
3. 提交更改
4. 推送到分支
5. 开启 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🌟 致谢

感谢所有为项目做出贡献的开发者！

## 📞 联系方式

- **GitHub Issues**: [https://github.com/itharbors/itharbors/issues](https://github.com/itharbors/itharbors/issues)
- **Discord**: [Join our Discord server](https://discord.gg/itharbors)
- **Email**: contact@itharbors.com

---

**Made with ❤️ by the ITHARBORS team**