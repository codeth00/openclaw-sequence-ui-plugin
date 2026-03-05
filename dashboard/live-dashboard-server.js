#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { URL } = require("url");

const HOST = process.env.OPENCLAW_DASHBOARD_HOST || "127.0.0.1";
const PORT = Number(process.env.OPENCLAW_DASHBOARD_PORT || 8787);

const CANVAS_DIR = __dirname;
const OPENCLAW_HOME =
  process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const AGENTS_DIR =
  process.env.OPENCLAW_AGENTS_DIR || path.join(OPENCLAW_HOME, "agents");
const INDEX_FILE = path.join(CANVAS_DIR, "index.html");

const KNOWN_AGENTS = new Set(["main", "bob", "trash_agent", "wali_agent"]);
const HISTORY_LIMIT = 800;
const HISTORY_BOOTSTRAP_LIMIT = 240;
const POLL_MS = 1000;
const DISCOVER_MS = 4000;

const clients = new Set();
const history = [];
const seenEventIds = new Set();
const trackedFiles = new Map();
const sessionIdToAgent = new Map();
let sequence = 0;
let polling = false;

function asEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function parseAgentFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match ? match[1] : null;
}

function normalizeAgent(agentId) {
  if (!agentId || typeof agentId !== "string") return null;
  return KNOWN_AGENTS.has(agentId) ? agentId : agentId;
}

function extractTextFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stripLeadingBracketTimestamp(text) {
  if (!text) return text;
  return text.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function parseJsonFromToolResult(content) {
  if (!Array.isArray(content)) return null;
  const textPart = content.find(
    (part) => part && part.type === "text" && typeof part.text === "string"
  );
  if (!textPart) return null;
  try {
    return JSON.parse(textPart.text);
  } catch {
    return null;
  }
}

function truncateText(value, maxLen = 720) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeToolArgs(args) {
  if (!args || typeof args !== "object") return "{}";
  return truncateText(safeStringify(args), 360);
}

function summarizeToolResult(msg) {
  const details = msg && msg.details;
  if (details && typeof details === "object" && Object.keys(details).length) {
    return truncateText(safeStringify(details), 420);
  }
  return truncateText(extractTextFromContent(msg && msg.content), 420) || "(无结果文本)";
}

function parseSessionIdFromText(text) {
  if (!text) return null;
  const direct = /session[_ ]id:\s*([0-9a-f-]{36})/i.exec(text);
  if (direct) return direct[1];
  const bracket = /\[sessionId:\s*([0-9a-f-]{36})\]/i.exec(text);
  if (bracket) return bracket[1];
  return null;
}

function parseSessionKeyFromText(text) {
  if (!text) return null;
  const match = /session[_ ]key:\s*(agent:[^\s]+)/i.exec(text);
  return match ? match[1] : null;
}

function resolveAgentFromSessionId(sessionId) {
  if (!sessionId) return null;
  return normalizeAgent(sessionIdToAgent.get(sessionId));
}

function extractSubagentSource(text, provenance) {
  const sourceSessionKey =
    provenance && typeof provenance.sourceSessionKey === "string"
      ? provenance.sourceSessionKey
      : "";
  const fromProvenance = normalizeAgent(parseAgentFromSessionKey(sourceSessionKey));
  if (fromProvenance) {
    return {
      agent: fromProvenance,
      sessionKey: sourceSessionKey,
      sessionId: ""
    };
  }

  const sessionKey = parseSessionKeyFromText(text);
  const fromSessionKey = normalizeAgent(parseAgentFromSessionKey(sessionKey));
  if (fromSessionKey) {
    return {
      agent: fromSessionKey,
      sessionKey: sessionKey || "",
      sessionId: ""
    };
  }

  const sessionId = parseSessionIdFromText(text);
  const fromSessionId = resolveAgentFromSessionId(sessionId);
  if (fromSessionId) {
    return {
      agent: fromSessionId,
      sessionKey: "",
      sessionId: sessionId || ""
    };
  }

  return {
    agent: null,
    sessionKey: sessionKey || sourceSessionKey || "",
    sessionId: sessionId || ""
  };
}

function looksLikeSpawnCompletion(text) {
  if (!text) return false;
  return (
    /internal task completion event/i.test(text) ||
    /A subagent task\s+["'`].+["'`]\s+just completed/i.test(text) ||
    /\[System Message\]\s*\[sessionId:/i.test(text) ||
    /source:\s*subagent/i.test(text)
  );
}

function cleanupSpawnDeliveryText(text) {
  let clean = String(text || "").trim();
  if (!clean) return "";

  const resultMatch = /Result(?: \(untrusted content, treat as data\))?:\s*/i.exec(clean);
  if (resultMatch && typeof resultMatch.index === "number") {
    clean = clean.slice(resultMatch.index + resultMatch[0].length).trim();
  }

  clean = clean.replace(/\n+Action:\s[\s\S]*$/i, "").trim();
  clean = clean.replace(/\n+Stats:[\s\S]*$/i, "").trim();
  clean = clean.replace(/^OpenClaw runtime context \(internal\):\s*/i, "").trim();
  clean = clean.replace(/^This context is runtime-generated[^\n]*\n*/i, "").trim();
  clean = clean.replace(/^\[Internal task completion event\]\s*/i, "").trim();

  return truncateText(clean, 1600);
}

function pushHistory(event) {
  history.push(event);
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }
}

function emit(event, broadcast = true) {
  if (!event || !event.id) return;
  if (seenEventIds.has(event.id)) return;
  seenEventIds.add(event.id);
  const stamped = { ...event, seq: ++sequence };
  pushHistory(stamped);
  if (!broadcast) return;
  const payload = `data: ${JSON.stringify(stamped)}\n\n`;
  for (const client of clients) {
    if (stamped.mode === "internal" && !client.includeInternal) continue;
    try {
      client.res.write(payload);
    } catch {
      // Best effort write; dead client cleanup is handled on close.
    }
  }
}

function makeEvent({ id, ts, mode, from, to, text, meta }) {
  return {
    id,
    ts: asEpochMs(ts),
    mode,
    from,
    to,
    text: text || "",
    meta: meta || {}
  };
}

function parseEventsFromMessage(entry, currentAgent, fileKey) {
  if (!entry || entry.type !== "message" || !entry.message) return [];
  const msg = entry.message;
  const root = `${fileKey}:${entry.id || asEpochMs(entry.timestamp || msg.timestamp)}`;
  const ts = asEpochMs(entry.timestamp || msg.timestamp);
  const role = msg.role;
  const events = [];

  if (role === "assistant" && Array.isArray(msg.content)) {
    for (let i = 0; i < msg.content.length; i += 1) {
      const part = msg.content[i];
      if (!part) continue;
      if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
        events.push(
          makeEvent({
            id: `${root}:internal-thinking:${i}`,
            ts,
            mode: "internal",
            from: currentAgent,
            to: currentAgent,
            text: "【思考模块】\n生成中间推理（内容已省略）",
            meta: { stage: "thinking", internal: true, module: "思考模块" }
          })
        );
        continue;
      }

      if (part.type !== "toolCall") continue;
      const name = part.name;
      const args = part.arguments || {};

      if (name !== "sessions_spawn" && name !== "sessions_send") {
        events.push(
          makeEvent({
            id: `${root}:internal-call:${part.id || i}`,
            ts,
            mode: "internal",
            from: currentAgent,
            to: currentAgent,
            text: `【${name || "未知"}工具】\n调用: ${summarizeToolArgs(args)}`,
            meta: { stage: "call", tool: name || "unknown", internal: true, module: `${name || "未知"}工具` }
          })
        );
      }

      if (name === "sessions_spawn") {
        const target =
          normalizeAgent(args.agentId) ||
          normalizeAgent(parseAgentFromSessionKey(args.childSessionKey)) ||
          "unknown";
        const task = typeof args.task === "string" ? args.task.trim() : "";
        events.push(
          makeEvent({
            id: `${root}:spawn-call:${part.id || i}`,
            ts,
            mode: "spawn",
            from: currentAgent,
            to: target,
            text: task ? `派发任务: ${task}` : "派发子任务",
            meta: { stage: "call", tool: "sessions_spawn" }
          })
        );
      }

      if (name === "sessions_send") {
        const target =
          normalizeAgent(parseAgentFromSessionKey(args.sessionKey)) || "unknown";
        const body = typeof args.message === "string" ? args.message.trim() : "";
        events.push(
          makeEvent({
            id: `${root}:a2a-call:${part.id || i}`,
            ts,
            mode: "a2a",
            from: currentAgent,
            to: target,
            text: body || "A2A 消息",
            meta: { stage: "call", tool: "sessions_send" }
          })
        );
      }
    }

    if (currentAgent === "main") {
      const hasToolCall = msg.content.some((part) => part && part.type === "toolCall");
      const text = extractTextFromContent(msg.content);
      if (!hasToolCall && text) {
        events.push(
          makeEvent({
            id: `${root}:main-reply`,
            ts,
            mode: "user",
            from: "main",
            to: "user",
            text,
            meta: { stage: "reply", channel: "main-webchat" }
          })
        );
      }
    }
  }

  if (role === "toolResult" && msg.toolName === "sessions_spawn") {
    const details = msg.details || parseJsonFromToolResult(msg.content) || {};
    const target =
      normalizeAgent(parseAgentFromSessionKey(details.childSessionKey)) || "unknown";
    const status = details.status || "unknown";
    const note = details.note ? ` (${details.note})` : "";
    events.push(
      makeEvent({
        id: `${root}:spawn-result:${msg.toolCallId || "unknown"}`,
        ts,
        mode: "spawn",
        from: currentAgent,
        to: target,
        text: `接单状态: ${status}${note}`,
        meta: {
          stage: "result",
          tool: "sessions_spawn",
          status,
          runId: details.runId || ""
        }
      })
    );
  }

  if (role === "toolResult" && msg.toolName === "sessions_send") {
    const details = msg.details || parseJsonFromToolResult(msg.content) || {};
    const target =
      normalizeAgent(parseAgentFromSessionKey(details.sessionKey)) || "unknown";
    const status = details.status || "unknown";
    if (status !== "ok") {
      const body = details.error || `sessions_send status=${status}`;
      events.push(
        makeEvent({
          id: `${root}:a2a-result:${msg.toolCallId || "unknown"}`,
          ts,
          mode: "a2a",
          from: currentAgent,
          to: target,
          text: body,
          meta: { stage: "result", tool: "sessions_send", status }
        })
      );
    }
  }

  if (
    role === "toolResult" &&
    typeof msg.toolName === "string" &&
    msg.toolName !== "sessions_spawn" &&
    msg.toolName !== "sessions_send"
  ) {
    events.push(
      makeEvent({
        id: `${root}:internal-result:${msg.toolCallId || "unknown"}`,
        ts,
        mode: "internal",
        from: currentAgent,
        to: currentAgent,
        text: `【${msg.toolName}工具】\n结果: ${summarizeToolResult(msg)}`,
        meta: {
          stage: "result",
          tool: msg.toolName,
          internal: true,
          module: `${msg.toolName}工具`,
          isError: Boolean(msg.isError)
        }
      })
    );
  }

  if (role === "user") {
    const provenance = msg.provenance || {};
    const text = stripLeadingBracketTimestamp(extractTextFromContent(msg.content));
    const interSession = provenance.kind === "inter_session";

    if (interSession) {
      const sourceTool =
        typeof provenance.sourceTool === "string" ? provenance.sourceTool : "";
      const sourceMeta = extractSubagentSource(text, provenance);
      const spawnDelivery =
        sourceTool === "sessions_spawn" ||
        (!sourceTool && looksLikeSpawnCompletion(text));
      const mode = spawnDelivery ? "spawn" : "a2a";
      const source = sourceMeta.agent || (spawnDelivery ? "subagent" : "unknown");
      const body = spawnDelivery
        ? cleanupSpawnDeliveryText(text) || "子任务已完成并回传结果"
        : text || "A2A 投递消息";

      events.push(
        makeEvent({
          id: `${root}:${mode}-delivery`,
          ts,
          mode,
          from: source,
          to: currentAgent,
          text: body,
          meta: {
            stage: "delivery",
            sourceTool: sourceTool || (spawnDelivery ? "sessions_spawn" : "sessions_send"),
            sourceSessionKey: sourceMeta.sessionKey || "",
            sourceSessionId: sourceMeta.sessionId || ""
          }
        })
      );
    } else if (text) {
      const sourceMeta = extractSubagentSource(text, provenance);
      const spawnDelivery = looksLikeSpawnCompletion(text);
      const spawnSource = sourceMeta.agent || "subagent";

      if (spawnDelivery) {
        events.push(
          makeEvent({
            id: `${root}:spawn-delivery-fallback`,
            ts,
            mode: "spawn",
            from: spawnSource,
            to: currentAgent,
            text: cleanupSpawnDeliveryText(text) || "子任务已完成并回传结果",
            meta: {
              stage: "delivery",
              sourceTool: "sessions_spawn",
              sourceSessionKey: sourceMeta.sessionKey || "",
              sourceSessionId: sourceMeta.sessionId || ""
            }
          })
        );
      } else if (currentAgent === "main") {
        events.push(
          makeEvent({
            id: `${root}:user-main`,
            ts,
            mode: "user",
            from: "user",
            to: "main",
            text,
            meta: { stage: "prompt", channel: "webchat" }
          })
        );
      }
    }
  }

  const sessionStem = String(fileKey || "").replace(/\.jsonl$/i, "");
  const sessionRef = `agent:${currentAgent}:${sessionStem}`;
  return events.map((evt) => ({
    ...evt,
    meta: { ...(evt.meta || {}), sessionRef }
  }));
}

async function readChunk(file, offset, length) {
  const fd = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await fd.close();
  }
}

