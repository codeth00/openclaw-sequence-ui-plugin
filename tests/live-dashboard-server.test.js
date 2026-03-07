"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  createHistoryStore,
  createRequestHandler,
  parseEventsFromMessage
} = require("../dashboard/live-dashboard-server.js");

function makeEntry(timestamp, message, id) {
  return {
    type: "message",
    id,
    timestamp,
    message
  };
}

function seedStore() {
  const store = createHistoryStore();
  const mainSession = "11111111-1111-1111-1111-111111111111.jsonl";
  const childSession = "22222222-2222-2222-2222-222222222222.jsonl";
  const orphanSession = "33333333-3333-3333-3333-333333333333.jsonl";

  const seed = [
    {
      agent: "main",
      file: mainSession,
      entry: makeEntry(
        "2026-03-05T08:00:00.000Z",
        {
          role: "user",
          content: [{ type: "text", text: "请整理今天的发布风险" }]
        },
        "root-prompt"
      )
    },
    {
      agent: "main",
      file: mainSession,
      entry: makeEntry(
        "2026-03-06T08:00:01.000Z",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "spawn-1",
              name: "sessions_spawn",
              arguments: {
                agentId: "bob",
                childSessionKey: "agent:bob:22222222-2222-2222-2222-222222222222",
                task: "审查发布风险"
              }
            }
          ]
        },
        "spawn-call"
      )
    },
    {
      agent: "bob",
      file: childSession,
      entry: makeEntry(
        "2026-03-06T08:00:02.000Z",
        {
          role: "user",
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_spawn",
            sourceSessionKey: "agent:main:11111111-1111-1111-1111-111111111111"
          },
          content: [{ type: "text", text: "请审查今天发布的主要风险点" }]
        },
        "child-delivery"
      )
    },
    {
      agent: "bob",
      file: childSession,
      entry: makeEntry(
        "2026-03-06T08:00:03.000Z",
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-err",
              name: "search_logs",
              arguments: { target: "release" }
            }
          ]
        },
        "tool-call"
      )
    },
    {
      agent: "bob",
      file: childSession,
      entry: makeEntry(
        "2026-03-06T08:00:04.000Z",
        {
          role: "toolResult",
          toolName: "search_logs",
          toolCallId: "tool-err",
          isError: true,
          content: [{ type: "text", text: "{\"message\":\"timeout\"}" }]
        },
        "tool-result"
      )
    },
    {
      agent: "main",
      file: mainSession,
      entry: makeEntry(
        "2026-03-06T08:00:05.000Z",
        {
          role: "user",
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_spawn",
            sourceSessionKey: "agent:bob:22222222-2222-2222-2222-222222222222"
          },
          content: [
            {
              type: "text",
              text: "[Internal task completion event] Result: 风险已经汇总，主要问题在日志采样超时。"
            }
          ]
        },
        "child-return"
      )
    },
    {
      agent: "main",
      file: mainSession,
      entry: makeEntry(
        "2026-03-06T08:00:06.000Z",
        {
          role: "assistant",
          content: [{ type: "text", text: "已整理今天的发布风险，请查看摘要。" }]
        },
        "main-reply"
      )
    },
    {
      agent: "wali_agent",
      file: orphanSession,
      entry: makeEntry(
        "2026-03-06T08:00:07.000Z",
        {
          role: "user",
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: "agent:trash_agent:44444444-4444-4444-4444-444444444444"
          },
          content: [{ type: "text", text: "孤立协作消息" }]
        },
        "orphan-delivery"
      )
    }
  ];

  const events = seed
    .flatMap(({ agent, file, entry }) => parseEventsFromMessage(entry, agent, file))
    .sort((a, b) => a.ts - b.ts);

  for (const event of events) {
    store.emit(event);
  }

  return store;
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  assert.equal(response.status, 200);
  return response.json();
}

test("parse/group store derives completed and orphan executions", () => {
  const store = seedStore();
  const executions = store.queryExecutions({ limit: 10 }).items;

  assert.equal(executions.length, 2);

  const completed = executions.find((item) => item.status === "completed");
  const orphan = executions.find((item) => item.status === "orphan");

  assert.ok(completed, "expected a completed grouped execution");
  assert.ok(orphan, "expected an orphan execution");
  assert.match(completed.groupId, /^run-/);
  assert.equal(completed.sessions.length, 2);
  assert.equal(completed.activeAgents.includes("bob"), true);
  assert.equal(completed.errorCount >= 1, true);
  assert.equal(completed.issues.some((item) => item.label === "工具错误"), true);

  const history = store.queryHistory({
    groupId: completed.groupId,
    includeInternal: true,
    limit: 20
  });
  assert.equal(history.items.length, 7);
  assert.equal(history.items.every((item) => item.groupId === completed.groupId), true);
  assert.equal(history.items.some((item) => item.relatedSessionRef.includes("agent:bob:2222")), true);
});

test("http API returns overview, execution detail, and filtered history", async (t) => {
  const store = seedStore();
  const server = http.createServer(createRequestHandler(store));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const overview = await getJson(baseUrl, "/api/overview");
  assert.equal(overview.statusCounts.completed, 1);
  assert.equal(overview.statusCounts.orphan, 1);

  const executionList = await getJson(baseUrl, "/api/executions?limit=5");
  assert.equal(executionList.items.length, 2);

  const completed = executionList.items.find((item) => item.status === "completed");
  assert.ok(completed, "expected completed execution via API");

  const detail = await getJson(
    baseUrl,
    `/api/executions/${encodeURIComponent(completed.groupId)}`
  );
  assert.equal(detail.summary.groupId, completed.groupId);
  assert.equal(detail.sessions.length, 2);
  assert.deepEqual(detail.filters.sessionDays, ["2026-03-06", "2026-03-05"]);

  const filteredHistory = await getJson(
    baseUrl,
    `/api/history?groupId=${encodeURIComponent(completed.groupId)}&limit=2`
  );
  assert.equal(filteredHistory.items.length, 2);
  assert.equal(
    filteredHistory.items.every((item) => item.groupId === completed.groupId),
    true
  );

  const mainSessionRef = detail.sessions.find((item) => item.agentId === "main").sessionRef;
  const sessionHistory = await getJson(
    baseUrl,
    `/api/history?groupId=${encodeURIComponent(completed.groupId)}&sessionRef=${encodeURIComponent(mainSessionRef)}&limit=10`
  );
  assert.equal(sessionHistory.items.length, 4);
  assert.equal(
    sessionHistory.items.every((item) => item.sessionRef === mainSessionRef),
    true
  );

  const dayHistory = await getJson(
    baseUrl,
    `/api/history?groupId=${encodeURIComponent(completed.groupId)}&day=2026-03-06&limit=10`
  );
  assert.equal(dayHistory.items.length, 4);
  assert.equal(dayHistory.items.some((item) => item.id === "root-prompt"), false);
});
