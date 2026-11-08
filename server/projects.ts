import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { emptyModel, type RunStatus } from "../shared/model";
import { AgentRunner, type ServerEvent } from "./agent";
import { AppRunner } from "./app";
import { hasCode } from "./discover";
import { History } from "./history";
import { Store } from "./store";

const exec = promisify(execFile);

/** Global (not per-project) settings, in ~/.blueprint/config.json. */
export interface Config {
  /** Where new projects are created, and where existing ones are discovered. */
  projectsDir: string;
  /** Projects added from elsewhere on disk, plus everything ever opened. */
  projects: string[];
  lastOpened?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  /** Agent status, if the project has been opened since the server started. */
  status?: RunStatus;
  missing?: boolean;
  /** False for folders found in the projects directory: they'd show up again anyway. */
  removable: boolean;
}

/** A project's server-side pieces. Created lazily on first open and kept alive, so agents keep running in the background. */
export interface Workspace {
  id: string;
  repo: string;
  store: Store;
  agent: AgentRunner;
  history: History;
  app: AppRunner;
}

export type ProjectEvent = ServerEvent & { project: string };
export type GlobalEvent = { type: "projects"; projects: ProjectSummary[] };

const HOME = process.env.BLUEPRINT_HOME ?? path.join(os.homedir(), ".blueprint");
const CONFIG = path.join(HOME, "config.json");

export const projectId = (repo: string) => createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 10);
export const expandHome = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
const tildify = (p: string) => (p.startsWith(os.homedir() + path.sep) ? "~" + p.slice(os.homedir().length) : p);

const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export class Projects {
  private config!: Config;
  private workspaces = new Map<string, Workspace>();

  constructor(private emit: (e: ProjectEvent | GlobalEvent) => void) {}

  async init(initial?: string) {
    this.config = await this.readConfig();
    if (initial) {
      await this.register(initial);
      this.config.lastOpened = path.resolve(initial);
      await this.saveConfig();
    }
  }

  private async readConfig(): Promise<Config> {
    const defaults: Config = { projectsDir: path.join(os.homedir(), "Blueprint"), projects: [] };
    if (!existsSync(CONFIG)) return defaults;
    try {
      return { ...defaults, ...JSON.parse(await readFile(CONFIG, "utf8")) };
    } catch {
      return defaults;
    }
  }

  private async saveConfig() {
    await mkdir(HOME, { recursive: true });
    await writeFile(CONFIG, JSON.stringify(this.config, null, 2));
  }

  settings = () => ({ projectsDir: tildify(this.config.projectsDir), configPath: tildify(CONFIG) });

  async setProjectsDir(dir: string) {
    if (!dir.trim()) throw new Error("Enter a directory");
    this.config.projectsDir = expandHome(dir.trim());
    await this.saveConfig();
    await this.broadcastList();
  }

  /** Registered projects, plus every folder in the projects directory that has an architecture.yaml. */
  async list(): Promise<ProjectSummary[]> {
    const paths = new Set(this.config.projects.map((p) => path.resolve(p)));
    const dir = this.config.projectsDir;
    if (existsSync(dir)) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory() && existsSync(path.join(p, "architecture.yaml"))) paths.add(p);
      }
    }
    const list = await Promise.all([...paths].map((p) => this.summary(p)));
    return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  private async summary(repo: string): Promise<ProjectSummary> {
    const id = projectId(repo);
    let name = path.basename(repo);
    const missing = !existsSync(repo);
    try {
      const yaml = YAML.parse(await readFile(path.join(repo, "architecture.yaml"), "utf8"));
      if (yaml?.context?.name?.trim()) name = yaml.context.name.trim();
    } catch {}
    const inDir = path.dirname(repo) === path.resolve(this.config.projectsDir);
    return {
      id,
      name,
      path: tildify(repo),
      status: this.workspaces.get(id)?.agent.status,
      removable: !inDir,
      ...(missing && { missing }),
    };
  }

  async initialId(): Promise<string | undefined> {
    const list = await this.list();
    const last = this.config.lastOpened && projectId(this.config.lastOpened);
    return list.find((p) => p.id === last && !p.missing)?.id ?? list.find((p) => !p.missing)?.id;
  }

  private async register(repo: string) {
    const abs = path.resolve(repo);
    if (!this.config.projects.includes(abs)) {
      this.config.projects.push(abs);
      await this.saveConfig();
    }
  }

  /** Creates <projectsDir>/<slug>, a git repo with an architecture.yaml carrying the name. */
  async create(name: string): Promise<ProjectSummary> {
    const slug = slugify(name);
    if (!slug) throw new Error("Give the project a name");
    const repo = path.join(this.config.projectsDir, slug);
    if (existsSync(repo) && (await readdir(repo)).length) throw new Error(`${tildify(repo)} already exists and isn't empty`);
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", "-q"], { cwd: repo }).catch(() => {});
    const model = emptyModel();
    model.context.name = name.trim();
    await new Store(repo).saveModel(model);
    await this.register(repo);
    await this.broadcastList();
    return this.summary(repo);
  }

  /** Adds an existing folder (any repo you want the agent to work in). */
  async addExisting(dir: string): Promise<ProjectSummary> {
    const repo = expandHome(dir.trim());
    if (!existsSync(repo)) throw new Error(`${tildify(repo)} doesn't exist`);
    await this.register(repo);
    await this.broadcastList();
    const summary = await this.summary(repo);
    // Code but no diagram yet: draw the diagram from the code, so the sheet shows the whole app.
    if (!existsSync(path.join(repo, "architecture.yaml")) && (await hasCode(repo))) {
      const ws = await this.open(summary.id);
      void ws.agent.discover();
    }
    return summary;
  }

  /** Forgets a registered project. Files on disk are left alone. */
  async remove(id: string) {
    const ws = this.workspaces.get(id);
    if (ws?.agent.status === "running") throw new Error("Stop the agent first");
    await ws?.app.stop();
    this.workspaces.delete(id);
    this.config.projects = this.config.projects.filter((p) => projectId(p) !== id);
    await this.saveConfig();
    await this.broadcastList();
  }

  async open(id: string): Promise<Workspace> {
    const existing = this.workspaces.get(id);
    if (existing) return existing;
    const summary = (await this.list()).find((p) => p.id === id);
    if (!summary || summary.missing) throw new Error("Unknown project");
    const repo = expandHome(summary.path);

    const store = new Store(repo);
    await store.init();
    const emit = (e: ServerEvent) => {
      this.emit({ ...e, project: id });
      if (e.type === "agent") void this.broadcastList();
    };
    const agent = new AgentRunner(store, emit);
    const ws: Workspace = {
      id,
      repo,
      store,
      agent,
      history: new History(repo),
      app: new AppRunner(repo, (text, kind) => agent.log(text, kind)),
    };
    this.workspaces.set(id, ws);
    if (this.config.lastOpened !== repo) {
      this.config.lastOpened = repo;
      await this.saveConfig();
    }
    return ws;
  }

  /** Starts this project's app, stopping another project's app that blueprint runs on the same URL. */
  async startApp(ws: Workspace) {
    for (const other of this.workspaces.values())
      if (other !== ws && other.app.managed && other.app.url === ws.app.url) await other.app.stop();
    await ws.app.ensureRunning();
  }

  stopAll() {
    for (const ws of this.workspaces.values()) ws.app.killNow();
  }

  private async broadcastList() {
    this.emit({ type: "projects", projects: await this.list() });
  }
}