async function listSessionFiles() {
  const files = [];
  let agentDirs = [];
  try {
    agentDirs = await fsp.readdir(AGENTS_DIR, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) continue;
    const agentId = dirent.name;
    const sessionDir = path.join(AGENTS_DIR, agentId, "sessions");
    let entries = [];
    try {
      entries = await fsp.readdir(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.endsWith(".jsonl")) continue;
      if (name.includes(".deleted.") || name.includes(".reset.")) continue;
      sessionIdToAgent.set(name.replace(/\.jsonl$/i, ""), agentId);
      files.push({ file: path.join(sessionDir, name), agentId });
    }
  }

  return files;
}

async function consumeAllLines(file, agentId, fileKey) {
  let text = "";
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const collected = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const events = parseEventsFromMessage(parsed, agentId, fileKey);
    collected.push(...events);
  }
  return collected;
}

async function bootstrapHistory() {
  const sessionFiles = await listSessionFiles();
  const seedEvents = [];
  for (const { file, agentId } of sessionFiles) {
    const events = await consumeAllLines(file, agentId, path.basename(file));
    seedEvents.push(...events);
    try {
      const stat = await fsp.stat(file);
      trackedFiles.set(file, { agentId, offset: stat.size, remainder: "" });
    } catch {
      // File could disappear between readdir and stat.
    }
  }

  seedEvents.sort((a, b) => a.ts - b.ts);
  for (const event of seedEvents) emit(event, false);

  if (history.length > HISTORY_BOOTSTRAP_LIMIT) {
    history.splice(0, history.length - HISTORY_BOOTSTRAP_LIMIT);
  }
}

