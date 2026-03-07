import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  DashboardEvent,
  EventMode,
  ExecutionDetail,
  ExecutionStatus,
  ExecutionSummary,
  OverviewResponse,
  SessionSummary
} from "./types";

const STATUS_META: Record<
  ExecutionStatus,
  { label: string; tone: "active" | "quiet" | "warn" | "done" | "muted" }
> = {
  active: { label: "活跃", tone: "active" },
  quiet: { label: "静默", tone: "quiet" },
  stalled: { label: "疑似停滞", tone: "warn" },
  completed: { label: "已完成", tone: "done" },
  orphan: { label: "孤立", tone: "muted" }
};

const MODE_META: Record<EventMode | "all", { label: string; color: string }> = {
  all: { label: "全部", color: "#7dc7ff" },
  user: { label: "用户", color: "#7dc7ff" },
  spawn: { label: "派发", color: "#ffbf66" },
  a2a: { label: "协作", color: "#63e0ba" },
  internal: { label: "过程", color: "#f0a3d1" }
};

function formatClock(ts: number) {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDateTime(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDayLabel(dayKey: string) {
  const date = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dayKey;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  });
}

function formatRelative(ts: number) {
  const diff = Date.now() - ts;
  const sec = Math.max(1, Math.floor(diff / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

function formatAgent(agentId: string) {
  if (agentId === "user") return "用户";
  if (agentId === "main") return "main";
  return agentId || "unknown";
}

function wrapText(text: string, maxChars: number, maxLines: number) {
  const source = String(text || "").trim() || "(空消息)";
  const lines: string[] = [];
  for (const paragraph of source.split(/\r?\n/)) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let start = 0;
    while (start < paragraph.length && lines.length < maxLines) {
      lines.push(paragraph.slice(start, start + maxChars));
      start += maxChars;
    }
    if (lines.length >= maxLines) break;
  }
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }
  if (source.length > maxChars * maxLines) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return lines.slice(0, maxLines);
}

function buildAgentList(events: DashboardEvent[]) {
  const agents: string[] = [];
  const addAgent = (value: string) => {
    if (!value || agents.includes(value)) return;
    if (value === "user") {
      agents.unshift(value);
      return;
    }
    if (value === "main") {
      const insertIndex = agents.includes("user") ? 1 : 0;
      agents.splice(insertIndex, 0, value);
      return;
    }
    agents.push(value);
  };
  for (const item of events) {
    addAgent(item.from);
    addAgent(item.to);
  }
  return agents.length ? agents : ["main"];
}

function buildTimelineLayout(events: DashboardEvent[]) {
  const agents = buildAgentList(events);
  const side = 96;
  const gap = agents.length > 1 ? 210 : 0;
  const width = Math.max(860, side * 2 + gap * Math.max(agents.length - 1, 0) + 120);
  const xMap = new Map<string, number>();
  agents.forEach((agentId, index) => {
    xMap.set(agentId, side + index * gap);
  });

  let y = 28;
  let previousSession = "";
  const rows: Array<
    | {
        kind: "separator";
        y: number;
        text: string;
      }
    | {
        kind: "event";
        y: number;
        height: number;
        boxHeight: number;
        boxWidth: number;
        arrowY: number;
        lines: string[];
        event: DashboardEvent;
      }
  > = [];

  for (const event of events) {
    if (previousSession && event.sessionRef !== previousSession) {
      rows.push({
        kind: "separator",
        y,
        text: `${formatAgent(event.sessionAgent)} 会话`
      });
      y += 34;
    }
    previousSession = event.sessionRef;

    const metaLine = `${formatClock(event.ts)} · ${MODE_META[event.mode].label} · ${formatAgent(event.from)} → ${formatAgent(event.to)}`;
    const lines = [
      ...wrapText(metaLine, 34, 2),
      ...wrapText(event.text, 38, 4)
    ].slice(0, 6);
    const boxHeight = lines.length * 16 + 18;
    const height = boxHeight + 36;
    rows.push({
      kind: "event",
      y,
      height,
      boxHeight,
      boxWidth: 292,
      arrowY: y + boxHeight + 8,
      lines,
      event
    });
    y += height + 18;
  }

  return {
    agents,
    width,
    height: Math.max(420, y + 32),
    xMap,
    rows
  };
}

function sequenceStatusCopy(status: ExecutionStatus) {
  return STATUS_META[status]?.label || status;
}

function parseTimelineSessionFilter(value: string) {
  if (value.startsWith("session:")) {
    return {
      sessionRef: value.slice("session:".length),
      day: ""
    };
  }
  if (value.startsWith("day:")) {
    return {
      sessionRef: "",
      day: value.slice("day:".length)
    };
  }
  return {
    sessionRef: "",
    day: ""
  };
}

export default function App() {
  const [view, setView] = useState<"overview" | "timeline">("overview");
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [executions, setExecutions] = useState<ExecutionSummary[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [history, setHistory] = useState<DashboardEvent[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<DashboardEvent | null>(null);
  const [liveState, setLiveState] = useState<"connecting" | "online" | "reconnecting">("connecting");
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [executionAgentFilter, setExecutionAgentFilter] = useState("all");
  const [executionSearch, setExecutionSearch] = useState("");
  const [timelineAgentFilter, setTimelineAgentFilter] = useState("all");
  const [timelineModeFilter, setTimelineModeFilter] = useState<"all" | EventMode>("all");
  const [timelineSessionFilter, setTimelineSessionFilter] = useState("all");
  const [timelineSearch, setTimelineSearch] = useState("");
  const [showInternal, setShowInternal] = useState(false);
  const [followLive, setFollowLive] = useState(true);
  const [cursor, setCursor] = useState(0);

  const selectedExecutionIdRef = useRef("");
  const refreshTimerRef = useRef<number | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);

  selectedExecutionIdRef.current = selectedExecutionId;

  const selectedSummary =
    detail?.summary || executions.find((item) => item.groupId === selectedExecutionId) || null;

  async function loadOverviewAndExecutions() {
    const [nextOverview, nextExecutions] = await Promise.all([
      api.overview(),
      api.executions({
        status: statusFilter,
        agent: executionAgentFilter,
        q: executionSearch,
        limit: 60
      })
    ]);

    setOverview(nextOverview);
    setExecutions(nextExecutions.items);

    const current = selectedExecutionIdRef.current;
    const keepCurrent =
      current && nextExecutions.items.some((item) => item.groupId === current) ? current : "";
    const preferred =
      keepCurrent || nextOverview.highlightExecutionId || nextExecutions.items[0]?.groupId || "";

    if (preferred !== current) {
      setSelectedExecutionId(preferred);
    }
  }

  async function loadExecutionDetail(groupId: string) {
    const nextDetail = await api.executionDetail(groupId);
    if (selectedExecutionIdRef.current === groupId) {
      setDetail(nextDetail);
    }
  }

  async function loadHistory(
    groupId: string,
    overrides?: Partial<{
      agentId: string;
      mode: "all" | EventMode;
      sessionFilter: string;
      q: string;
    }>
  ) {
    const sessionFilter = overrides?.sessionFilter ?? timelineSessionFilter;
    const sessionScope = parseTimelineSessionFilter(sessionFilter);
    const payload = await api.history({
      groupId,
      includeInternal: showInternal,
      agentId: overrides?.agentId ?? timelineAgentFilter,
      mode: overrides?.mode ?? timelineModeFilter,
      sessionRef: sessionScope.sessionRef,
      day: sessionScope.day,
      q: overrides?.q ?? timelineSearch,
      limit: 480
    });

    if (selectedExecutionIdRef.current !== groupId) return;

    setHistory(payload.items);
    setHistoryTotal(payload.total);
    if (followLive) {
      setCursor(payload.items.length);
    } else {
      setCursor((prev) => Math.min(prev, payload.items.length));
    }
  }

  async function refreshAll() {
    setIsLoading(true);
    try {
      await loadOverviewAndExecutions();
      const groupId = selectedExecutionIdRef.current;
      if (groupId) {
        await Promise.all([loadExecutionDetail(groupId), loadHistory(groupId)]);
      }
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadOverviewAndExecutions().catch((error) => {
      console.error(error);
    });
  }, [statusFilter, executionAgentFilter, executionSearch]);

  useEffect(() => {
    if (!selectedExecutionId) {
      setDetail(null);
      setHistory([]);
      setHistoryTotal(0);
      return;
    }
    setSelectedEvent(null);
    setTimelineAgentFilter("all");
    setTimelineModeFilter("all");
    setTimelineSessionFilter("all");
    setTimelineSearch("");
    setFollowLive(true);
    void Promise.all([
      loadExecutionDetail(selectedExecutionId),
      loadHistory(selectedExecutionId, {
        agentId: "all",
        mode: "all",
        sessionFilter: "all",
        q: ""
      })
    ]).catch((error) => {
      console.error(error);
    });
  }, [selectedExecutionId]);

  useEffect(() => {
    if (!selectedExecutionId) return;
    void loadHistory(selectedExecutionId).catch((error) => {
      console.error(error);
    });
  }, [
    selectedExecutionId,
    timelineAgentFilter,
    timelineModeFilter,
    timelineSessionFilter,
    timelineSearch,
    showInternal
  ]);

  useEffect(() => {
    void refreshAll().catch((error) => {
      console.error(error);
    });
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events?includeInternal=1");
    source.onopen = () => setLiveState("online");
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as DashboardEvent;
        setLiveState("online");
        if (refreshTimerRef.current) {
          window.clearTimeout(refreshTimerRef.current);
        }
        refreshTimerRef.current = window.setTimeout(() => {
          void loadOverviewAndExecutions().catch((error) => {
            console.error(error);
          });
          const current = selectedExecutionIdRef.current;
          if (current && parsed.groupId === current) {
            void Promise.all([loadExecutionDetail(current), loadHistory(current)]).catch((error) => {
              console.error(error);
            });
          }
        }, 220);
      } catch {
        // ignore malformed event payload
      }
    };
    source.onerror = () => {
      setLiveState("reconnecting");
    };
    return () => {
      source.close();
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!followLive) return;
    setCursor(history.length);
  }, [history.length, followLive]);

  useEffect(() => {
    if (!timelineScrollRef.current) return;
    if (!followLive && cursor < history.length) return;
    requestAnimationFrame(() => {
      const node = timelineScrollRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    });
  }, [cursor, history.length, followLive, view]);

  const visibleEvents = history.slice(0, cursor);
  const timelineLayout = buildTimelineLayout(visibleEvents);
  const overviewAgents = Array.from(
    new Set(
      executions.flatMap((item) => item.activeAgents)
    )
  ).sort();
  const timelineAgents = detail?.filters.agents || [];
  const timelineSessionDays = detail?.filters.sessionDays || [];

  function handleManualSeek(target: number) {
    setFollowLive(false);
    setCursor(Math.max(0, Math.min(target, history.length)));
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-kicker">OpenClaw Runtime Console</span>
          <h1>运行看板 V2</h1>
          <p>总览异常、会话分组与时序回放，面向排障和演示的本地只读控制台。</p>
        </div>

        <div className="topbar-actions">
          <span className={`live-pill ${liveState}`}>
            {liveState === "online" ? "已连接" : liveState === "reconnecting" ? "重连中" : "连接中"}
          </span>
          <div className="segmented">
            <button
              className={view === "overview" ? "active" : ""}
              onClick={() => setView("overview")}
            >
              运行总览
            </button>
            <button
              className={view === "timeline" ? "active" : ""}
              onClick={() => setView("timeline")}
              disabled={!selectedExecutionId}
            >
              时序图
            </button>
          </div>
          <button className="primary-btn" onClick={() => void refreshAll()}>
            重载历史
          </button>
        </div>
      </header>

      {overview && (
        <section className="stat-strip">
          {overview.kpis.map((kpi) => (
            <article className={`stat-card tone-${kpi.tone}`} key={kpi.key}>
              <span>{kpi.label}</span>
              <strong>{kpi.value}</strong>
            </article>
          ))}
        </section>
      )}

      <main className="workspace">
        <section className="workspace-main">
          {view === "overview" ? (
            <>
              <div className="panel-heading">
                <div>
                  <h2>执行分组</h2>
                  <p>
                    当前展示 {executions.length} 个执行分组
                    {overview ? `，生成于 ${formatClock(overview.generatedAt)}` : ""}
                  </p>
                </div>
                <div className="filter-row compact">
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                    <option value="all">全部状态</option>
                    {Object.entries(STATUS_META).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={executionAgentFilter}
                    onChange={(event) => setExecutionAgentFilter(event.target.value)}
                  >
                    <option value="all">全部 Agent</option>
                    {overviewAgents.map((agentId) => (
                      <option key={agentId} value={agentId}>
                        {formatAgent(agentId)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="search"
                    value={executionSearch}
                    onChange={(event) => setExecutionSearch(event.target.value)}
                    placeholder="搜索标题、异常或 Agent"
                  />
                </div>
              </div>

              <div className="execution-grid">
                {executions.map((execution) => (
                  <button
                    key={execution.groupId}
                    className={`execution-card ${selectedExecutionId === execution.groupId ? "active" : ""}`}
                    onClick={() => setSelectedExecutionId(execution.groupId)}
                  >
                    <div className="execution-card-top">
                      <span className={`status-chip tone-${STATUS_META[execution.status].tone}`}>
                        {sequenceStatusCopy(execution.status)}
                      </span>
                      <span className="meta-chip">
                        {execution.eventCounts.total} 条事件
                      </span>
                    </div>
                    <h3>{execution.title}</h3>
                    <p className="execution-card-copy">
                      {execution.latestEvent?.text || "暂无最新事件摘要"}
                    </p>
                    <div className="agent-chip-row">
                      {execution.activeAgents.slice(0, 5).map((agentId) => (
                        <span className="agent-chip" key={agentId}>
                          {formatAgent(agentId)}
                        </span>
                      ))}
                    </div>
                    <div className="execution-card-foot">
                      <span>最近更新 {formatRelative(execution.lastEventAt)}</span>
                      {execution.issues.length > 0 && (
                        <span className="issue-chip">{execution.issues.length} 个问题</span>
                      )}
                    </div>
                  </button>
                ))}

                {!executions.length && (
                  <div className="empty-state">
                    <strong>暂无执行分组</strong>
                    <span>等待 OpenClaw 会话事件进入本地历史。</span>
                  </div>
                )}
              </div>

              <div className="sub-grid">
                <section className="sub-panel">
                  <div className="panel-heading slim">
                    <div>
                      <h2>最近问题</h2>
                      <p>帮助优先定位异常、孤立会话和停滞分组。</p>
                    </div>
                  </div>
                  <div className="stack-list">
                    {overview?.recentIssues.length ? (
                      overview.recentIssues.map((issue) => (
                        <button
                          key={issue.id}
                          className={`issue-row severity-${issue.severity}`}
                          onClick={() => {
                            setSelectedExecutionId(issue.groupId);
                            setView("timeline");
                          }}
                        >
                          <span>{issue.label}</span>
                          <strong>{issue.message}</strong>
                          <small>{formatRelative(issue.ts)}</small>
                        </button>
                      ))
                    ) : (
                      <div className="empty-inline">当前没有近期问题。</div>
                    )}
                  </div>
                </section>

                <section className="sub-panel">
                  <div className="panel-heading slim">
                    <div>
                      <h2>活跃 Agent</h2>
                      <p>基于最近事件估算的健康度和参与度。</p>
                    </div>
                  </div>
                  <div className="stack-list">
                    {overview?.agentActivity.length ? (
                      overview.agentActivity.map((item) => (
                        <div className="agent-row" key={item.agentId}>
                          <div>
                            <strong>{formatAgent(item.agentId)}</strong>
                            <span>{item.healthLabel}</span>
                          </div>
                          <div>
                            <strong>{item.activeExecutionCount}</strong>
                            <span>执行分组</span>
                          </div>
                          <div>
                            <strong>{formatRelative(item.lastEventAt)}</strong>
                            <span>最近活跃</span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="empty-inline">暂无 Agent 活动数据。</div>
                    )}
                  </div>
                </section>
              </div>
            </>
          ) : (
            <>
              <div className="panel-heading">
                <div>
                  <h2>时序图</h2>
                  <p>
                    {selectedSummary ? selectedSummary.title : "请先从总览选择一个执行分组"}
                  </p>
                </div>
                <div className="filter-row compact">
                  <button
                    className={`toggle-chip ${showInternal ? "active" : ""}`}
                    onClick={() => setShowInternal((prev) => !prev)}
                  >
                    {showInternal ? "隐藏过程" : "显示过程"}
                  </button>
                  <button
                    className={`toggle-chip ${followLive ? "active" : ""}`}
                    onClick={() => setFollowLive((prev) => !prev)}
                  >
                    {followLive ? "跟随最新" : "固定视窗"}
                  </button>
                </div>
              </div>

              <div className="timeline-controls">
                <div className="filter-row">
                  <select
                    value={timelineSessionFilter}
                    onChange={(event) => setTimelineSessionFilter(event.target.value)}
                  >
                    <option value="all">全部会话</option>
                    {!!detail?.sessions.length && (
                      <optgroup label="单个会话">
                        {detail.sessions.map((session) => (
                          <option
                            key={session.sessionRef}
                            value={`session:${session.sessionRef}`}
                          >
                            {formatAgent(session.agentId)} · {session.sessionRef}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {!!timelineSessionDays.length && (
                      <optgroup label="按天">
                        {timelineSessionDays.map((dayKey) => (
                          <option key={dayKey} value={`day:${dayKey}`}>
                            {formatDayLabel(dayKey)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <select
                    value={timelineAgentFilter}
                    onChange={(event) => setTimelineAgentFilter(event.target.value)}
                  >
                    <option value="all">全部 Agent</option>
                    {timelineAgents.map((agentId) => (
                      <option key={agentId} value={agentId}>
                        {formatAgent(agentId)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={timelineModeFilter}
                    onChange={(event) =>
                      setTimelineModeFilter(event.target.value as "all" | EventMode)
                    }
                  >
                    <option value="all">全部模式</option>
                    <option value="user">用户交互</option>
                    <option value="spawn">派发</option>
                    <option value="a2a">协作</option>
                    {showInternal && <option value="internal">过程</option>}
                  </select>
                  <input
                    type="search"
                    value={timelineSearch}
                    onChange={(event) => setTimelineSearch(event.target.value)}
                    placeholder="搜索消息、工具或会话"
                  />
                </div>

                <div className="playback-row">
                  <button
                    className="ghost-btn"
                    onClick={() => handleManualSeek(cursor - 1)}
                    disabled={cursor <= 0}
                  >
                    上一步
                  </button>
                  <button
                    className="ghost-btn"
                    onClick={() => handleManualSeek(cursor + 1)}
                    disabled={cursor >= history.length}
                  >
                    下一步
                  </button>
                  <label className="range-wrap grow">
                    <span>
                      进度 {cursor} / {history.length}
                      {historyTotal > history.length ? `（已过滤，共 ${historyTotal} 条）` : ""}
                    </span>
                    <input
                      type="range"
                      min="0"
                      max={Math.max(0, history.length)}
                      step="1"
                      value={Math.min(cursor, history.length)}
                      onChange={(event) => handleManualSeek(Number(event.target.value))}
                    />
                  </label>
                </div>
              </div>

              <div className="timeline-board">
                <div className="timeline-header-strip" style={{ minWidth: timelineLayout.width }}>
                  {timelineLayout.agents.map((agentId) => (
                    <div className="lane-pill" key={agentId}>
                      {formatAgent(agentId)}
                    </div>
                  ))}
                </div>

                <div className="timeline-scroll" ref={timelineScrollRef}>
                  {visibleEvents.length ? (
                    <svg
                      className="timeline-svg"
                      viewBox={`0 0 ${timelineLayout.width} ${timelineLayout.height}`}
                      width={timelineLayout.width}
                      height={timelineLayout.height}
                    >
                      {timelineLayout.agents.map((agentId) => {
                        const x = timelineLayout.xMap.get(agentId) || 0;
                        return (
                          <line
                            key={agentId}
                            x1={x}
                            y1={0}
                            x2={x}
                            y2={timelineLayout.height}
                            stroke="rgba(125, 199, 255, 0.22)"
                            strokeWidth="1.3"
                            strokeDasharray="6 6"
                          />
                        );
                      })}

                      <defs>
                        {(Object.entries(MODE_META) as Array<[string, { label: string; color: string }]>)
                          .filter(([key]) => key !== "all")
                          .map(([key, value]) => (
                            <marker
                              id={`arrow-${key}`}
                              key={key}
                              markerWidth="10"
                              markerHeight="10"
                              refX="8"
                              refY="5"
                              orient="auto"
                            >
                              <polygon points="0 0, 10 5, 0 10" fill={value.color} />
                            </marker>
                          ))}
                      </defs>

                      {timelineLayout.rows.map((row) => {
                        if (row.kind === "separator") {
                          return (
                            <g key={`sep-${row.y}`}>
                              <line
                                x1={18}
                                y1={row.y + 10}
                                x2={timelineLayout.width - 18}
                                y2={row.y + 10}
                                stroke="rgba(255, 191, 102, 0.38)"
                                strokeWidth="1.2"
                                strokeDasharray="8 6"
                              />
                              <rect
                                x={timelineLayout.width / 2 - 68}
                                y={row.y}
                                width={136}
                                height={20}
                                rx={10}
                                fill="rgba(18, 24, 43, 0.92)"
                                stroke="rgba(255, 191, 102, 0.3)"
                              />
                              <text
                                x={timelineLayout.width / 2}
                                y={row.y + 14}
                                textAnchor="middle"
                                fill="#ffd8a1"
                                fontSize="11"
                              >
                                {row.text}
                              </text>
                            </g>
                          );
                        }

                        const event = row.event;
                        const modeColor = MODE_META[event.mode].color;
                        const fromX = timelineLayout.xMap.get(event.from) || 0;
                        const toX = timelineLayout.xMap.get(event.to) || 0;
                        const sameLane = fromX === toX;
                        const boxX = sameLane
                          ? Math.min(timelineLayout.width - row.boxWidth - 16, fromX + 28)
                          : Math.max(
                              16,
                              Math.min(
                                timelineLayout.width - row.boxWidth - 16,
                                (fromX + toX) / 2 - row.boxWidth / 2
                              )
                            );

                        return (
                          <g key={event.id} className="timeline-event">
                            <rect
                              x={boxX}
                              y={row.y}
                              width={row.boxWidth}
                              height={row.boxHeight}
                              rx={12}
                              fill={selectedEvent?.id === event.id ? "rgba(35, 69, 108, 0.92)" : "rgba(10, 18, 32, 0.92)"}
                              stroke={selectedEvent?.id === event.id ? "rgba(125, 199, 255, 0.72)" : "rgba(125, 199, 255, 0.16)"}
                              strokeWidth="1"
                              onClick={() => setSelectedEvent(event)}
                            />
                            {row.lines.map((line, index) => (
                              <text
                                key={`${event.id}-${index}`}
                                x={boxX + 12}
                                y={row.y + 18 + index * 16}
                                fill={index === 0 ? "#d9ecff" : "#f4fbff"}
                                fontSize={index === 0 ? "11" : "12"}
                                onClick={() => setSelectedEvent(event)}
                              >
                                {line}
                              </text>
                            ))}

                            {sameLane ? (
                              <path
                                d={`M ${fromX} ${row.arrowY} H ${fromX + 56} V ${row.arrowY + 24} H ${fromX + 10}`}
                                fill="none"
                                stroke={modeColor}
                                strokeWidth="2"
                                markerEnd={`url(#arrow-${event.mode})`}
                              />
                            ) : (
                              <line
                                x1={fromX}
                                y1={row.arrowY}
                                x2={toX}
                                y2={row.arrowY}
                                stroke={modeColor}
                                strokeWidth="2"
                                markerEnd={`url(#arrow-${event.mode})`}
                              />
                            )}

                            <circle cx={fromX} cy={row.arrowY} r={3.4} fill={modeColor} />
                            {event.tool && (
                              <>
                                <rect
                                  x={(sameLane ? fromX + 30 : (fromX + toX) / 2) - 52}
                                  y={row.arrowY - 22}
                                  width={104}
                                  height={16}
                                  rx={8}
                                  fill="rgba(4, 12, 24, 0.95)"
                                  stroke={modeColor}
                                  strokeWidth="1"
                                />
                                <text
                                  x={sameLane ? fromX + 30 : (fromX + toX) / 2}
                                  y={row.arrowY - 10}
                                  fill={modeColor}
                                  fontSize="10.5"
                                  textAnchor="middle"
                                >
                                  {event.tool}
                                </text>
                              </>
                            )}
                          </g>
                        );
                      })}
                    </svg>
                  ) : (
                    <div className="empty-state timeline-empty">
                      <strong>{isLoading ? "正在加载时序事件..." : "当前筛选条件下没有事件"}</strong>
                      <span>可以切换 Agent、模式、内部过程或搜索条件重新查看。</span>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        <aside className="workspace-side">
          <div className="side-panel">
            {selectedSummary ? (
              <>
                <div className="side-heading">
                  <div>
                    <span className={`status-chip tone-${STATUS_META[selectedSummary.status].tone}`}>
                      {sequenceStatusCopy(selectedSummary.status)}
                    </span>
                    <h2>{selectedSummary.title}</h2>
                    <p>
                      开始于 {formatDateTime(selectedSummary.startedAt)} · 最近更新{" "}
                      {formatRelative(selectedSummary.lastEventAt)}
                    </p>
                  </div>
                  {view === "overview" && (
                    <button className="ghost-btn" onClick={() => setView("timeline")}>
                      打开时序图
                    </button>
                  )}
                </div>

                {selectedEvent && view === "timeline" && (
                  <section className="detail-card">
                    <div className="detail-head">
                      <h3>事件详情</h3>
                      <button className="text-btn" onClick={() => setSelectedEvent(null)}>
                        关闭
                      </button>
                    </div>
                    <dl className="detail-grid">
                      <div>
                        <dt>时间</dt>
                        <dd>{formatDateTime(selectedEvent.ts)}</dd>
                      </div>
                      <div>
                        <dt>模式</dt>
                        <dd>{MODE_META[selectedEvent.mode].label}</dd>
                      </div>
                      <div>
                        <dt>方向</dt>
                        <dd>
                          {formatAgent(selectedEvent.from)} → {formatAgent(selectedEvent.to)}
                        </dd>
                      </div>
                      <div>
                        <dt>会话</dt>
                        <dd>{selectedEvent.sessionRef}</dd>
                      </div>
                      <div>
                        <dt>阶段</dt>
                        <dd>{selectedEvent.stage || "-"}</dd>
                      </div>
                      <div>
                        <dt>工具</dt>
                        <dd>{selectedEvent.tool || "-"}</dd>
                      </div>
                    </dl>
                    <pre className="event-copy">{selectedEvent.text}</pre>
                  </section>
                )}

                <section className="detail-card">
                  <div className="detail-head">
                    <h3>执行快照</h3>
                    <span>{selectedSummary.eventCounts.total} 条事件</span>
                  </div>
                  <div className="metric-grid">
                    <article>
                      <span>活跃 Agent</span>
                      <strong>{selectedSummary.activeAgents.length}</strong>
                    </article>
                    <article>
                      <span>异常事件</span>
                      <strong>{selectedSummary.errorCount}</strong>
                    </article>
                    <article>
                      <span>会话数</span>
                      <strong>{selectedSummary.sessions.length}</strong>
                    </article>
                    <article>
                      <span>显示事件</span>
                      <strong>{history.length}</strong>
                    </article>
                  </div>
                  <div className="agent-chip-row">
                    {selectedSummary.activeAgents.map((agentId) => (
                      <span className="agent-chip" key={agentId}>
                        {formatAgent(agentId)}
                      </span>
                    ))}
                  </div>
                </section>

                <section className="detail-card">
                  <div className="detail-head">
                    <h3>最近问题</h3>
                    <span>{detail?.issues.length || 0}</span>
                  </div>
                  {detail?.issues.length ? (
                    <div className="stack-list">
                      {detail.issues.map((issue) => (
                        <div className={`issue-row static severity-${issue.severity}`} key={issue.id}>
                          <span>{issue.label}</span>
                          <strong>{issue.message}</strong>
                          <small>{formatRelative(issue.ts)}</small>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-inline">当前执行没有额外问题标记。</div>
                  )}
                </section>

                <section className="detail-card">
                  <div className="detail-head">
                    <h3>会话摘要</h3>
                    <span>{detail?.sessions.length || 0}</span>
                  </div>
                  {detail?.sessions.length ? (
                    <div className="stack-list">
                      {detail.sessions.map((session) => (
                        <SessionRow
                          key={session.sessionRef}
                          session={session}
                          onFocus={() => {
                            setView("timeline");
                            setSelectedEvent(null);
                            setTimelineAgentFilter("all");
                            setTimelineModeFilter("all");
                            setTimelineSessionFilter(`session:${session.sessionRef}`);
                            setTimelineSearch("");
                            setFollowLive(true);
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="empty-inline">暂无会话摘要。</div>
                  )}
                </section>
              </>
            ) : (
              <div className="empty-state side-empty">
                <strong>请选择一个执行分组</strong>
                <span>从左侧总览卡片进入详情，或直接跳到时序图。</span>
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function SessionRow({
  session,
  onFocus
}: {
  session: SessionSummary;
  onFocus: () => void;
}) {
  return (
    <button className={`session-row health-${session.health}`} onClick={onFocus}>
      <div>
        <strong>{formatAgent(session.agentId)}</strong>
        <span>{session.sessionRef}</span>
      </div>
      <div>
        <strong>{session.eventCount}</strong>
        <span>事件</span>
      </div>
      <div>
        <strong>{formatRelative(session.lastEventAt)}</strong>
        <span>{MODE_META[session.latestMode].label}</span>
      </div>
    </button>
  );
}
