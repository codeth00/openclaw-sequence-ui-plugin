#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_ID = "openclaw-sequence-dashboard-plugin";

function expandHome(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function readJson(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main() {
  const cfgPath = resolveConfigPath(process.argv[2]);
  const host = process.argv[3] || "127.0.0.1";
  const portVal = Number(process.argv[4] || 8787);
  const port = Number.isFinite(portVal) && portVal > 0 ? Math.floor(portVal) : 8787;

  let json = {};
  if (fs.existsSync(cfgPath)) {
    json = readJson(cfgPath);
    const backupPath = `${cfgPath}.bak.${new Date().toISOString().replace(/[:]/g, "-")}`;
    fs.copyFileSync(cfgPath, backupPath);
    console.log(`Backup: ${backupPath}`);
  }

  if (!json.plugins || typeof json.plugins !== "object") json.plugins = {};
  json.plugins.enabled = true;

  if (!json.plugins.entries || typeof json.plugins.entries !== "object") {
    json.plugins.entries = {};
  }

  const current = json.plugins.entries[PLUGIN_ID] || {};
  json.plugins.entries[PLUGIN_ID] = {
    enabled: true,
    config: {
      host,
      port,
      openclawHome: "~/.openclaw",
      agentsDir: "",
      ...(current.config && typeof current.config === "object" ? current.config : {})
    }
  };

  writeJson(cfgPath, json);
  console.log(`Updated: ${cfgPath}`);
  console.log(`Enabled plugin entry: plugins.entries.${PLUGIN_ID}`);
}

function resolveConfigPath(input) {
  if (input && String(input).trim()) return path.resolve(expandHome(input));
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

main();
