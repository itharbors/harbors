# Context Store 评测

这里的资产独立于单元测试，用于比较现行 `surface-v1` 与候选 `candidate-v1`。Q30 评价召回质量，P100 记录本机性能原始样本；两者都不把未执行伪装成通过。

## Q30 真实 Provider 评测

`q30.fixture.json` v2 固定 30 条中文用例：10 条单轮目标与约束、10 条多轮纠正、10 条十轮延迟召回。每条包含期望最终状态、必须召回的锚点，以及按状态字段声明的失效旧值或相似负例。v2 不改变用例意图，只把最终状态字段、值类型和被替换值写清楚。

Runner 默认每例重复 3 次。可以直连 OpenAI Chat Completions 兼容 endpoint，也可以通过 Harbors Web 宿主的正式 `model-service.complete` 消息链执行。未配置 transport 或 model 时输出 `skipped`，不产生通过数。

本评测只比较 Context 装配质量：fixture 的最终有效状态会作为确定性 `state/set` 输入候选版本；模型是否正确调用状态工具由 Agent 集成测试单独验证，Q30 不把这两个变量混在一起。

```bash
HARBORS_Q30_ENDPOINT=https://provider.example/v1/chat/completions \
HARBORS_Q30_MODEL=model-id \
HARBORS_Q30_API_KEY=secret \
HARBORS_Q30_OUTPUT=/tmp/q30-result.json \
pnpm exec tsx kits/harness/plugins/agent-context-store/eval/q30.runner.ts
```

`HARBORS_Q30_API_KEY` 和 `HARBORS_Q30_OUTPUT` 可选，超时可通过 `HARBORS_Q30_TIMEOUT_MS` 设置。报告为 JSON，逐例包含 `current`、`candidate` 的执行状态、耗时、状态/锚点/失效旧值评分与 Provider 原始结构化答案。

评分只判断最终结构化 `state` 和必须召回的锚点。字符串会归一化大小写、全半角、空白和标点；标量与单元素数组视为等价；失效旧值只在 fixture 指定的状态字段中检查。回答中引用“不要修改 `src/index.ts`”不会再被误判成实际选择了“修改 `src/index.ts`”，但最终状态缺字段、布尔值错误、锚点缺失或仍保留旧值仍会失败。

Harbors 消息链模式需要 Agent Panel 的临时 capability，由 Web 宿主签发，不写入报告：

```bash
HARBORS_Q30_HARBORS_URL=http://127.0.0.1:49381 \
HARBORS_Q30_SESSION_ID='<runtime-session-id>' \
HARBORS_Q30_PANEL_CAPABILITY='<agent-panel-capability>' \
HARBORS_Q30_MODEL=model-id \
HARBORS_Q30_OUTPUT=/tmp/q30-result.json \
pnpm --dir kits/harness run eval:q30
```

`HARBORS_Q30_REPEATS` 默认是 3，`HARBORS_Q30_RETRY_ATTEMPTS` 默认是 3；有限重试只处理 Provider/解析错误，不重试已完成但语义评分失败的答案。中断后可用 `HARBORS_Q30_RESUME=<已有报告>` 只补 error，已完成结果保持不变。Runner 会校验 fixture digest，题集变化后不能复用旧报告。

门禁要求 candidate 的全部重复都可评分、candidate 通过数不低于 current，并且不存在同一 case/repeat 中 current 通过而 candidate 失败的回归。current 的 Provider/解析错误作为 baseline 失败保留在逐例报告中；它不阻止一个全量完成且无逐例回归的 candidate。

Fixture 的确定性检查：

```bash
pnpm exec tsx --test kits/harness/plugins/agent-context-store/eval/q30.fixture.test.ts
```

## P100 本机基准

P100 分别建立 1、10、50、100 Turn 的会话，记录每次 SQLite append、`surface-v1` 装配和 `candidate-v1` 装配的原始毫秒样本，同时输出 Node、系统和 CPU 信息：

```bash
HARBORS_P100_SAMPLES=30 \
HARBORS_P100_OUTPUT=/tmp/p100-result.json \
pnpm exec tsx kits/harness/plugins/agent-context-store/benchmark/p100.benchmark.ts
```

`HARBORS_P100_OUTPUT` 可选；不设置时仍会把完整 JSON 写到标准输出。Runner 断言固定 fixture 的候选来源不超过 9、100 Turn 候选 P95 不超过同规模 current 的 2 倍且不超过 10 Turn 候选 P95 的 4 倍，失败时返回非零。不同机器的数字不可直接作为回归结论，应在同一机器、相同 Node 版本下比较 current 与 candidate。
