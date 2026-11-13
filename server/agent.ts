import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import { z } from "zod";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { diffModels, type Change } from "../shared/diff";
import { contextIsComplete, readySubset, type AgentState, type ArchitectureModel, type RunStatus } from "../shared/model";
import type { Store } from "./store";
import { agentEnv, authDescription } from "./auth";
import { DISCOVER_PROMPT, DISCOVER_SYSTEM, applyDiscovery, architectureSchema, hasCode } from "./discover";

const exec = promisify(execFile);
const DEBOUNCE_MS = Number(process.env.BLUEPRINT_DEBOUNCE_MS ?? 4000);
const MODEL = process.env.BLUEPRINT_MODEL ?? "claude-opus-5-5";

export type ServerEvent =
  | { type: "agent"; status: RunStatus; auto: boolean; pending: Change[]; reason?: string }
  | { type: "state"; state: AgentState }
  | { type: "log"; text: string; kind: "text" | "tool" | "info" | "error" }
  | { type: "history" }
  /** architecture.yaml was rewritten on the server; clients reload it. */
  | { type: "model" };

const SYSTEM_APPEND = `
# Blueprint mode
You are the implementation agent behind "blueprint", a tool where the user designs the
architecture of this application as a diagram and you turn it into working code.
The user thinks about architecture; you handle the implementation.

Rules:
- The diagram is the source of truth for the domain. Implement exactly what it describes.
  Infrastructure and scaffolding are fine, but do not invent domain concepts that aren't in the diagram.
- How element types map to code (adapt to the project's stack and conventions):
  - entity: persisted model (+ migration, validations implied by the description, tests)
  - service: a service/application object that encapsulates the described behaviour (+ tests)
  - external: an adapter/client for the external system behind a small interface, stubbed or faked in tests
  - screen: a UI page (route, controller/handler, view) showing what the description says
  - relations: has_many / has_one / belongs_to become associations with foreign keys;
    calls / uses become dependencies between objects; shows means a screen displays that data.
- Before you start on an element call mcp__blueprint__update_element with status "implementing".
  When it's done call it again with status "done", a one-sentence summary and the main files.
  For a screen, also pass "path": the URL path where it can be viewed in the running app (e.g. /recipes).
- The app's root URL (/) should show the main screen, so opening the app shows what was built.
  If there is no screen yet, leave the root route as it is.
- If the design is ambiguous or contradicts itself, do NOT guess: call mcp__blueprint__ask_question
  for that element, skip it, and continue with the rest.
- If the repository is empty, bootstrap a new project with the stack from the project context first.
- Run the test suite before finishing and keep it green.
- Never edit architecture.yaml or anything inside .blueprint/. Don't commit; blueprint commits for you.
- Keep your final message short: what changed, and anything the architect should know.
`;

export class AgentRunner {
  status: RunStatus = "idle";
  auto = true;
  private timer?: NodeJS.Timeout;
  private running = false;
  private rerun = false;
  private abort?: AbortController;
  private logBuffer: Extract<ServerEvent, { type: "log" }>[] = [];

  constructor(
    private store: Store,
    private emit: (e: ServerEvent) => void,
  ) {}

  log(text: string, kind: "text" | "tool" | "info" | "error" = "info") {
    const ev = { type: "log" as const, text, kind };
    this.logBuffer = [...this.logBuffer.slice(-300), ev];
    this.emit(ev);
  }

  recentLogs = () => this.logBuffer;

  async pending(): Promise<Change[]> {
    const [model, implemented] = await Promise.all([this.store.model(), this.store.implemented()]);
    return diffModels(readySubset(implemented), readySubset(model));
  }

  async snapshot(reason?: string): Promise<ServerEvent> {
    return { type: "agent", status: this.status, auto: this.auto, pending: await this.pending(), reason };
  }

  private async setStatus(status: RunStatus, reason?: string) {
    this.status = status;
    this.emit(await this.snapshot(reason));
  }

