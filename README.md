# OpenClaw Sequence Dashboard Plugin

A production-ready OpenClaw plugin that auto-starts a local timeline dashboard for multi-agent execution visualization.

It renders interactions among:
- user -> main
- main <-> subagents (`sessions_spawn`)
- agent <-> agent (`sessions_send`)
- optional internal process events (tool calls/results and process markers)

## Features

- Reads real OpenClaw session history from `agents/*/sessions/*.jsonl`
- Real-time updates via SSE (`/api/events`)
- Sequence diagram with sticky headers and session separators
- Parallel `sessions_spawn` grouping
- `显示过程信息` toggle for internal process events
- Spawn completion fallback parsing (prevents lost child-task completion visualization)

## Requirements

- OpenClaw Gateway with Plugin support
- Node.js >= 18

## Install

```bash
git clone https://github.com/codeth00/openclaw-sequence-ui-plugin /tmp/openclaw-sequence-ui-plugin
cd /tmp/openclaw-sequence-ui-plugin
npm run check
openclaw plugins install /tmp/openclaw-sequence-ui-plugin
node /tmp/openclaw-sequence-ui-plugin/scripts/configure-openclaw.js
openclaw gateway restart
```

Notes:
- Use any writable local directory. `/tmp` is a safe default.
- `openclaw plugins install` expects a local path. Clone first, then install from that path.

## Use

After Gateway restart, open:
- `http://127.0.0.1:8787`

## Verify

```bash
curl http://127.0.0.1:8787/healthz
openclaw gateway status
```

Expected:
- `healthz` returns JSON like `{"ok":true,...}`
- Gateway is listening on `127.0.0.1:18789`
- Dashboard is listening on `127.0.0.1:8787`

## Configuration

Add (or merge) into `~/.openclaw/openclaw.json`:

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

Config fields:
- `host`: bind host
- `port`: bind port
- `openclawHome`: OpenClaw home root
- `agentsDir`: optional direct `agents` path override

## Local Development

```bash
npm run check
node dashboard/live-dashboard-server.js
```

## Repository Structure

- `openclaw.plugin.json`: plugin metadata and config schema
- `index.js`: plugin entry (`registerService` to start/stop sidecar)
- `dashboard/index.html`: sequence diagram UI
- `dashboard/live-dashboard-server.js`: session parser + SSE server
- `examples/openclaw.json`: sample gateway plugin config

## Troubleshooting

- `EADDRINUSE` on startup: change plugin `port`.
- Blank timeline: verify `openclawHome` / `agentsDir` points to valid `agents/*/sessions`.
- No process events: click `显示过程信息` in UI.
- Install warning about `child_process`: expected; this plugin intentionally starts a local Node sidecar service.
- If the dashboard port is already occupied, either stop the existing process or change `plugins.entries.openclaw-sequence-dashboard-plugin.config.port` and restart Gateway.
- If Gateway restarts but the plugin does not load, run `openclaw gateway status` and inspect `~/.openclaw/logs/gateway.log` and `~/.openclaw/logs/gateway.err.log`.

## Official References

- Plugin overview: [docs.openclaw.ai/plugins/overview](https://docs.openclaw.ai/plugins/overview)
- Plugin API (`registerService`): [docs.openclaw.ai/plugins/plugin-api-reference](https://docs.openclaw.ai/plugins/plugin-api-reference)
- Gateway config (`plugins.enabled`, `plugins.entries`): [docs.openclaw.ai/gateway/configuration-reference](https://docs.openclaw.ai/gateway/configuration-reference)
- Hook events (`gateway:startup`): [docs.openclaw.ai/hooks/events-and-payloads](https://docs.openclaw.ai/hooks/events-and-payloads)

## License

MIT
