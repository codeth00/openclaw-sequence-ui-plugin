export type ExecutionStatus = "active" | "quiet" | "stalled" | "completed" | "orphan";
export type EventMode = "user" | "spawn" | "a2a" | "internal";
export type Severity = "trace" | "info" | "warn" | "error";

export interface DashboardEvent {
  id: string;
  seq: number;
  ts: number;
  mode: EventMode;
  from: string;
  to: string;
  text: string;
  sessionRef: string;
  sessionAgent: string;
  tool: string;
  stage: string;
  status: string;
  severity: Severity;
  isError: boolean;
  relatedSessionRef: string;
  groupId: string;
}

export interface IssueItem {
  id: string;
  groupId: string;
  eventId: string;
  sessionRef: string;
  agentId: string;
  ts: number;
  severity: Severity;
  label: string;
  message: string;
}

export interface LatestEvent {
  id: string;
  ts: number;
  seq: number;
  from: string;
  to: string;
  mode: EventMode;
  stage: string;
  severity: Severity;
  text: string;
}

export interface SessionSummary {
  sessionRef: string;
  agentId: string;
  startedAt: number;
  lastEventAt: number;
  eventCount: number;
  counts: Record<string, number>;
  latestMode: EventMode;
  latestText: string;
  latestSeverity: Severity;
  health: "active" | "quiet" | "error";
}

export interface ExecutionSummary {
  groupId: string;
  title: string;
  status: ExecutionStatus;
  startedAt: number;
  lastEventAt: number;
  activeAgents: string[];
  eventCounts: Record<string, number>;
  errorCount: number;
  sessions: SessionSummary[];
  latestEvent: LatestEvent | null;
  issues: IssueItem[];
}

export interface ExecutionDetail {
  summary: ExecutionSummary;
  sessions: SessionSummary[];
  issues: IssueItem[];
  filters: {
    agents: string[];
    modes: string[];
    sessionRefs: string[];
    sessionDays: string[];
  };
  defaultHistoryWindow: {
    beforeSeq: number | null;
    limit: number;
  };
}

export interface AgentActivitySummary {
  agentId: string;
  lastEventAt: number;
  activeExecutionCount: number;
  totalEvents: number;
  latestEvent: {
    id: string;
    groupId: string;
    ts: number;
    mode: EventMode;
    severity: Severity;
    text: string;
  } | null;
  health: "active" | "quiet" | "error";
  healthLabel: string;
}

export interface OverviewResponse {
  generatedAt: number;
  kpis: Array<{
    key: string;
    label: string;
    value: number;
    tone: "neutral" | "good" | "warn";
  }>;
  statusCounts: Record<ExecutionStatus, number>;
  agentActivity: AgentActivitySummary[];
  recentIssues: IssueItem[];
  highlightExecutionId: string;
}

export interface HistoryResponse {
  items: DashboardEvent[];
  total: number;
  now: number;
}

export interface ExecutionListResponse {
  items: ExecutionSummary[];
  total: number;
  now: number;
}