  private async updateState(fn: (s: AgentState) => void) {
    const s = await this.store.agentState();
    fn(s);
    await this.store.saveAgentState(s);
    this.emit({ type: "state", state: s });
  }

  /** Called after every model save. Syncs per-box status and (re)schedules a run. */
  async onModelChanged() {
    const model = await this.store.model();
    const changes = await this.pending();
    const touched = new Set(changes.flatMap((c) => c.elementIds));

    await this.updateState((s) => {
      const ids = new Set(model.elements.map((e) => e.id));
      for (const id of Object.keys(s.elements)) if (!ids.has(id)) delete s.elements[id];
      for (const el of model.elements) {
        const cur = s.elements[el.id];
        if (cur?.status === "implementing") continue;
        if (!el.ready) s.elements[el.id] = { ...cur, status: "draft" };
        else if (touched.has(el.id)) s.elements[el.id] = { ...cur, status: "pending", question: undefined };
        else if (!cur || cur.status === "draft") s.elements[el.id] = { status: "pending" };
      }
    });

    if (this.running) {
      this.rerun = true;
      return this.emit(await this.snapshot());
    }
    if (!changes.length) return this.setStatus("idle");
    if (!contextIsComplete(model.context)) return this.setStatus("idle", "Fill in name, purpose and stack first");
    if (!this.auto) return this.setStatus("idle");

    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
    await this.setStatus("waiting");
  }

  async setAuto(auto: boolean) {
    this.auto = auto;
    if (!auto) clearTimeout(this.timer);
    if (!auto && this.status === "waiting") return this.setStatus("idle");
    if (auto) return this.onModelChanged();
    this.emit(await this.snapshot());
  }

  /**
   * Reads an existing codebase and draws its diagram: everything found is added as ready and already
   * implemented, so the agent only acts on what the user changes afterwards.
   */
  async discover() {
    if (this.running) return;
    if (!(await hasCode(this.store.repo))) return this.setStatus("idle", "Nothing to map: the folder has no code yet");
    clearTimeout(this.timer);
    this.running = true;
    this.abort = new AbortController();
    await this.setStatus("running", "Mapping existing code…");
    this.log("Reading the existing code to draw its architecture…");
    let found: Parameters<typeof applyDiscovery>[3] | undefined;
    const setArchitecture = tool(
      "set_architecture",
      "Submit the architecture diagram of this repository. Call exactly once, when you've read enough.",
      architectureSchema,
      async (input) => {
        found = input;
        return { content: [{ type: "text", text: "Diagram received. Finish with a one-line summary." }] };
      },
    );
    try {
      const ok = await this.query(DISCOVER_PROMPT, DISCOVER_SYSTEM, {
        tools: createSdkMcpServer({ name: "blueprint", version: "0.1.0", tools: [setArchitecture] }),
        allowedTools: ["Read", "Glob", "Grep", "mcp__blueprint__set_architecture"],
        // Read-only: no writes, no shell.
        disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
      });
      if (ok && found) {
        const [model, layout, state, implemented] = await Promise.all([
          this.store.model(),
          this.store.layout(),
          this.store.agentState(),
          this.store.implemented(),
        ]);
        const next = applyDiscovery(model, layout, state, found);
        const added = new Set(next.model.elements.slice(model.elements.length).map((e) => e.id));
        await this.store.saveModel(next.model);
        await this.store.saveLayout(next.layout);
        await this.store.saveAgentState(next.state);
        // Baseline: what was implemented before, plus everything found in the code.
        await this.store.saveImplemented({
          context: next.model.context,
          elements: [...implemented.elements, ...next.model.elements.filter((e) => added.has(e.id))],
          relations: [...implemented.relations, ...next.model.relations.slice(model.relations.length)],
        });
        this.log(`Mapped ${added.size} element(s) and ${next.model.relations.length - model.relations.length} relation(s) from the code.`);
        this.emit({ type: "model" });
        this.emit({ type: "state", state: next.state });
      } else if (ok) {
        this.status = "error";
        this.log("The agent finished without submitting a diagram.", "error");
      }
    } catch (err) {
      this.status = "error";
      this.log(String(err), "error");
    } finally {
      this.running = false;
      this.abort = undefined;
    }
    if (this.status !== "error") this.status = "idle";
    this.emit(await this.snapshot());
  }

