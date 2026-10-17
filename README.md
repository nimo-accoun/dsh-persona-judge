<p align="center"><img src="assets/banner.png" alt="dsh-persona-judge" width="100%"></p>

# dsh-persona-judge

用你自己在对话里的真实发言提炼人格画像与打分标准，再由一次独立模型调用给每一轮交付打分。确认「猜对了」才沉淀为校准数据，猜错就丢弃；不及格只提示，不自动重做。

> DeepSeek Harness（DSH）插件，Node.js ≥ 20。

---

## 功能说明

| 环节 | 做什么 | 实现 |
| --- | --- | --- |
| 口头禅统计 | 2–4 字中文 n-gram 与英文词频，滤掉「这个/然后/就是」等虚词；另计标点习惯、常见开头、祈使/提问/否定比例 | `lib/shared/analyze.js` |
| 人格提炼 | 把统计证据交给模型解释成 `summary / traits / styleRules / antiPatterns / phrases`；**模型不能编造短语**，不在统计表里的短语一律丢弃 | `lib/host/extract.js` |
| 评分标准 | 同一次提取里二次调用模型，扮演你本人写出 3–6 个维度与及格线，权重强制归一化到 100 | `lib/host/extract.js` |
| 逐轮打分 | 独立模型调用，逐维度 0–100 分加理由；**加权总分由插件自己算**，不信模型算术；只报「你会不满意」的具体问题 | `lib/host/judge.js` |
| 不合格 | 只在对话里弹出、并作为工具结果返回扣分点与整改建议。**不自动重跑** | `lib/host/judge.js` |
| 核对与记录 | 弹结构化问题「我猜的和你的感觉一致吗」。一致 → 记录并上调相关维度权重；不一致 → 丢弃这次评分，原始结果照常保留 | `lib/host/confirm.js` |
| 画像注入 | 把画像与自检维度注入系统提示词；同一轮重复请求只付一份精简指针 | `lib/index.js` |
| 落盘 | `~/.dsh/persona-judge/library.json` 与 append-only 的 `judgements.jsonl` | `lib/host/store.js` |

### 什么时候不打分

短交付不评分，避免「好的」也烧一次模型调用：

- 答复合计长度 < `minTurnLength`（默认 16）且不含具体产物（路径、命令、代码、数字）→ 跳过。
- 长度 < `trivialMaxChars`（默认 120）时，必须有具体产物或 ≥ `trivialMaxClauses`（默认 2）个分句才评分。
- 长度 ≥ `trivialMaxChars` 一律评分。
- 裸数字不算产物：「1+1=2」不会被当成交付。

### 确认流程

```
一轮结束 → 判分 → 写入 library.json
                 ├─ 裁判不确定（difficulty=unsure）→ 弹核对卡片
                 │     ├─ 一致 → 该评分进入校准数据，维度权重微调
                 │     ├─ 不一致 → 丢弃该评分，保留原始记录
                 │     └─ 没答 → 不确认，宁可空着也不污染校准
                 └─ 有把握 → 不问
```

默认只在 `unsure` 时提问。每次必问会训练出反射式作答，那比不问更糟。

---

## 安装

需要已有 DSH profile（如 `desktop` / `web`）。

```powershell
# 源码链接安装（开发用）
dsh plugin add link:C:\full\path\to\dsh-persona-judge --profile desktop

# 或从打包产物安装
dsh plugin add file:C:\full\path\to\dsh-persona-judge-0.1.0.tgz --profile desktop
```

装完**重启 DSH**，宿主半部分才会加载。

---

## 快速开始

1. 在会话里让 agent 调用 `persona_extract`（至少 8 条你的消息，默认门槛见 `extractMinMessages`）。
   它会统计口头禅、提炼画像、校准评分维度。
2. 正常使用。每轮结束自动打分，结果落盘；裁判不确定时会弹核对卡片。
3. 选「一致，按这个标准记录」或两条「不一致」之一。
4. 想看当前标准：`persona_report`（不调用模型）。
5. 觉得判分标准偏了：`persona_calibrate` 只重算维度，不重提口头禅。

场景化操作、配置示例、数据清理与排错见 [docs/usage.md](docs/usage.md)。

---

## 工具

| 工具 | 作用 | 参数 |
| --- | --- | --- |
| `persona_extract` | 提取/更新画像并重新校准维度 | `extraSessions`（0–20，额外扫描的最近会话数）、`calibrate`（默认 true） |
| `persona_judge` | 立刻给已完成的一轮打分 | `ask`（是否同时弹核对，默认 true） |
| `persona_feedback` | 回答「我的猜测与你是否一致」 | `agrees`（必填）、`recordId`（省略取最近一条未确认）、`note` |
| `persona_report` | 查看画像、维度权重、及格线与历史统计 | — |
| `persona_calibrate` | 只重算维度与及格线 | — |
| `persona_review` | 事后补审指定会话 | `sessionId`、`contextMessages`（2–100）、`showTranscript` |

---

## 配置

写在 profile 的 `cordis.patch.yml` 里本插件的 `config` 下。所有字段都不是 `volatile`，因此插件设置页不生成实时表单，改配置要改文件再重启。

