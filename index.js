"use strict";

const { existsSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { spawn } = require("node:child_process");
const { homedir } = require("node:os");

const PLUGIN_ID = "openclaw-sequence-dashboard-plugin";
const SERVICE_ID = "openclaw-sequence-dashboard-plugin.service";

let dashboardProc = null;

function expandHome(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return text;
}

function readPluginConfig(api) {
  const entries =
    api &&
    api.config &&
    api.config.plugins &&
    api.config.plugins.entries
      ? api.config.plugins.entries
      : {};

  const raw = (entries[PLUGIN_ID] && entries[PLUGIN_ID].config) || {};

  const host = String(raw.host || "127.0.0.1").trim() || "127.0.0.1";
  const portNum = Number(raw.port || 8787);
  const port = Number.isFinite(portNum) && portNum > 0 ? Math.floor(portNum) : 8787;

  const openclawHome = resolve(
    expandHome(raw.openclawHome || process.env.OPENCLAW_HOME || "~/.openclaw")
  );

  const agentsDir = String(raw.agentsDir || "").trim()
    ? resolve(expandHome(raw.agentsDir))
    : join(openclawHome, "agents");

  return {
    host,
    port,
    openclawHome,
    agentsDir,
    scriptPath: join(__dirname, "dashboard", "live-dashboard-server.js"),
    scriptDir: join(__dirname, "dashboard")
  };
}

function stopDashboard(api) {
  if (!dashboardProc) return;

  try {
    dashboardProc.removeAllListeners();
    dashboardProc.kill("SIGTERM");
  } catch {
    // no-op
  }

  if (api && api.logger && typeof api.logger.info === "function") {
    api.logger.info(`[${PLUGIN_ID}] dashboard stopped`);
  }

  dashboardProc = null;
}

function startDashboard(api) {
  if (dashboardProc) return;

  const cfg = readPluginConfig(api);
  if (!existsSync(cfg.scriptPath)) {
    if (api && api.logger && typeof api.logger.warn === "function") {
      api.logger.warn(`[${PLUGIN_ID}] script missing: ${cfg.scriptPath}`);
    }
    return;
  }

  const env = {
    ...process.env,
    OPENCLAW_DASHBOARD_HOST: cfg.host,
    OPENCLAW_DASHBOARD_PORT: String(cfg.port),
    OPENCLAW_HOME: cfg.openclawHome,
    OPENCLAW_AGENTS_DIR: cfg.agentsDir
  };

  dashboardProc = spawn(process.execPath, [cfg.scriptPath], {
    cwd: cfg.scriptDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (dashboardProc.stdout) {
    dashboardProc.stdout.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (!text) return;
      if (api && api.logger && typeof api.logger.info === "function") {
        api.logger.info(`[${PLUGIN_ID}] ${text}`);
      }
    });
  }

  if (dashboardProc.stderr) {
    dashboardProc.stderr.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (!text) return;
      if (api && api.logger && typeof api.logger.warn === "function") {
        api.logger.warn(`[${PLUGIN_ID}] ${text}`);
      }
    });
  }

  dashboardProc.on("exit", (code, signal) => {
    if (api && api.logger && typeof api.logger.warn === "function") {
      api.logger.warn(
        `[${PLUGIN_ID}] dashboard exited (code=${code === null ? "null" : code}, signal=${signal || "none"})`
      );
    }
    dashboardProc = null;
  });

  if (api && api.logger && typeof api.logger.info === "function") {
    api.logger.info(
      `[${PLUGIN_ID}] dashboard started at http://${cfg.host}:${cfg.port} (pid=${dashboardProc.pid || "unknown"})`
    );
  }
}

module.exports = function register(api) {
  if (!api || typeof api.registerService !== "function") {
    throw new Error(`[${PLUGIN_ID}] registerService API is required`);
  }

  api.registerService({
    id: SERVICE_ID,
    start: () => startDashboard(api),
    stop: () => stopDashboard(api)
  });
};