  /** Stops the current run and pauses auto-implement so it doesn't immediately restart. */
  async stop() {
    clearTimeout(this.timer);
    this.auto = false;
    if (this.abort) {
      this.abort.abort();
      this.log("Stopped. Auto-implement paused.", "info");
    } else await this.setStatus("idle");
  }

  async run() {
    clearTimeout(this.timer);
    if (this.running) {
      this.rerun = true;
      return;
    }
    const model = await this.store.model();
    if (!contextIsComplete(model.context)) return this.setStatus("idle", "Fill in name, purpose and stack first");

    const target = readySubset(model);
    const changes = diffModels(readySubset(await this.store.implemented()), target);
    if (!changes.length) return this.setStatus("idle");

    this.running = true;
    this.rerun = false;
    this.abort = new AbortController();
    await this.setStatus("running");
    this.log(`Implementing ${changes.length} change(s):\n` + changes.map((c) => `• ${c.text}`).join("\n"));

    const touched = new Set(changes.flatMap((c) => c.elementIds));
    await this.updateState((s) => {
      for (const id of touched) s.elements[id] = { ...s.elements[id], status: "implementing", question: undefined };
    });

    try {
      const ok = await this.execute(target, changes);
      if (ok) {
        await this.store.saveImplemented(target);
        await this.updateState((s) => {
          for (const id of touched) if (s.elements[id]?.status === "implementing") s.elements[id].status = "done";
        });
        await this.commit(changes);
      } else {
        await this.updateState((s) => {
          for (const id of touched) if (s.elements[id]?.status === "implementing") s.elements[id].status = "error";
        });
      }
    } catch (err) {
      this.log(String(err), "error");
      await this.updateState((s) => {
        for (const id of touched) if (s.elements[id]?.status === "implementing") s.elements[id].status = "error";
      });
    } finally {
      this.running = false;
      this.abort = undefined;
    }

    const failed = this.status === "error";
    if (!failed) this.status = "idle";
    // Edits made during the run are picked up now.
    if (this.rerun || (await this.pending()).length) {
      if (this.auto && !failed) return this.onModelChanged();
    }
    this.emit(await this.snapshot());
  }

  private buildPrompt(target: ArchitectureModel, changes: Change[]): string {
    const { context, ...design } = target;
    return [
      `# Project context`,
      `Name: ${context.name}`,
      `Purpose: ${context.purpose}`,
      `Stack: ${context.stack}`,
      context.constraints.trim() ? `Constraints & conventions:\n${context.constraints}` : null,
      ``,
      `# Current architecture (elements marked ready)`,
      "```yaml",
      YAML.stringify(design).trim(),
      "```",
      ``,
      `# Changes since the last implementation`,
      ...changes.map((c) => `- ${c.text}${c.elementIds.length ? ` [ids: ${c.elementIds.join(", ")}]` : ""}`),
      ``,
      `Implement these changes in the repository so the code matches the architecture above.`,
    ]
      .filter((l) => l !== null)
      .join("\n");
  }

