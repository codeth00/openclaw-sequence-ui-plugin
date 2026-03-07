# OpenClaw 运行看板插件

这是一个 OpenClaw 插件，用于自动启动本地运行看板，展示多智能体执行过程。

新版看板是双视图只读控制台：
- `运行总览`：执行分组、问题列表、Agent 活跃度、会话摘要
- `时序图`：按执行分组回放 `user -> main`、`sessions_spawn`、`sessions_send`

## 能力

- 读取 `agents/*/sessions/*.jsonl` 历史并实时渲染
- 基于事件自动聚合执行分组，生成总览摘要和问题提示
- 支持按 `groupId`、Agent、模式、关键词过滤历史
- 提供只读接口：
  - `GET /api/overview`
  - `GET /api/executions`
  - `GET /api/executions/:id`
  - `GET /api/history`
  - `GET /api/events`
- 可切换 `显示过程信息`，查看工具调用、工具结果和过程事件
- 修复子任务回传漏显（spawn completion fallback）

## 安装步骤

```bash
git clone https://github.com/codeth00/openclaw-sequence-ui-plugin /tmp/openclaw-sequence-ui-plugin
cd /tmp/openclaw-sequence-ui-plugin
npm run check
openclaw plugins install /tmp/openclaw-sequence-ui-plugin
node /tmp/openclaw-sequence-ui-plugin/scripts/configure-openclaw.js
openclaw gateway restart
```

说明：
- 请使用本地可写目录，`/tmp` 是一个安全默认值。
- `openclaw plugins install` 需要本地路径，所以要先 `git clone`，再从 clone 目录安装。

## 使用

完成后访问：
- `http://127.0.0.1:8787`

## 验证

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/api/overview
curl 'http://127.0.0.1:8787/api/executions?limit=5'
openclaw gateway status
```

预期结果：
- `healthz` 返回 `{"ok":true,...}`
- `/api/overview` 返回执行总览 JSON
- `/api/executions` 返回执行分组列表
- Gateway 监听 `127.0.0.1:18789`
- 插件看板监听 `127.0.0.1:8787`

## 配置

参考：`examples/openclaw.json`

把以下内容并入 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "openclaw-sequence-dashboard-plugin": {
        "enabled": true,
        "config": {
          "host": "127.0.0.1",
          "port": 8787,
          "openclawHome": "~/.openclaw",
          "agentsDir": ""
        }
      }
    }
  }
}
```

配置项说明：
- `host`：看板监听地址
- `port`：看板监听端口
- `openclawHome`：OpenClaw 根目录
- `agentsDir`：可选，直接指定 `agents` 目录

说明：安装时若提示 `child_process` 风险告警，这是预期行为，因为插件会启动本地 Node 侧车服务。

## 本地开发

```bash
npm --prefix dashboard-ui install
npm run check
node dashboard/live-dashboard-server.js
```

如果只想单独构建前端：

```bash
npm run build:ui
```

## 仓库结构

- `openclaw.plugin.json`：插件元数据与配置 schema
- `index.js`：插件入口，负责启动/停止侧车服务
- `dashboard/live-dashboard-server.js`：会话解析、执行分组、只读 API、静态资源托管
- `dashboard/dist`：构建后的运行看板静态资源
- `dashboard-ui`：React + Vite 前端源码
- `tests/live-dashboard-server.test.js`：事件分组和 API 契约测试
- `examples/openclaw.json`：示例配置

## 故障排查

- 如果出现 `EADDRINUSE`，说明端口被占用。先停止已有进程，或修改 `plugins.entries.openclaw-sequence-dashboard-plugin.config.port` 后重启 Gateway。
- 如果页面是旧版时序图，说明当前跑的是旧插件副本；重新安装插件或直接用当前仓库启动服务。
- 如果 `/api/overview` 返回 `404`，说明当前运行的不是 V2 服务。
- 如果看板空白，先确认 `openclawHome` / `agentsDir` 指向有效的 `agents/*/sessions`。
- 如果 Gateway 重启后插件没有加载，执行 `openclaw gateway status`，并查看 `~/.openclaw/logs/gateway.log` 和 `~/.openclaw/logs/gateway.err.log`。

## 官方文档

- 插件总览：<https://docs.openclaw.ai/plugins/overview>
- 插件 API：<https://docs.openclaw.ai/plugins/plugin-api-reference>
- Gateway 配置：<https://docs.openclaw.ai/gateway/configuration-reference>
