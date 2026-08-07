# Kit 下载移除 GitHub 认证依赖总结

## 最终结论

公开 Kit 的安装和更新已不再依赖 GitHub 身份认证或 Attestations API 匿名额度。来源证明校验保持完整且默认拒绝异常输入。

## 需求完成情况

Registry Pages 现在随索引发布每个选中制品的已验证 Sigstore bundle；Kit Manager 按 Registry URL 和制品 SHA-256 获取 bundle，并在本地验证证书身份、透明日志、DSSE 与 SLSA claims。现有 Release 可通过重新聚合直接迁移。

## 主要改动

- Registry aggregate 获取并验证 GitHub attestation 后，将 bundle 写入 `attestations/sha256/<digest>.json`。
- 桌面安装路径移除 `HARBORS_KIT_GITHUB_TOKEN` 和 GitHub Attestations API 调用，改为无认证 Registry 请求。
- GitHub 证明校验器复用同一套 bundle 验证逻辑，客户端路径保留严格大小、内容类型、URL 与 claims 校验。
- 更新发布工作流合同、制品文档和端到端回归测试。

## 关键决定

Registry 聚合器只负责搬运经过同一校验器验证的 bundle，客户端仍独立验证密码学证明，不信任聚合器布尔结论。bundle 地址由已验证 digest 确定，避免引入可注入的下载 URL。

## 验证结果

- `npm run check` 通过，9 个 Kit 全部完成构建、测试、打包与检查。
- 使用真实 GitHub Releases 运行 Registry aggregate：8 个 Kit、8 个 attestation bundle、0 个 revocation，聚合成功。
- 使用生产客户端校验器验证真实聚合 bundle：`verified: true`，全部请求均无 `Authorization`。
- 聚焦的证明校验、Registry、发布 CLI、Kit Manager 与下载失败回归测试全部通过。

## 影响与风险

安装不再受 GitHub 匿名 API rate limit 影响。Registry bundle 缺失或不可用时仍会拒绝安装；发布流程需要先重新聚合并部署 Pages，才能覆盖历史 Release。

## 偏差与遗留

本地 Electron 交互验收受既有稳定端口进程与开发端口冲突影响，未完成人工点击路径；全量自动化桌面、Kit Manager 和 acceptance 测试均通过。同步了两个与本功能无关的 Agent Guard `preview.7` 测试断言，并以独立测试提交记录。

## 后续关注

合并后应观察首次 Registry 部署是否生成与当前 8 个公开 Kit digest 对应的 bundle，并确认 Pages 缓存刷新。私有 Registry 认证和完整离线安装不在本次范围。

## 相关正式文档

`docs/guides/kit-artifacts.md` 已更新公开下载、Registry bundle 路径、客户端无认证行为及发布端凭据边界。
