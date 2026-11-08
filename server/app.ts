import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface AppInfo {
  url: string;
  running: boolean;
  /** Command blueprint would use to start the app, if it knows one. */
  command?: string;
  /** True while blueprint has started the app and is waiting for it to answer. */
  starting: boolean;
  /** Whether blueprint itself owns the running process. */
  managed: boolean;
}

/**
 * The generated application: where it is served, and starting it on demand.
 * BLUEPRINT_APP_URL / BLUEPRINT_APP_CMD override the defaults.
 */
export class AppRunner {
  readonly url: string;
  private proc?: ChildProcess;
  private startPromise?: Promise<void>;

  constructor(
    private repo: string,
    private log: (text: string, kind: "info" | "error") => void,
  ) {
    this.url = (process.env.BLUEPRINT_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  }

  get managed() {
    return !!this.proc;
  }

  command(): string | undefined {
    if (process.env.BLUEPRINT_APP_CMD) return process.env.BLUEPRINT_APP_CMD;
    if (existsSync(path.join(this.repo, "bin/dev"))) return "bin/dev";
    const pkg = path.join(this.repo, "package.json");
    if (existsSync(pkg)) {
      try {
        const scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {};
        if (scripts.dev) return "npm run dev";
        if (scripts.start) return "npm start";
      } catch {}
    }
    return undefined;
  }

  async isUp(): Promise<boolean> {
    try {
      // Any HTTP answer counts, including error pages: the server is there.
      await fetch(this.url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
      return true;
    } catch {
      return false;
    }
  }

  async info(): Promise<AppInfo> {
    return {
      url: this.url,
      running: await this.isUp(),
      command: this.command(),
      starting: !!this.startPromise,
      managed: !!this.proc,
    };
  }

  /** Starts the app unless it already answers; resolves once it does. */
  async ensureRunning(): Promise<void> {
    if (await this.isUp()) return;
    this.startPromise ??= this.start().finally(() => (this.startPromise = undefined));
    return this.startPromise;
  }

  private async start() {
    const cmd = this.command();
    if (!cmd) throw new Error("Don't know how to start this app. Set BLUEPRINT_APP_CMD.");
    if (!this.proc) {
      const port = new URL(this.url).port || "80";
      this.log(`Starting app: ${cmd} (${this.url})`, "info");
      const proc = spawn(cmd, { cwd: this.repo, shell: true, env: { ...process.env, PORT: port }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      this.proc = proc;
      let tail = "";
      const keep = (b: Buffer) => (tail = (tail + b.toString()).slice(-2000));
      proc.stdout?.on("data", keep);
      proc.stderr?.on("data", keep);
      proc.on("exit", (code) => {
        if (this.proc === proc) this.proc = undefined;
        if (code) this.log(`App exited with code ${code}:\n${tail.trim().split("\n").slice(-12).join("\n")}`, "error");
      });
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await this.isUp()) return;
      if (!this.proc) throw new Error("The app exited before it started answering. See the agent log.");
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`The app didn't answer on ${this.url} within 60s.`);
  }

  /** Kills the whole process group (the shell and e.g. the Rails server under it). */
  async stop() {
    const pid = this.proc?.pid;
    this.proc = undefined;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    // Wait until the port is free, so whatever starts next isn't mistaken for this app.
    for (let i = 0; i < 20 && (await this.isUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }

  /** Synchronous kill for process exit. */
  killNow() {
    const pid = this.proc?.pid;
    this.proc = undefined;
    if (pid)
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
  }
}
