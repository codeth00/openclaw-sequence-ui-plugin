# 消息列表解析指导

这份文档说明两套字段：

1. OpenClaw session 原始 `jsonl` 里的字段
2. 本看板解析后使用的标准化事件字段

适用范围：

- `~/.openclaw/agents/*/sessions/*.jsonl`
- `dashboard/live-dashboard-server.js`
- 旧版 JS 看板 `dashboard/index.html`

## 1. 原始 session 记录格式

每一行都是一条 JSON 记录，常见顶层字段：

- `type`: 记录类型。常见值有 `session`、`model_change`、`thinking_level_change`、`custom`、`message`
- `id`: 当前记录唯一 ID
- `parentId`: 父记录 ID，用来串起一次运行链路
- `timestamp`: ISO 时间字符串

常见记录类型：

- `type: "session"`: 会话头，包含 `version`、`id`、`cwd`
- `type: "model_change"`: 模型切换，常见字段有 `provider`、`modelId`
- `type: "thinking_level_change"`: thinking 配置变化
- `type: "custom" + customType: "model-snapshot"`: 模型快照
- `type: "message"`: 真正的消息、工具调用、工具结果都在这里

## 2. `message` 记录怎么读

`type: "message"` 时，核心字段在 `message` 对象里：

- `message.role`: 消息角色。常见值有 `user`、`assistant`、`toolResult`
- `message.content`: 内容数组。不同 `role` 下结构不同
- `message.model`: 当前 assistant 使用的模型
- `message.usage`: token 统计，常见字段有 `input`、`output`、`cacheRead`、`cacheWrite`、`totalTokens`
- `message.stopReason`: 停止原因，例如 `toolUse`、`stop`
- `message.provenance`: 来源信息，主要用于跨会话投递判断

### 2.1 `role: "user"`

通常表示用户输入，最常见内容：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "你是谁" }
  ]
}
```

关键字段：

- `content[].type === "text"`: 文本消息
- `content[].text`: 用户原文
- `provenance.kind === "inter_session"`: 表示这条 `user` 其实是别的 session 投递过来的消息，不是人类直接输入

### 2.2 `role: "assistant"`

assistant 一条消息可能混合多段内容，常见 `content[]` 类型：

- `type: "thinking"`
- `type: "toolCall"`
- `type: "text"`

#### `thinking`

```json
{ "type": "thinking", "thinking": "..." }
```

字段作用：

- `thinking`: 中间推理正文
- `thinkingSignature`: thinking 的签名或来源标记

#### `toolCall`

```json
{
  "type": "toolCall",
  "id": "call_xxx",
  "name": "exec",
  "arguments": { "command": "ls -la" }
}
```

字段作用：

- `id`: 这次工具调用的 ID，后续 `toolResult.toolCallId` 会回到它
- `name`: 工具名，例如 `exec`、`read`、`sessions_spawn`、`sessions_send`
- `arguments`: 工具参数

#### `text`

```json
{ "type": "text", "text": "最终回复" }
```

字段作用：

- `text`: assistant 对外展示的正式回复

### 2.3 `role: "toolResult"`

工具返回结果，典型结构：

```json
{
  "role": "toolResult",
  "toolCallId": "call_xxx",
  "toolName": "exec",
  "content": [{ "type": "text", "text": "..." }],
  "details": { "...": "..." },
  "isError": false
}
```

字段作用：

- `toolCallId`: 对应前面的 `toolCall.id`
- `toolName`: 工具名
- `content`: 文本化结果
- `details`: 结构化结果，优先级通常高于 `content`
- `isError`: 是否错误

## 3. 看板如何把原始消息映射成事件

看板只关心 4 类标准事件：

- `user`
- `spawn`
- `a2a`
- `internal`

映射规则：

- `assistant.content[].thinking` -> `mode: "internal"`, `stage: "thinking"`
- 普通工具调用，例如 `exec/read/write/search/fetch` -> `mode: "internal"`, `stage: "call"`
- 普通工具结果 -> `mode: "internal"`, `stage: "result"`
- `sessions_spawn` -> `mode: "spawn"`
- `sessions_send` -> `mode: "a2a"`
- `main -> user` 文本回复 -> `mode: "user"`, `stage: "reply"`
- `user -> main` 输入 -> `mode: "user"`, `stage: "prompt"`
- 跨会话投递回来时，根据 `provenance` 和文本内容判断是 `spawn delivery` 还是 `a2a delivery`

## 4. 看板标准化后的事件字段

前端实际使用的是标准化事件对象，核心字段如下：

- `id`: 事件唯一 ID
- `ts`: 毫秒时间戳
- `mode`: 事件大类，值为 `user | spawn | a2a | internal`
- `from`: 发送方 agent
- `to`: 接收方 agent
- `text`: 当前事件展示文本
- `sessionTag`: 会话标识，通常形如 `agent:<agentId>:<sessionId>`
- `sessionAgent`: 当前会话所属 agent
- `mechanism`: 机制名，常见值如 `sessions_spawn`、`sessions_send`、`exec`、`read`
- `stage`: 阶段名，常见值如 `prompt`、`reply`、`thinking`、`call`、`result`、`delivery`
- `metrics`: 从 assistant 原始消息继承的指标

### `metrics` 字段

用于展示模型和 token 信息：

- `sourceMessageId`: 这批拆分事件来自哪条 assistant message
- `model`: 模型名
- `input`: 输入 token
- `output`: 输出 token
- `cacheRead`: cache read token
- `cacheWrite`: cache write token
- `totalTokens`: 总 token
- `contextWindow`: 上下文窗口
- `contextPercent`: `input / contextWindow` 的百分比，只有能算出来时才有值

## 5. 解析时的几个实用约定

- 一条 assistant message 可能拆成多条看板事件，例如 `thinking + toolCall + text`
- 同一条 assistant message 拆出的事件会共享同一个 `metrics.sourceMessageId`
- `details` 比 `content` 更适合做结构化展示
- `sessions_spawn` 和 `sessions_send` 需要单独识别，不能和普通工具混在一起
- `user` 记录不一定真的是“人类输入”，跨 session 投递也会落成 `role: "user"`

## 6. 最小判断顺序

如果你要自己写解析器，建议顺序如下：

1. 先按顶层 `type` 过滤，只重点处理 `message`
2. 再按 `message.role` 分成 `user / assistant / toolResult`
3. 对 `assistant.content[]` 逐段处理：`thinking`、`toolCall`、`text`
4. 对 `toolResult` 用 `toolName + toolCallId + details`
5. 对 `user + provenance.kind` 判断是不是跨会话投递
6. 最后再补 `metrics`
