# Harbors Kit Registry

此分支只保存经过审核的 Kit 元数据和吊销记录。`registry/entries/` 下每个条目必须能与对应 GitHub Release 对账；推送到 `kit-registry` 后，工作流才会生成 `index.v1.json` 并部署到 GitHub Pages。

发布工具链来自受保护的 `kit-publish-v1` 引用，本分支不保存或执行 Kit 制品。
