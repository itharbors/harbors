# Kit 产品分支回迁审计

| Kit | 只读回退 tip | 迁移结论 |
| --- | --- | --- |
| SQLite | `c6bc4e725a934352a650c9a310d8c8472c038522` | 插件源码与 `main/kits/sqlite` 一致；保留 main 的运行时集成测试；移除未声明的旧 workbench 产物；迁入 `kit.json` 与 0.1.0-preview.1 版本。 |
| MySQL | `e6ccc5869d4280f553da307f5bb6899506923be2` | 插件源码与 `main/kits/mysql` 一致；保留 main 的运行时集成测试；移除未声明的旧 workbench 产物；迁入 `kit.json` 与 0.1.0-preview.1 版本。 |
| Notifications | `c777ae7b8fd4f43796d6eb83fb97fefe67bdeada` | 插件源码与 `main/kits/notifications` 一致；迁入 `kit.json` 与 0.1.0-preview.1 版本。 |

三个旧分支只作为回退来源，不再接收 Kit 开发或发布提交。旧分支根部复制的 Framework 工具、Workflow、Skill 和锁文件不迁入 `kits/*`。
