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
const DIST_DIR = path.join(CANVAS_DIR, "dist");
const LEGACY_INDEX_FILE = path.join(CANVAS_DIR, "index.html");
const OPENCLAW_HOME =
  process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const AGENTS_DIR =
  process.env.OPENCLAW_AGENTS_DIR || path.join(OPENCLAW_HOME, "agents");

const HISTORY_LIMIT = 2400;
const HISTORY_BOOTSTRAP_LIMIT = 1200;
const POLL_MS = 1000;
const DISCOVER_MS = 4000;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const STALLED_WINDOW_MS = 10 * 60 * 1000;

const KNOWN_AGENTS = new Set(["main", "bob", "trash_agent", "wali_agent"]);
const TERMINAL_REPLY_STAGE = "reply";
const NOISE_AGENT_IDS = new Set(["user", "unknown", "subagent"]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const clients = new Set();
const trackedFiles = new Map();
const sessionIdToAgent = new Map();
let polling = false;

function asEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatDayKey(ts) {
  const date = new Date(asEpochMs(ts));
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeAgent(agentId) {
  if (!agentId || typeof agentId !== "string") return null;
  return KNOWN_AGENTS.has(agentId) ? agentId : agentId.trim() || null;
}

function parseAgentFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match ? normalizeAgent(match[1]) : null;
}

function normalizeSessionRef(sessionKey, fallbackAgent) {
  if (typeof sessionKey === "string") {
    const clean = sessionKey.trim();
    const direct = /^agent:([^:]+):(.+)$/.exec(clean);
    if (direct) {
      const agent = normalizeAgent(direct[1]) || direct[1];
      return `agent:${agent}:${direct[2]}`;
    }

    if (/^[0-9a-f-]{36}$/i.test(clean)) {
      const agent =
        normalizeAgent(fallbackAgent) ||
        normalizeAgent(sessionIdToAgent.get(clean)) ||
        "unknown";
      return `agent:${agent}:${clean}`;
    }
  }

  return "";
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

function summarizePromptTitle(text) {
  let clean = String(text || "").trim();
  if (!clean) return "用户发起执行";

  clean = clean.replace(/^Sender \(untrusted metadata\):[\s\S]*?```\s*/i, "").trim();
  clean = clean.replace(/^\[\[[^\]]+\]\]\s*/g, "").trim();
  clean = clean.replace(/^OpenClaw runtime context \(internal\):\s*/i, "").trim();
  clean = clean.replace(/^This context is runtime-generated[^\n]*\n*/i, "").trim();

  const lines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^```/.test(line) && !/^\{[\s\S]*\}$/.test(line));

  const candidate =
    lines.find((line) => line.length >= 8 && !/^[-*#>`"{\[]/.test(line)) ||
    lines[lines.length - 1] ||
    clean;

  return truncateText(candidate, 84) || "用户发起执行";
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

function extractSubagentSource(text, provenance) {
  const sourceSessionKey =
    provenance && typeof provenance.sourceSessionKey === "string"
      ? provenance.sourceSessionKey.trim()
      : "";
  const fromProvenance = normalizeAgent(parseAgentFromSessionKey(sourceSessionKey));
  if (fromProvenance) {
    return {
      agent: fromProvenance,
      sessionKey: sourceSessionKey,
      sessionId: "",
      sessionRef: normalizeSessionRef(sourceSessionKey, fromProvenance)
    };
  }

  const sessionKey = parseSessionKeyFromText(text);
  const fromSessionKey = normalizeAgent(parseAgentFromSessionKey(sessionKey));
  if (fromSessionKey) {
    return {
      agent: fromSessionKey,
      sessionKey: sessionKey || "",
      sessionId: "",
      sessionRef: normalizeSessionRef(sessionKey, fromSessionKey)
    };
  }

  const sessionId = parseSessionIdFromText(text);
  const fromSessionId = resolveAgentFromSessionId(sessionId);
  if (fromSessionId) {
    return {
      agent: fromSessionId,
      sessionKey: "",
      sessionId: sessionId || "",
      sessionRef: normalizeSessionRef(sessionId, fromSessionId)
    };
  }

  return {
    agent: null,
    sessionKey: sessionKey || sourceSessionKey || "",
    sessionId: sessionId || "",
    sessionRef: normalizeSessionRef(sessionKey || sourceSessionKey || sessionId || "", "")
  };
}

function deriveSeverity({ mode, stage, status, isError, text }) {
  if (mode === "internal" && stage === "thinking") return "trace";
  if (mode === "internal" && stage === "call") return "info";
  if (mode === "internal" && stage === "result" && !isError) return "info";
  if (isError) return "error";
  const statusText = String(status || "").toLowerCase();
  if (statusText && !["ok", "call", "result", "delivery", "prompt", "reply"].includes(statusText)) {
    return "warn";
  }
  if (mode !== "internal" && /error|failed|exception|denied|timeout/i.test(String(text || ""))) {
    return "warn";
  }
  return "info";
}

function withSessionContext(event, sessionRef, sessionAgent) {
  const meta = { ...(event.meta || {}) };
  meta.sessionRef = sessionRef || meta.sessionRef || "";
  meta.sessionAgent = sessionAgent || meta.sessionAgent || "";

  const relatedSessionRef = normalizeSessionRef(
    meta.relatedSessionRef || meta.childSessionKey || meta.sessionKey || meta.sourceSessionKey || "",
    meta.relatedAgent || meta.sourceAgent || ""
  );
  if (relatedSessionRef) meta.relatedSessionRef = relatedSessionRef;

  const tool =
    typeof meta.tool === "string" && meta.tool.trim()
      ? meta.tool.trim()
      : typeof meta.sourceTool === "string" && meta.sourceTool.trim()
        ? meta.sourceTool.trim()
        : "";
  const stage = typeof meta.stage === "string" ? meta.stage.trim() : "";
  const status =
    typeof meta.status === "string" && meta.status.trim()
      ? meta.status.trim()
      : stage
        ? stage
        : "";
  const isError =
    Boolean(meta.isError) ||
    /^error|failed|denied|timeout$/i.test(status) ||
    /error|failed|exception/i.test(String(event.text || ""));
  const severity = deriveSeverity({
    mode: event.mode,
    stage,
    status,
    isError,
    text: event.text
  });

  return {
    ...event,
    meta,
    sessionRef: meta.sessionRef,
    sessionAgent: meta.sessionAgent,
    tool,
    stage,
    status,
    severity,
    isError,
    relatedSessionRef,
    groupId: ""
  };
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

function createExecutionTracker() {
  const sessionGroupMap = new Map();
  const groupMetaMap = new Map();
  let runSeq = 0;

  function nextRunGroupId(ts) {
    runSeq += 1;
    return `run-${asEpochMs(ts)}-${String(runSeq).padStart(4, "0")}`;
  }

  function ensureGroupMeta(groupId, defaults) {
    if (!groupMetaMap.has(groupId)) {
      groupMetaMap.set(groupId, {
        groupId,
        title: "",
        rootSessionRef: "",
        createdAt: defaults && defaults.createdAt ? defaults.createdAt : Date.now(),
        rootEventId: defaults && defaults.rootEventId ? defaults.rootEventId : "",
        kind: groupId.startsWith("orphan:") ? "orphan" : "run"
      });
    }
    const meta = groupMetaMap.get(groupId);
    if (defaults && defaults.title && !meta.title) meta.title = defaults.title;
    if (defaults && defaults.rootSessionRef && !meta.rootSessionRef) {
      meta.rootSessionRef = defaults.rootSessionRef;
    }
    if (defaults && defaults.rootEventId && !meta.rootEventId) {
      meta.rootEventId = defaults.rootEventId;
    }
    return meta;
  }

  function inferTitle(event) {
    if (event.from === "user" && event.to === "main") {
      return summarizePromptTitle(event.text);
    }
    if (event.groupId && groupMetaMap.has(event.groupId)) {
      const meta = groupMetaMap.get(event.groupId);
      if (meta.title) return meta.title;
    }
    if (event.sessionAgent) {
      return `${event.sessionAgent} 会话`;
    }
    return truncateText(event.text, 64) || "未命名执行";
  }

  function assignEvent(event) {
    const sessionRef = event.sessionRef || "";
    const relatedSessionRef = event.relatedSessionRef || "";
    const isRootPrompt =
      event.mode === "user" &&
      event.from === "user" &&
      event.to === "main" &&
      event.stage === "prompt";

    let groupId = "";

    if (isRootPrompt) {
      groupId = nextRunGroupId(event.ts);
      ensureGroupMeta(groupId, {
        title: summarizePromptTitle(event.text),
        rootSessionRef: sessionRef,
        rootEventId: event.id,
        createdAt: event.ts
      });
      if (sessionRef) sessionGroupMap.set(sessionRef, groupId);
    }

    if (!groupId && sessionRef && sessionGroupMap.has(sessionRef)) {
      groupId = sessionGroupMap.get(sessionRef);
    }

    if (!groupId && relatedSessionRef && sessionGroupMap.has(relatedSessionRef)) {
      groupId = sessionGroupMap.get(relatedSessionRef);
    }

    if (!groupId && sessionRef && event.sessionAgent === "main") {
      const mainGroup = sessionGroupMap.get(sessionRef);
      if (mainGroup) groupId = mainGroup;
    }

    if (!groupId) {
      const orphanSeed = sessionRef || relatedSessionRef || `${event.from || "unknown"}:${event.to || "unknown"}`;
      groupId = `orphan:${orphanSeed}`;
      ensureGroupMeta(groupId, {
        title: inferTitle(event),
        rootSessionRef: sessionRef,
        rootEventId: event.id,
        createdAt: event.ts
      });
    }

    const meta = ensureGroupMeta(groupId, {
      title: inferTitle(event),
      rootSessionRef: sessionRef,
      rootEventId: event.id,
      createdAt: event.ts
    });

    if (sessionRef && (!sessionGroupMap.has(sessionRef) || !groupId.startsWith("orphan:"))) {
      sessionGroupMap.set(sessionRef, groupId);
    }

    if (relatedSessionRef && !groupId.startsWith("orphan:")) {
      sessionGroupMap.set(relatedSessionRef, groupId);
    }

    const stampedMeta = {
      ...(event.meta || {}),
      groupId,
      sessionRef: sessionRef || meta.rootSessionRef || "",
      sessionAgent: event.sessionAgent || ""
    };

    return {
      ...event,
      groupId,
      meta: stampedMeta
    };
  }

  return {
    assignEvent,
    groupMetaMap
  };
}

function createHistoryStore() {
  const tracker = createExecutionTracker();
  const history = [];
  const seenEventIds = new Set();
  let sequence = 0;
  let cache = null;
  let dirty = true;

  function pushHistory(event) {
    history.push(event);
    if (history.length > HISTORY_LIMIT) {
      history.splice(0, history.length - HISTORY_LIMIT);
    }
  }

  function emit(rawEvent) {
    if (!rawEvent || !rawEvent.id) return null;
    if (seenEventIds.has(rawEvent.id)) return null;
    seenEventIds.add(rawEvent.id);
    const event = tracker.assignEvent(rawEvent);
    const stamped = { ...event, seq: ++sequence };
    pushHistory(stamped);
    dirty = true;
    return stamped;
  }

  function listHistory() {
    return history;
  }

  function getGroupMeta(groupId) {
    return tracker.groupMetaMap.get(groupId) || null;
  }

  function makeIssue(groupId, event, severity, label, message) {
    return {
      id: `${groupId}:${event.id}:${label}`,
      groupId,
      eventId: event.id,
      sessionRef: event.sessionRef || "",
      agentId: event.sessionAgent || event.from || "",
      ts: event.ts,
      severity,
      label,
      message: truncateText(message, 180)
    };
  }

  function isWaitingLikeEvent(event) {
    if (!event) return false;
    if (event.mode === "spawn" || event.mode === "a2a") {
      return event.stage === "call" || event.stage === "delivery" || event.status === "call";
    }
    return /等待|待处理|pending|running|dispatch/i.test(String(event.text || ""));
  }

  function buildDerivedData() {
    const groups = new Map();
    const agentStats = new Map();
    const now = Date.now();

    for (const event of history) {
      const groupId = event.groupId || `orphan:${event.sessionRef || event.id}`;
      const meta = getGroupMeta(groupId);

      if (!groups.has(groupId)) {
        groups.set(groupId, {
          groupId,
          title: meta && meta.title ? meta.title : truncateText(event.text, 84) || "未命名执行",
          startedAt: event.ts,
          lastEventAt: event.ts,
          latestEvent: null,
          latestExternalEvent: null,
          completedAt: 0,
          eventCounts: {
            total: 0,
            user: 0,
            spawn: 0,
            a2a: 0,
            internal: 0
          },
          errorCount: 0,
          activeAgentsSet: new Set(),
          sessionsMap: new Map(),
          issues: [],
          issueIds: new Set(),
          rootSessionRef: meta && meta.rootSessionRef ? meta.rootSessionRef : "",
          waitingLike: false,
          dayKeysSet: new Set()
        });
      }

      const group = groups.get(groupId);
      group.startedAt = Math.min(group.startedAt, event.ts);
      group.lastEventAt = Math.max(group.lastEventAt, event.ts);
      group.dayKeysSet.add(formatDayKey(event.ts));
      group.eventCounts.total += 1;
      group.eventCounts[event.mode] = (group.eventCounts[event.mode] || 0) + 1;

      if (!group.latestEvent || event.seq >= group.latestEvent.seq) {
        group.latestEvent = event;
      }
      if (event.mode !== "internal") {
        group.latestExternalEvent = event;
      }

      if (
        event.from === "main" &&
        event.to === "user" &&
        event.mode === "user" &&
        event.stage === TERMINAL_REPLY_STAGE
      ) {
        group.completedAt = Math.max(group.completedAt, event.ts);
      }

      if (event.isError || event.severity === "error") {
        group.errorCount += 1;
      }

      if (isWaitingLikeEvent(event)) {
        group.waitingLike = true;
      }

      const sessionRef = event.sessionRef || "session:unknown";
      if (!group.sessionsMap.has(sessionRef)) {
        group.sessionsMap.set(sessionRef, {
          sessionRef,
          agentId: event.sessionAgent || parseAgentFromSessionKey(sessionRef) || "unknown",
          lastEventAt: event.ts,
          startedAt: event.ts,
          eventCount: 0,
          counts: {
            total: 0,
            user: 0,
            spawn: 0,
            a2a: 0,
            internal: 0
          },
          latestMode: event.mode,
          latestText: truncateText(event.text, 120),
          latestSeverity: event.severity
        });
      }
      const session = group.sessionsMap.get(sessionRef);
      session.lastEventAt = Math.max(session.lastEventAt, event.ts);
      session.startedAt = Math.min(session.startedAt, event.ts);
      session.eventCount += 1;
      session.counts.total += 1;
      session.counts[event.mode] = (session.counts[event.mode] || 0) + 1;
      session.latestMode = event.mode;
      session.latestText = truncateText(event.text, 120);
      session.latestSeverity = event.severity;

      const candidateAgents = [event.sessionAgent, event.from, event.to];
      for (const agentId of candidateAgents) {
        if (!agentId || NOISE_AGENT_IDS.has(agentId)) continue;
        group.activeAgentsSet.add(agentId);

        if (!agentStats.has(agentId)) {
          agentStats.set(agentId, {
            agentId,
            lastEventAt: 0,
            activeExecutionIds: new Set(),
            totalEvents: 0,
            latestEvent: null
          });
        }
        const stats = agentStats.get(agentId);
        stats.lastEventAt = Math.max(stats.lastEventAt, event.ts);
        stats.totalEvents += 1;
        stats.activeExecutionIds.add(groupId);
        if (!stats.latestEvent || event.seq >= stats.latestEvent.seq) {
          stats.latestEvent = event;
        }
      }

      if ((event.isError || event.severity === "warn") && !group.issueIds.has(event.id)) {
        const label =
          event.isError
            ? "工具错误"
            : event.mode === "spawn" || event.mode === "a2a"
              ? "协作警告"
              : "运行告警";
        group.issueIds.add(event.id);
        group.issues.push(makeIssue(groupId, event, event.severity, label, event.text || label));
      }
    }

    const recentIssues = [];
    const executionMap = new Map();
    const executionItems = Array.from(groups.values())
      .map((group) => {
        let status = "quiet";
        const latestSignificant = group.latestExternalEvent || group.latestEvent;
        const age = now - group.lastEventAt;

        if (group.groupId.startsWith("orphan:")) {
          status = "orphan";
          group.issues.push({
            id: `${group.groupId}:orphan`,
            groupId: group.groupId,
            eventId: "",
            sessionRef: group.rootSessionRef || "",
            agentId: "",
            ts: group.lastEventAt,
            severity: "warn",
            label: "孤立会话",
            message: "未能关联到用户发起的主执行，会话仍被保留供排障。"
          });
        } else if (
          latestSignificant &&
          latestSignificant.from === "main" &&
          latestSignificant.to === "user" &&
          latestSignificant.stage === TERMINAL_REPLY_STAGE
        ) {
          status = "completed";
        } else if (age <= ACTIVE_WINDOW_MS) {
          status = "active";
        } else if (group.waitingLike && age >= STALLED_WINDOW_MS) {
          status = "stalled";
          group.issues.push({
            id: `${group.groupId}:stalled`,
            groupId: group.groupId,
            eventId: latestSignificant ? latestSignificant.id : "",
            sessionRef: group.rootSessionRef || "",
            agentId: latestSignificant ? latestSignificant.sessionAgent || latestSignificant.to || "" : "",
            ts: group.lastEventAt,
            severity: "warn",
            label: "疑似停滞",
            message: "最近 10 分钟未见新的关键进展，最后关键事件仍处于派发或等待态。"
          });
        }

        const sessions = Array.from(group.sessionsMap.values())
          .map((item) => {
            const sessionAge = now - item.lastEventAt;
            let health = "quiet";
            if (item.latestSeverity === "error") health = "error";
            else if (sessionAge <= ACTIVE_WINDOW_MS) health = "active";
            else if (sessionAge >= STALLED_WINDOW_MS) health = "quiet";
            return {
              ...item,
              health
            };
          })
          .sort((a, b) => b.lastEventAt - a.lastEventAt);

        const issues = group.issues
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 6);
        for (const issue of issues) {
          recentIssues.push(issue);
        }

        const summary = {
          groupId: group.groupId,
          title: group.title,
          status,
          startedAt: group.startedAt,
          lastEventAt: group.lastEventAt,
          activeAgents: Array.from(group.activeAgentsSet).sort(),
          eventCounts: group.eventCounts,
          errorCount: group.errorCount,
          sessions,
          latestEvent: group.latestEvent
            ? {
                id: group.latestEvent.id,
                ts: group.latestEvent.ts,
                seq: group.latestEvent.seq,
                from: group.latestEvent.from,
                to: group.latestEvent.to,
                mode: group.latestEvent.mode,
                stage: group.latestEvent.stage,
                severity: group.latestEvent.severity,
                text: truncateText(group.latestEvent.text, 140)
              }
            : null,
          issues
        };

        executionMap.set(summary.groupId, {
          summary,
          sessions,
          issues,
          filters: {
            agents: summary.activeAgents,
            modes: Object.keys(summary.eventCounts).filter(
              (mode) => mode !== "total" && summary.eventCounts[mode] > 0
            ),
            sessionRefs: sessions.map((item) => item.sessionRef),
            sessionDays: Array.from(group.dayKeysSet).sort((a, b) => b.localeCompare(a))
          },
          defaultHistoryWindow: {
            beforeSeq: null,
            limit: 240
          }
        });

        return summary;
      })
      .sort((a, b) => b.lastEventAt - a.lastEventAt);

    recentIssues.sort((a, b) => b.ts - a.ts);

    const statusCounts = {
      active: 0,
      quiet: 0,
      stalled: 0,
      completed: 0,
      orphan: 0
    };

    for (const item of executionItems) {
      statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
    }

    const agentActivity = Array.from(agentStats.values())
      .map((item) => {
        const age = now - item.lastEventAt;
        let health = "quiet";
        let label = "静默";
        if (item.latestEvent && item.latestEvent.severity === "error") {
          health = "error";
          label = "异常";
        } else if (age <= ACTIVE_WINDOW_MS) {
          health = "active";
          label = "活跃";
        } else if (age >= STALLED_WINDOW_MS) {
          health = "quiet";
          label = "静默";
        }

        return {
          agentId: item.agentId,
          lastEventAt: item.lastEventAt,
          activeExecutionCount: item.activeExecutionIds.size,
          totalEvents: item.totalEvents,
          latestEvent: item.latestEvent
            ? {
                id: item.latestEvent.id,
                groupId: item.latestEvent.groupId,
                ts: item.latestEvent.ts,
                mode: item.latestEvent.mode,
                severity: item.latestEvent.severity,
                text: truncateText(item.latestEvent.text, 120)
              }
            : null,
          health,
          healthLabel: label
        };
      })
      .sort((a, b) => b.lastEventAt - a.lastEventAt);

    const kpis = [
      {
        key: "executions",
        label: "执行分组",
        value: executionItems.length,
        tone: "neutral"
      },
      {
        key: "active",
        label: "活跃执行",
        value: statusCounts.active,
        tone: "good"
      },
      {
        key: "stalled",
        label: "疑似停滞",
        value: statusCounts.stalled,
        tone: statusCounts.stalled > 0 ? "warn" : "neutral"
      },
      {
        key: "agents",
        label: "活跃 Agent",
        value: agentActivity.filter((item) => item.health === "active").length,
        tone: "neutral"
      },
      {
        key: "issues",
        label: "近期问题",
        value: recentIssues.length,
        tone: recentIssues.length > 0 ? "warn" : "neutral"
      }
    ];

    const highlightExecution =
      executionItems.find((item) => item.status === "stalled") ||
      executionItems.find((item) => item.errorCount > 0) ||
      executionItems.find((item) => item.status === "active") ||
      executionItems[0] ||
      null;

    return {
      executions: executionItems,
      executionMap,
      overview: {
        generatedAt: now,
        kpis,
        statusCounts,
        agentActivity: agentActivity.slice(0, 8),
        recentIssues: recentIssues.slice(0, 8),
        highlightExecutionId: highlightExecution ? highlightExecution.groupId : ""
      }
    };
  }

  function getDerivedData() {
    if (!dirty && cache) return cache;
    cache = buildDerivedData();
    dirty = false;
    return cache;
  }

  function queryHistory(query) {
    const includeInternal = query.includeInternal === true;
    const limitNum = Number(query.limit || 80);
    const limit = clamp(Number.isFinite(limitNum) ? limitNum : 80, 1, 500);
    const beforeSeq = Number(query.beforeSeq || 0);

    let items = includeInternal
      ? history.slice()
      : history.filter((item) => item.mode !== "internal");

    if (Number.isFinite(beforeSeq) && beforeSeq > 0) {
      items = items.filter((item) => item.seq < beforeSeq);
    }
    if (query.groupId) {
      items = items.filter((item) => item.groupId === query.groupId);
    }
    if (query.sessionRef) {
      items = items.filter((item) => item.sessionRef === query.sessionRef);
    }
    if (query.day) {
      items = items.filter((item) => formatDayKey(item.ts) === query.day);
    }
    if (query.agentId) {
      items = items.filter(
        (item) =>
          item.sessionAgent === query.agentId ||
          item.from === query.agentId ||
          item.to === query.agentId
      );
    }
    if (query.mode) {
      items = items.filter((item) => item.mode === query.mode);
    }
    if (query.q) {
      const needle = String(query.q).trim().toLowerCase();
      if (needle) {
        items = items.filter((item) => {
          const haystack = [
            item.text,
            item.from,
            item.to,
            item.mode,
            item.stage,
            item.tool,
            item.sessionRef,
            item.groupId
          ]
            .filter(Boolean)
            .join("\n")
            .toLowerCase();
          return haystack.includes(needle);
        });
      }
    }

    const total = items.length;
    items = items.slice(-limit);
    return {
      items,
      total,
      now: Date.now()
    };
  }

  function queryExecutions(query) {
    const data = getDerivedData();
    let items = data.executions.slice();
    const limitNum = Number(query.limit || 60);
    const limit = clamp(Number.isFinite(limitNum) ? limitNum : 60, 1, 200);

    if (query.status) {
      items = items.filter((item) => item.status === query.status);
    }
    if (query.agent) {
      items = items.filter((item) => item.activeAgents.includes(query.agent));
    }
    if (query.q) {
      const needle = String(query.q).trim().toLowerCase();
      if (needle) {
        items = items.filter((item) => {
          const haystack = [
            item.title,
            item.latestEvent ? item.latestEvent.text : "",
            item.activeAgents.join(" "),
            item.issues.map((issue) => issue.message).join(" ")
          ]
            .join("\n")
            .toLowerCase();
          return haystack.includes(needle);
        });
      }
    }

    return {
      items: items.slice(0, limit),
      total: items.length,
      now: Date.now()
    };
  }

  function getExecutionDetail(groupId) {
    const data = getDerivedData();
    return data.executionMap.get(groupId) || null;
  }

  function getOverview() {
    return getDerivedData().overview;
  }

  function trimBootstrapHistory() {
    if (history.length > HISTORY_BOOTSTRAP_LIMIT) {
      history.splice(0, history.length - HISTORY_BOOTSTRAP_LIMIT);
      dirty = true;
    }
  }

  return {
    emit,
    listHistory,
    queryHistory,
    queryExecutions,
    getExecutionDetail,
    getOverview,
    trimBootstrapHistory
  };
}

const store = createHistoryStore();

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
            meta: {
              stage: "call",
              tool: name || "unknown",
              internal: true,
              module: `${name || "未知"}工具`,
              status: "call"
            }
          })
        );
      }

      if (name === "sessions_spawn") {
        const target =
          normalizeAgent(args.agentId) ||
          normalizeAgent(parseAgentFromSessionKey(args.childSessionKey)) ||
          "unknown";
        const task = typeof args.task === "string" ? args.task.trim() : "";
        const relatedSessionRef = normalizeSessionRef(args.childSessionKey, target);
        events.push(
          makeEvent({
            id: `${root}:spawn-call:${part.id || i}`,
            ts,
            mode: "spawn",
            from: currentAgent,
            to: target,
            text: task ? `派发任务: ${task}` : "派发子任务",
            meta: {
              stage: "call",
              tool: "sessions_spawn",
              status: "call",
              childSessionKey: args.childSessionKey || "",
              relatedSessionRef
            }
          })
        );
      }

      if (name === "sessions_send") {
        const target =
          normalizeAgent(parseAgentFromSessionKey(args.sessionKey)) || "unknown";
        const body = typeof args.message === "string" ? args.message.trim() : "";
        const relatedSessionRef = normalizeSessionRef(args.sessionKey, target);
        events.push(
          makeEvent({
            id: `${root}:a2a-call:${part.id || i}`,
            ts,
            mode: "a2a",
            from: currentAgent,
            to: target,
            text: body || "A2A 消息",
            meta: {
              stage: "call",
              tool: "sessions_send",
              status: "call",
              sessionKey: args.sessionKey || "",
              relatedSessionRef
            }
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
            meta: { stage: "reply", channel: "main-webchat", status: "reply" }
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
    const relatedSessionRef = normalizeSessionRef(details.childSessionKey, target);
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
          runId: details.runId || "",
          childSessionKey: details.childSessionKey || "",
          relatedSessionRef
        }
      })
    );
  }

  if (role === "toolResult" && msg.toolName === "sessions_send") {
    const details = msg.details || parseJsonFromToolResult(msg.content) || {};
    const target =
      normalizeAgent(parseAgentFromSessionKey(details.sessionKey)) || "unknown";
    const status = details.status || "unknown";
    const relatedSessionRef = normalizeSessionRef(details.sessionKey, target);
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
          meta: {
            stage: "result",
            tool: "sessions_send",
            status,
            relatedSessionRef
          }
        })
      );
    } else {
      events.push(
        makeEvent({
          id: `${root}:a2a-result:${msg.toolCallId || "unknown"}`,
          ts,
          mode: "a2a",
          from: currentAgent,
          to: target,
          text: "消息投递成功",
          meta: {
            stage: "result",
            tool: "sessions_send",
            status,
            relatedSessionRef
          }
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
          isError: Boolean(msg.isError),
          status: msg.isError ? "error" : "ok"
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
        sourceTool === "sessions_spawn" || (!sourceTool && looksLikeSpawnCompletion(text));
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
            sourceSessionId: sourceMeta.sessionId || "",
            relatedSessionRef: sourceMeta.sessionRef || "",
            status: "delivery"
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
              sourceSessionId: sourceMeta.sessionId || "",
              relatedSessionRef: sourceMeta.sessionRef || "",
              status: "delivery"
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
            meta: { stage: "prompt", channel: "webchat", status: "prompt" }
          })
        );
      }
    }
  }

  const sessionStem = String(fileKey || "").replace(/\.jsonl$/i, "");
  const sessionRef = `agent:${currentAgent}:${sessionStem}`;
  return events.map((event) => withSessionContext(event, sessionRef, currentAgent));
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
  for (const event of seedEvents) store.emit(event);
  store.trimBootstrapHistory();
}

function broadcastEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    if (event.mode === "internal" && !client.includeInternal) continue;
    try {
      client.res.write(payload);
    } catch {
      // Best effort write; dead client cleanup is handled on close.
    }
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
    for (const event of events) {
      const stamped = store.emit(event);
      if (stamped) broadcastEvent(stamped);
    }
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

function sendNotFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function streamFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME_TYPES[ext] || "application/octet-stream";
  const stream = fs.createReadStream(file);
  stream.on("error", () => {
    sendJson(res, 500, { error: `Failed to read ${path.basename(file)}` });
  });
  res.writeHead(200, {
    "content-type": type,
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable"
  });
  stream.pipe(res);
}

function resolveStaticFile(pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(DIST_DIR, safePath);
  if (!target.startsWith(DIST_DIR)) return "";
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  return "";
}

function serveApp(req, res, pathname) {
  if (pathname !== "/" && fs.existsSync(DIST_DIR)) {
    const assetFile = resolveStaticFile(pathname);
    if (assetFile) {
      streamFile(res, assetFile);
      return;
    }
  }

  if (fs.existsSync(LEGACY_INDEX_FILE)) {
    streamFile(res, LEGACY_INDEX_FILE);
    return;
  }

  if (fs.existsSync(DIST_DIR)) {
    const distIndex = path.join(DIST_DIR, "index.html");
    if (fs.existsSync(distIndex)) {
      streamFile(res, distIndex);
      return;
    }
  }

  sendJson(res, 500, { error: "Dashboard frontend is missing" });
}

