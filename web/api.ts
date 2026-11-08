import type { Change } from "../shared/diff";
import type { AgentState, ArchitectureModel, Layout, RunStatus } from "../shared/model";

export interface AgentInfo {
  status: RunStatus;
  auto: boolean;
  pending: Change[];
  reason?: string;
}

export interface LogLine {
  text: string;
  kind: "text" | "tool" | "info" | "error";
}

export interface Bootstrap {
  repo: string;
  model: ArchitectureModel;
  layout: Layout;
  state: AgentState;
  agent: AgentInfo;
  logs: LogLine[];
  /** The folder has files besides git/blueprint's own, so the diagram can be drawn from the code. */
  hasCode: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  status?: RunStatus;
  missing?: boolean;
  removable: boolean;
}

export interface Settings {
  projectsDir: string;
  configPath: string;
}

/** Project events carry the project id; the client ignores those for other projects. */
export type ServerEvent =
  | ({ type: "agent"; project: string } & AgentInfo)
  | { type: "state"; project: string; state: AgentState }
  | ({ type: "log"; project: string } & LogLine)
  | { type: "history"; project: string }
  | { type: "model"; project: string }
  | { type: "projects"; projects: ProjectSummary[] };

export interface AppInfo {
  url: string;
  running: boolean;
  command?: string;
  starting: boolean;
  managed: boolean;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface RunEntry {
  sha: string;
  title: string;
  date: string;
  changes: string[];
  files: FileChange[];
}

const send = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type Result<T = {}> = { ok: true } & T | { ok: false; error: string };
const json = <T>(r: Response): Promise<T> => r.json();

export const projectsApi = {
  list: (): Promise<{ projects: ProjectSummary[]; initial?: string; settings: Settings }> =>
    fetch("/api/projects").then((r) => r.json()),
  create: (name: string) => send("POST", "/api/projects", { name }).then(json<Result<{ project: ProjectSummary }>>),
  addExisting: (path: string) => send("POST", "/api/projects", { path }).then(json<Result<{ project: ProjectSummary }>>),
  remove: (id: string) => send("DELETE", `/api/projects/${id}`).then(json<Result>),
  setProjectsDir: (projectsDir: string) =>
    send("PUT", "/api/settings", { projectsDir }).then(json<Result<{ settings: Settings }>>),
};

/** API for one project. */
export function projectApi(id: string) {
  const base = `/api/projects/${id}`;
  return {
    bootstrap: (): Promise<Bootstrap> =>
      fetch(`${base}/bootstrap`).then((r) => (r.ok ? r.json() : Promise.reject(new Error("Project not found")))),
    saveModel: (m: ArchitectureModel) => send("PUT", `${base}/model`, m),
    saveLayout: (l: Layout) => send("PUT", `${base}/layout`, l),
    run: () => send("POST", `${base}/agent/run`),
    stop: () => send("POST", `${base}/agent/stop`),
    discover: () => send("POST", `${base}/agent/discover`),
    history: (): Promise<{ git: boolean; runs: RunEntry[] }> => fetch(`${base}/history`).then((r) => r.json()),
    diff: (sha: string, file: string): Promise<string> =>
      fetch(`${base}/diff?${new URLSearchParams({ sha, file })}`).then((r) => r.text()),
    appInfo: (): Promise<AppInfo> => fetch(`${base}/app`).then((r) => r.json()),
    startApp: () => send("POST", `${base}/app/start`).then(json<Result<{ url: string }>>),
    setAuto: (auto: boolean) => send("POST", `${base}/agent/auto`, { auto }),
  };
}

export type ProjectApi = ReturnType<typeof projectApi>;

/** WebSocket with automatic reconnect. Returns a cleanup function. */
export function subscribe(onEvent: (e: ServerEvent) => void, onReconnect: () => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout>;
  let first = true;

  const connect = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      if (!first) onReconnect();
      first = false;
    };
    ws.onmessage = (m) => onEvent(JSON.parse(m.data));
    ws.onclose = () => {
      if (!closed) retry = setTimeout(connect, 1000);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  };
}