  private tools() {
    const updateElement = tool(
      "update_element",
      "Report implementation progress for one diagram element so the architect sees it on the canvas.",
      {
        element_id: z.string().describe("The element id from the architecture YAML"),
        status: z.enum(["implementing", "done"]),
        summary: z.string().optional().describe("One sentence: what exists in code for this element"),
        files: z.array(z.string()).optional().describe("Main files for this element, repo-relative"),
        path: z
          .string()
          .optional()
          .describe("Screens only: URL path where this screen can be viewed in the running app, e.g. /recipes"),
      },
      async ({ element_id, status, summary, files, path: urlPath }) => {
        const p = urlPath?.trim() ? "/" + urlPath.trim().replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "") : undefined;
        await this.updateState((s) => {
          s.elements[element_id] = {
            ...s.elements[element_id],
            status,
            ...(summary && { summary }),
            ...(files && { files }),
            ...(p && { path: p }),
          };
        });
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    const askQuestion = tool(
      "ask_question",
      "Ask the architect a design question about one element instead of guessing. Skip that element afterwards and continue with the rest.",
      { element_id: z.string(), question: z.string() },
      async ({ element_id, question }) => {
        await this.updateState((s) => {
          s.elements[element_id] = { ...s.elements[element_id], status: "question", question };
        });
        this.log(`❓ ${question}`, "info");
        return { content: [{ type: "text", text: "Question shown to the architect. Continue with other elements." }] };
      },
    );
    return createSdkMcpServer({ name: "blueprint", version: "0.1.0", tools: [updateElement, askQuestion] });
  }

  private execute(target: ArchitectureModel, changes: Change[]): Promise<boolean> {
    return this.query(this.buildPrompt(target, changes), SYSTEM_APPEND, {
      tools: this.tools(),
      // Runs unattended in your own repo: edits are auto-accepted and these tools are pre-approved.
      permissionMode: "acceptEdits",
      allowedTools: [
        "Read", "Write", "Edit", "Glob", "Grep", "Bash",
        "mcp__blueprint__update_element", "mcp__blueprint__ask_question",
      ],
    });
  }

  private async query(
    prompt: string,
    append: string,
    opts: {
      tools: ReturnType<typeof createSdkMcpServer>;
      allowedTools: string[];
      disallowedTools?: string[];
      permissionMode?: "acceptEdits" | "default";
    },
  ): Promise<boolean> {
    const q = query({
      prompt,
      options: {
        cwd: this.store.repo,
        model: MODEL,
        env: agentEnv(), // API key, cloud provider or Claude Code login, see auth.ts
        abortController: this.abort,
        systemPrompt: { type: "preset", preset: "claude_code", append },
        settingSources: ["project"],
        mcpServers: { blueprint: opts.tools },
        permissionMode: opts.permissionMode ?? "default",
        allowedTools: opts.allowedTools,
        ...(opts.disallowedTools && { disallowedTools: opts.disallowedTools }),
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        this.log(`Using ${authDescription()}`, "info");
      } else if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) this.log(block.text.trim(), "text");
          if (block.type === "tool_use") this.log(describeToolUse(block.name, block.input as any), "tool");
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "success" && !msg.is_error) {
          this.log(`✓ Done in ${Math.round(msg.duration_ms / 1000)}s · ${msg.num_turns} turns · $${msg.total_cost_usd.toFixed(2)}`, "info");
          return true;
        }
        this.status = "error";
        this.log(`Run failed: ${msg.subtype}`, "error");
        return false;
      }
    }
    return false;
  }

  private async commit(changes: Change[]) {
    if (!existsSync(path.join(this.store.repo, ".git"))) return;
    const title = changes.length === 1 ? changes[0].text : `${changes.length} architecture changes`;
    const body = changes.map((c) => `- ${c.text}`).join("\n");
    try {
      await exec("git", ["add", "-A"], { cwd: this.store.repo });
      await exec("git", ["commit", "-m", `blueprint: ${title.slice(0, 68)}`, "-m", body], { cwd: this.store.repo });
      this.log("Committed changes to git", "info");
      this.emit({ type: "history" });
    } catch (err: any) {
      if (!String(err.stdout ?? "").includes("nothing to commit")) this.log(`git commit failed: ${err.message}`, "error");
    }
  }
}

function describeToolUse(name: string, input: Record<string, any>): string {
  const arg = input.file_path ?? input.command ?? input.pattern ?? input.element_id ?? "";
  const short = String(arg).replace(/\s+/g, " ").slice(0, 120);
  return `→ ${name.replace("mcp__blueprint__", "")}${short ? ` ${short}` : ""}`;
}
