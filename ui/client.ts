export type Row = {
  id: number;
  type: string;
  task_id: string | null;
  agent_id: string | null;
  attempt_id: string | null;
  payload: string;
  created_at: string;
};
export type Workspace = {
  path: string;
  base: string;
  commit: string | null;
  integrated: string | null;
  scope: string[];
  check: string[];
  integrationEvidence?: string;
};
export type Task = {
  id: string;
  title: string;
  body: string;
  status: string;
  created_by: string;
  assigned_to: string;
  dependencies: string[];
  attempts: {
    id: string;
    number: number;
    summary: string | null;
    outcome: string | null;
  }[];
  reviews: {
    id: string;
    reviewer: string;
    decision: string;
    feedback: string;
  }[];
  workspace: Workspace | null;
};
export type Snapshot = {
  projectId: string;
  lastEventId: number;
  agents: { id: string; role: string }[];
  tasks: Task[];
  recentEvents: Row[];
  runtime: {
    workers: {
      taskId: string;
      assignee: string;
      attemptId: string;
      pid?: number;
      workflow?: { stage: string; round: number };
    }[];
    queue: { taskId: string; requestKey: string; reason: string | null }[];
    limits: {
      maxWorkers: number;
      maxReviewers: number;
      freeSlots: number;
      activeReviewers: number;
    };
    paused: boolean;
    integration: null | { taskId: string; pid?: number };
    lastIntegration: null | { taskId: string; state: string; error?: string };
    state: string;
    active: null | {
      taskId: string;
      workflow?: { stage: string; round: number };
    };
  };
};
const hash = new URLSearchParams(location.hash.slice(1));
let token = hash.get("token") ?? sessionStorage.getItem("rarp-token") ?? "";
if (hash.has("token")) {
  sessionStorage.setItem("rarp-token", token);
  history.replaceState(null, "", location.pathname);
}
export function setToken(value: string) {
  token = value;
  sessionStorage.setItem("rarp-token", value);
}
export async function api<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch("/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Yêu cầu thất bại");
  return data;
}
export function mergeEvents(current: Row[], incoming: Row[], limit = 200) {
  return [...new Map([...current, ...incoming].map((e) => [e.id, e])).values()]
    .sort((a, b) => a.id - b.id)
    .slice(-limit);
}
export async function stream(
  after: number,
  signal: AbortSignal,
  onEvent: (event: Row) => void,
) {
  const response = await fetch("/stream?after=" + after, {
    headers: { authorization: "Bearer " + token },
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error("Không thể kết nối sự kiện");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Luồng sự kiện đã đóng");
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) onEvent(JSON.parse(data.slice(6)));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