function parseBooleanFlag(value) {
  return value === "1" || value === "true";
}

function handleHistory(storeRef, req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const payload = storeRef.queryHistory({
    includeInternal: parseBooleanFlag(reqUrl.searchParams.get("includeInternal")),
    groupId: reqUrl.searchParams.get("groupId") || "",
    sessionRef: reqUrl.searchParams.get("sessionRef") || "",
    day: reqUrl.searchParams.get("day") || "",
    agentId: reqUrl.searchParams.get("agentId") || "",
    mode: reqUrl.searchParams.get("mode") || "",
    q: reqUrl.searchParams.get("q") || "",
    beforeSeq: reqUrl.searchParams.get("beforeSeq") || "",
    limit: reqUrl.searchParams.get("limit") || ""
  });
  sendJson(res, 200, payload);
}

function handleOverview(storeRef, res) {
  sendJson(res, 200, storeRef.getOverview());
}

function handleExecutions(storeRef, req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const payload = storeRef.queryExecutions({
    status: reqUrl.searchParams.get("status") || "",
    agent: reqUrl.searchParams.get("agent") || "",
    q: reqUrl.searchParams.get("q") || "",
    limit: reqUrl.searchParams.get("limit") || ""
  });
  sendJson(res, 200, payload);
}

function handleExecutionDetail(storeRef, res, groupId) {
  const detail = storeRef.getExecutionDetail(groupId);
  if (!detail) {
    sendJson(res, 404, { error: `Execution not found: ${groupId}` });
    return;
  }
  sendJson(res, 200, detail);
}

