# OpenClaw 运行看板插件

这是一个可直接发布到 GitHub 的 OpenClaw 插件，用于自动启动本地运行看板，展示多智能体执行流程。

## 能力

- 读取 `agents/*/sessions/*.jsonl` 历史并实时渲染
- 展示执行总览、问题列表、Agent 活跃度和会话摘要
- 展示 `user -> main`、`sessions_spawn`、`sessions_send` 的组内时序回放
- 支持按 `groupId`、Agent、模式、关键词过滤历史
- 可切换 `显示过程信息`（工具调用/结果等过程事件）
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
openclaw gateway status
```

预期结果：
- `healthz` 返回 `{"ok":true,...}`
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

说明：安装时若提示 `child_process` 风险告警，这是预期行为，因为插件需要启动本地 Node 侧车服务。

## 本地开发

```bash
npm run check
npm --prefix dashboard-ui install
npm --prefix dashboard-ui run build
node dashboard/live-dashboard-server.js
```

## 仓库结构

- `openclaw.plugin.json`：插件元数据与配置 schema
- `index.js`：插件入口，负责启动/停止侧车服务
- `dashboard/live-dashboard-server.js`：会话解析、执行分组、只读 API、静态资源托管
- `dashboard/dist`：构建后的运行看板静态资源
- `dashboard-ui`：React + Vite 前端源码
- `examples/openclaw.json`：示例配置

## 故障排查

- 如果出现 `EADDRINUSE`，说明端口被占用。先停止已有进程，或修改 `plugins.entries.openclaw-sequence-dashboard-plugin.config.port` 后重启 Gateway。
- 如果 Gateway 重启后插件没有加载，执行 `openclaw gateway status`，并查看 `~/.openclaw/logs/gateway.log` 和 `~/.openclaw/logs/gateway.err.log`。

## 官方文档

- 插件总览：<https://docs.openclaw.ai/plugins/overview>
- 插件 API：<https://docs.openclaw.ai/plugins/plugin-api-reference>
- Gateway 配置：<https://docs.openclaw.ai/gateway/configuration-reference>
