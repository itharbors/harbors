# Kit 制品打包

Harbors 将 Kit 封装为 `.hkit` 制品，用于本地分发与导入。制品是根目录、条目顺序和时间戳固定的 ZIP，包含 Kit shell、声明插件的运行时文件、公开资源、`checksums.json` 和 SPDX SBOM。

## 构建与校验

```bash
pnpm --filter @itharbors/kit-core run build
pnpm --filter @itharbors/kit-cli run build
pnpm run kit -- validate ./path/to/kit
pnpm run kit -- pack ./path/to/kit --output ./dist/example.hkit
pnpm run kit -- inspect ./dist/example.hkit --json
```

`validate` 要求 Kit 根目录同时包含 `kit.json` 和 `package.json` descriptor，两者的身份与版本必须一致。插件 main、Panel entry 和 public assets 必须指向真实文件；源码、测试、符号链接、路径逃逸和未声明插件不会进入制品。

`kit.json` 声明 channel、publisher、Harbors/Kit API SemVer 范围、协议版本、permissions 和平台目标。含 `native-code` 的制品必须声明真实平台、架构与 Framework Node ABI。permission 是风险声明，不会自动建立 OS 沙箱；宿主能力仍必须经过 Kit/Plugin owner 与 capability 策略检查。

## 本地打包

所有 Kit 从 `kits/` 目录进行本地开发与打包。合并源码不会自动创建制品或变更版本；版本字段继续作为 descriptor 与制品校验的静态元数据。

`pack` 命令在本地生成 `.hkit` 制品，可用于手动分发或导入。制品不绑定远程仓库或提交；运行时只从本地路径或已导入的制品加载 Kit，不安装或执行远程代码。

所有动态发现的 builtin Kit 目录中必须恰好一个声明 default 角色。Framework 与 Kit 变更统一使用 change-workflow。
