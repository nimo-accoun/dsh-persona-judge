# Changelog

## 0.1.0

首个开源版本。

### 功能

- `persona_extract`：确定性词频统计 + 模型解释，提炼口头禅、性格与风格要求；模型不能编造统计表外的短语。
- `persona_calibrate`：只重算评分维度与及格线，权重归一化到 100。
- 逐轮自动打分（`judge: turn`）：独立模型调用，加权总分由插件计算；只报具体扣分点，不自动重做。
- 确认卡片：只在 `unsure` 时提问；一致才进入校准数据，不一致丢弃该次评分。
- `persona_judge` / `persona_feedback` / `persona_report` / `persona_review`：手动打分、回答核对、查看画像、事后补审。
- 画像与自检维度注入系统提示词；同轮重复请求改用精简指针，实测每轮从 ~3,360 tokens 降到 ~652（N=6）。
- 短交付关卡：长度、具体产物、分句数三重判断，避免「好的」也烧一次调用。

### 工程

- `Config` 用纯代码实现 Standard Schema，不依赖 schema 库；同时提供 `type` / `meta` / `dict`，避免设置服务读 `meta.volatile` 崩溃。
- 数据只落本机 `~/.dsh/persona-judge/`，可用 `DSH_PERSONA_JUDGE_HOME` 覆盖。
- 79 个测试覆盖统计、解析、加权判定与假宿主全链路。
- 工具脚本：`tools/cost-report.mjs`（token 实测）、`tools/purge-records.mjs`（清理坏记录）。
