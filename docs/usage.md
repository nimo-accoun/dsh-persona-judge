# 使用说明

面向已经装好插件的使用者。功能与配置总表见 [README](../README.md)。

## 1. 第一次使用

1. **重启 DSH**。插件分宿主与工具两半，只装不重启时工具不会出现。
2. 在会话里说一句「提取一下我的人格画像」，或直接让 agent 调 `persona_extract`。
   - 至少需要 `extractMinMessages`（默认 8）条**你本人**的消息。
   - 粘贴的日志、进度报告、工具输出会被过滤，不算你的发言。
3. 看返回结果：命中多少重复短语、画像摘要、校准出的维度与及格线。
4. 之后照常聊天。每轮结束自动打分（`judge: turn` 时）。

## 2. 日常流程

| 你想做的事 | 怎么做 |
| --- | --- |
| 看当前画像与维度 | `persona_report`，不调模型，不花钱 |
| 只改判分标准，不重提口头禅 | `persona_calibrate` |
| 手动给某一轮打分 | `persona_judge`，可传 `ask: false` 不弹核对 |
| 补审另一条会话 | `persona_review`，传 `sessionId`；`showTranscript: true` 会附判分用的对话节选 |
| 回答核对问题 | 直接点卡片；也可之后用 `persona_feedback`，`agrees` 必填 |
| 关闭自动打分 | 配置 `judge: manual`，重启 |

**核对卡片什么时候弹**：默认 `askWhen: unsure`，只有裁判自己标了 `unsure` 才弹。想每次都弹就设 `always`——但每次必答会把确认变成反射动作，反而给校准灌噪声。

卡片三个选项的含义：

| 选项 | 插件动作 |
| --- | --- |
| 一致，按这个标准记录 | 该评分进入校准数据，得分最低的维度权重上调 |
| 不一致，我实际的标准不同 | 丢弃这次评分，原始记录保留 |
| 不一致，这次我本来就满意 | 同样丢弃，不反向调权重 |

不回答不会写坏数据：记录停在「未确认」。

## 3. 配置示例

改 profile 的 `cordis.patch.yml`，重启生效。

```yaml
- id: persona-judge
  config:
    # 只在手动调用时打分
    judge: manual
    # 及格线抬到 85
    passScore: 85
    # 每次都弹核对（谨慎）
    askWhen: always
    # 「无客套」「贴近我说话」只判不注入
    judgeOnlyDimensions: no_fluff,style
    # 判分用便宜模型，避免和主模型抢额度
    provider: deepseek
    model: deepseek-chat
    # 换一个便宜的推理档
    reasoningEffort: low
```

要点：

- `minTurnLength` 必须 ≤ `trivialMaxChars`，否则两条阈值对「短」的定义互相矛盾，该留的交付会被长度关卡砍掉。
- `judgeOnlyDimensions` 是逗号分隔的**维度 id**（如 `style`、`no_fluff`），不是中文标签。
- 判分模型留空时按此顺序回退：本会话正在用的模型 → 宿主默认模型 → 任一可用 provider 的首个模型。

## 4. 数据清理

```powershell
# 目录位置
$env:USERPROFILE\.dsh\persona-judge\

# 删掉某条坏评分（默认只打印，不写盘）
node tools/purge-records.mjs <recordId>
node tools/purge-records.mjs --apply <recordId>

# 完全重置：画像、维度、评分全没了
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\persona-judge"
```

`library.json` 里的评分受 `historyLimit` 裁剪，`judgements.jsonl` 是追加台账、不裁剪，统计与复查以它为准。

换一个独立数据目录（多环境隔离）：

```powershell
$env:DSH_PERSONA_JUDGE_HOME = 'D:\persona-data'
```

## 5. 排错

**看不到这 6 个工具** → 插件没挂载或没重启。查日志：

```powershell
Get-Content "$env:USERPROFILE\.dsh\persona-judge\activation.log" -Tail 40
```

日志里找这几行：

- `apply() entered` 之后没有 `apply() completed successfully` → 挂载中途抛错，错误就在后面几行。
- `no judge route (...)` → 没有可用模型路由，判分整体跳过。
- `turn-stopping: skipped (...)` → 事件到了但被配置或条件挡掉，括号里写了原因。
- `turn N not scored: not-worth-scoring` → 交付太短或被判定为闲聊，属正常。
- `confirmation not asked: user-questions-unavailable` → 宿主没有 `userQuestions` 服务（无头环境），核对卡片不会出现，改用 `persona_feedback`。

**判分总是「未评分」** → 看括号里的字符数与阈值。要么这轮太短，要么取不到对话（会话已归档或日志读不到）。

**画像像别人** → 统计里混进了机器生成文本。先 `persona_extract` 重跑一次；仍不对就删库重来，并尽量在干净会话里提取。

**桌面端打不开** → 检查 `Config` 的 `type`/`meta`/`dict` 是否齐全。缺了会在 `settings/describe` 抛 `Cannot read properties of undefined (reading 'volatile')`，欢迎页随之失败。

## 6. 隐私

- 所有数据只落在本机 `~/.dsh/persona-judge/`，插件不上传。
- 判分与提取会把画像、最近若干条消息（受 `maxTranscriptChars` / `maxContextMessages` 限制）发给**你自己配置的**模型 provider。
- 想降低外发量：调小 `maxTranscriptChars`、调小 `maxContextMessages`，或 `judge: manual` 只在需要时打分。