function handleEvents(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const includeInternal = parseBooleanFlag(reqUrl.searchParams.get("includeInternal"));
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

function handleHealthz(storeRef, res) {
  sendJson(res, 200, {
    ok: true,
    clients: clients.size,
    events: storeRef.listHistory().length,
    dist: fs.existsSync(path.join(DIST_DIR, "index.html"))
  });
}

function createRequestHandler(storeRef = store) {
  return (req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = reqUrl.pathname;

    if (pathname === "/api/history") {
      handleHistory(storeRef, req, res);
      return;
    }
    if (pathname === "/api/events") {
      handleEvents(req, res);
      return;
    }
    if (pathname === "/api/overview") {
      handleOverview(storeRef, res);
      return;
    }
    if (pathname === "/api/executions") {
      handleExecutions(storeRef, req, res);
      return;
    }
    if (pathname.startsWith("/api/executions/")) {
      const groupId = decodeURIComponent(pathname.slice("/api/executions/".length));
      handleExecutionDetail(storeRef, res, groupId);
      return;
    }
    if (pathname === "/healthz") {
      handleHealthz(storeRef, res);
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendNotFound(res);
      return;
    }

    serveApp(req, res, pathname);
  };
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

  const server = http.createServer(createRequestHandler());
  server.listen(PORT, HOST, () => {
    console.log(`[openclaw-live-dashboard] listening on http://${HOST}:${PORT}`);
    console.log(`[openclaw-live-dashboard] watching ${AGENTS_DIR}`);
  });
}

module.exports = {
  ACTIVE_WINDOW_MS,
  STALLED_WINDOW_MS,
  createExecutionTracker,
  createHistoryStore,
  createRequestHandler,
  normalizeSessionRef,
  parseEventsFromMessage,
  withSessionContext
};

if (require.main === module) {
  main().catch((err) => {
    console.error("[openclaw-live-dashboard] fatal:", err);
    process.exitCode = 1;
  });
}
