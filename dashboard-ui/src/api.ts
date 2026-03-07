import type {
  ExecutionDetail,
  ExecutionListResponse,
  HistoryResponse,
  OverviewResponse
} from "./types";

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
  return response.json();
}

export const api = {
  overview(): Promise<OverviewResponse> {
    return fetchJson("/api/overview");
  },
  executions(params: {
    status?: string;
    agent?: string;
    q?: string;
    limit?: number;
  }): Promise<ExecutionListResponse> {
    const query = new URLSearchParams();
    if (params.status && params.status !== "all") query.set("status", params.status);
    if (params.agent && params.agent !== "all") query.set("agent", params.agent);
    if (params.q) query.set("q", params.q);
    if (typeof params.limit === "number") query.set("limit", String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return fetchJson(`/api/executions${suffix}`);
  },
  executionDetail(groupId: string): Promise<ExecutionDetail> {
    return fetchJson(`/api/executions/${encodeURIComponent(groupId)}`);
  },
  history(params: {
    groupId: string;
    includeInternal?: boolean;
    agentId?: string;
    mode?: string;
    sessionRef?: string;
    day?: string;
    q?: string;
    beforeSeq?: number | null;
    limit?: number;
  }): Promise<HistoryResponse> {
    const query = new URLSearchParams();
    query.set("groupId", params.groupId);
    if (params.includeInternal) query.set("includeInternal", "1");
    if (params.agentId && params.agentId !== "all") query.set("agentId", params.agentId);
    if (params.mode && params.mode !== "all") query.set("mode", params.mode);
    if (params.sessionRef) query.set("sessionRef", params.sessionRef);
    if (params.day) query.set("day", params.day);
    if (params.q) query.set("q", params.q);
    if (typeof params.beforeSeq === "number" && Number.isFinite(params.beforeSeq)) {
      query.set("beforeSeq", String(params.beforeSeq));
    }
    if (typeof params.limit === "number") query.set("limit", String(params.limit));
    return fetchJson(`/api/history?${query.toString()}`);
  }
};