```yaml
- id: persona-judge
  config:
    judge: turn
    askWhen: unsure
    passScore: 82
    judgeOnlyDimensions: no_fluff,style
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时不挂载任何工具、监听与注入 |
| `judge` | `turn` | `turn` 每轮自动打分；`manual` 只用工具手动打分 |
| `askOnPass` | `true` | 是否允许弹核对卡片 |
| `askWhen` | `unsure` | `unsure` 只在裁判拿不准时弹；`always` 每次都弹 |
| `modelDifficulty` | `false` | 让裁判自己判断难度（多一次调用）；关闭时用免费的确定性关卡 |
| `passScore` | `80` | 未校准时使用的及格线（0–100） |
| `minTurnLength` | `16` | 短于此外加无产物时不评分；须 ≤ `trivialMaxChars` |
| `trivialMaxChars` | `120` | 低于此长度必须含具体产物或多分句才评分；高于此长度一律评分 |
| `trivialMaxClauses` | `2` | 低于 `trivialMaxChars` 时至少几个分句才值得评分 |
| `maxTranscriptChars` | `6000` | 判分提示词字符上限，超出取头尾 |
| `maxContextMessages` | `12` | 送入判分的最近消息条数 |
| `historyLimit` | `200` | `library.json` 保留评分数 |
| `extractMinMessages` | `8` | 少于这么多条用户消息拒绝提取 |
| `provider` / `model` / `reasoningEffort` | 空 | 判分模型；留空依次回退到「本会话正在用的模型」→「宿主默认模型」→「任一可用 provider 的首个模型」 |
| `injectPersona` | `true` | 是否把画像注入系统提示词 |
| `injectOrder` | `-50` | 注入段落排序，越小越靠前 |
| `compactSummary` | `true` | 同轮后续请求用精简画像；此开关决定精简版是否带画像开头几个字 |
| `judgeOnlyDimensions` | `no_fluff` | 判分专用维度 id，逗号分隔：会计分但不注入自检标准 |
| `autoExtractOnFirstTurn` | `false` | 启动时自动做一次冷启动提取与校准 |

`judgeOnlyDimensions` 解决的问题：有些标准是「用来判的」，不是「用来追的」。把「无客套」注入自检会让 agent 为了分数而表演简洁；只判不注入，行为才不被指标带偏。

---

## 数据

```
~/.dsh/persona-judge/
  library.json      画像、维度权重、及格线、最近 N 条评分（按 historyLimit 裁剪）
  judgements.jsonl  每次评分与每次确认的追加台账（不受裁剪）
  activation.log    挂载与判分过程日志，排错看这里
```

目录可用环境变量 `DSH_PERSONA_JUDGE_HOME` 覆盖。删除目录即重置全部数据。

---

## token 开销

插件是辅助工具，开销必须可测量。

| 项目 | 实测 | 频率 |
| --- | --- | --- |
| 画像注入（本轮首条请求） | ~357 tokens | 每轮一次 |
| 画像注入（同轮后续请求） | ~59 tokens | 每次重复请求 |
| 判分调用输入 | ~776 tokens | 每轮一次 |
| 判分调用输出 | ~400–600 tokens | 每轮一次 |

一轮有 N 次模型请求（工具循环常见 5–10 次）：

```
旧：560 × N          N=6 → 3,360
新：357 + 59×(N-1)   N=6 →   652   （降 81%）
```

注入段里只有维度的标签与权重；「怎样算好、怎样算差」只出现在判分提示词里——主 agent 写代码时用不到，判分器每轮读一次。

复查真实用量（含每次调用的 input/output/cache token）：

```powershell
node tools/cost-report.mjs
```

---

## 开发

```powershell
npm test        # 69 个用例：shared + host
npm run test:all  # 79 个用例：再加 Config 契约回归
```

覆盖短语统计与虚词过滤、容错 JSON 解析、维度加权与及格判定、卡片答案映射，以及用假宿主跑通「挂载 → 评分 → 弹问 → 记录 → 落盘 → 重启后仍在」。

`apply(ctx, config, overrides)` 的第三个参数是测试接缝：`overrides.library` / `overrides.storageRoot` 让测试用临时目录跑真实代码路径。DSH 只传前两个参数。

清理坏记录（默认 dry run，加 `--apply` 才写盘）：

```powershell
node tools/purge-records.mjs <recordId>
node tools/purge-records.mjs --apply <recordId>
```

### 排错

插件挂载失败时宿主只报 `fiberPhase: failed`，不给原因。先看 `~/.dsh/persona-judge/activation.log`：

```powershell
Get-Content "$env:USERPROFILE\.dsh\persona-judge\activation.log" -Tail 40
```

常见原因：`Config` 不是 Standard Schema 对象（`Cannot read properties of undefined (reading 'validate')`）；`Config` 缺 `type`/`meta`/`dict` 会让设置服务在 `settings/describe` 抛错，桌面端欢迎页随之打不开。

---

## 设计取舍

- **只有你确认「猜对了」，这次评分才成为校准数据。** 不一致时不是反向调权重（那等于把未知方向的信号当已知方向），而是丢弃这次判断。
- **不自动重做。** 判分失败只给结论与整改建议，重做与否由你决定。
- **统计与解释分离。** 模型看到的是词频表而非原始语料，因此造不出你没说过的口头禅。
- **判分只读会话日志，不读实时上下文。** 工具密集的一轮里，实时上下文会把多轮助手文本混在一起，实测曾把 2 字提问配 2989 字回答判成 44 分。

---

## License

MIT
