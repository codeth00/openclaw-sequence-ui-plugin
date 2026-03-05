# OpenClaw 时序图插件

这是一个可直接发布到 GitHub 的 OpenClaw 插件，用于自动启动本地时序图看板，展示多智能体执行流程。

## 能力

- 读取 `agents/*/sessions/*.jsonl` 历史并实时渲染
- 展示 `user -> main`、`sessions_spawn`、`sessions_send`
- 并行 `sessions_spawn` 分组展示
- 可切换 `显示过程信息`（工具调用/结果等过程事件）
- 修复子任务回传漏显（spawn completion fallback）

## 快速安装（GitHub）

```bash
git clone https://github.com/<YOUR_ORG>/openclaw-sequence-dashboard-plugin.git
cd openclaw-sequence-dashboard-plugin
openclaw plugins install .
node scripts/configure-openclaw.js
```

然后重启 Gateway，访问：
- `http://127.0.0.1:8787`

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

## 官方文档

- 插件总览：<https://docs.openclaw.ai/plugins/overview>
- 插件 API：<https://docs.openclaw.ai/plugins/plugin-api-reference>
- Gateway 配置：<https://docs.openclaw.ai/gateway/configuration-reference>