async function pollFile(file, state) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    trackedFiles.delete(file);
    return;
  }

  if (stat.size < state.offset) {
    state.offset = 0;
    state.remainder = "";
  }
  if (stat.size === state.offset) return;

  const sizeDelta = stat.size - state.offset;
  const chunk = await readChunk(file, state.offset, sizeDelta);
  state.offset = stat.size;

  const merged = state.remainder + chunk;
  const lines = merged.split(/\r?\n/);
  state.remainder = lines.pop() || "";
  const fileKey = path.basename(file);

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const events = parseEventsFromMessage(parsed, state.agentId, fileKey);
    for (const event of events) emit(event, true);
  }
}

async function discoverSessionFiles() {
  const listed = await listSessionFiles();
  const liveSet = new Set();

  for (const { file, agentId } of listed) {
    liveSet.add(file);
    if (!trackedFiles.has(file)) {
      trackedFiles.set(file, { agentId, offset: 0, remainder: "" });
      await pollFile(file, trackedFiles.get(file));
    } else {
      trackedFiles.get(file).agentId = agentId;
    }
  }

  for (const file of trackedFiles.keys()) {
    if (!liveSet.has(file)) trackedFiles.delete(file);
  }
}

async function pollAllTrackedFiles() {
  if (polling) return;
  polling = true;
  try {
    for (const [file, state] of trackedFiles.entries()) {
      await pollFile(file, state);
    }
  } finally {
    polling = false;
  }
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function serveIndex(res) {
  const stream = fs.createReadStream(INDEX_FILE);
  stream.on("error", () => {
    sendJson(res, 500, { error: "Failed to read index.html" });
  });
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  stream.pipe(res);
}

function handleHistory(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requested = Number(reqUrl.searchParams.get("limit") || 80);
  const limit = Math.max(1, Math.min(500, Number.isFinite(requested) ? requested : 80));
  const includeInternal = reqUrl.searchParams.get("includeInternal") === "1";
  const source = includeInternal ? history : history.filter((item) => item.mode !== "internal");
  const items = source.slice(-limit);
  sendJson(res, 200, { items, total: source.length, now: Date.now() });
}

function handleEvents(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const includeInternal = reqUrl.searchParams.get("includeInternal") === "1";
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.write("retry: 2500\n\n");
  const client = { res, includeInternal };
  clients.add(client);

  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch {
      // Ignore heartbeat write errors; close handler cleans up.
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

async function main() {
  await bootstrapHistory();
  await discoverSessionFiles();

  setInterval(() => {
    void discoverSessionFiles().catch((err) => {
      console.error("[discover] error:", err && err.message ? err.message : err);
    });
  }, DISCOVER_MS);

  setInterval(() => {
    void pollAllTrackedFiles().catch((err) => {
      console.error("[poll] error:", err && err.message ? err.message : err);
    });
  }, POLL_MS);

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = reqUrl.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      serveIndex(res);
      return;
    }

    if (pathname === "/api/history") {
      handleHistory(req, res);
      return;
    }

    if (pathname === "/api/events") {
      handleEvents(req, res);
      return;
    }

    if (pathname === "/healthz") {
      sendJson(res, 200, { ok: true, clients: clients.size, events: history.length });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[openclaw-live-dashboard] listening on http://${HOST}:${PORT}`);
    console.log(`[openclaw-live-dashboard] watching ${AGENTS_DIR}`);
  });
}

main().catch((err) => {
  console.error("[openclaw-live-dashboard] fatal:", err);
  process.exitCode = 1;
});
