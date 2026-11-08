import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { emptyModel, type AgentState, type ArchitectureModel, type Layout } from "../shared/model";

/**
 * File layout inside the target repo:
 *   architecture.yaml            the design (source of truth, edited via the canvas)
 *   .blueprint/layout.json       box positions
 *   .blueprint/state.json        per-element agent status, files, questions
 *   .blueprint/implemented.yaml  the ready-subset the agent last implemented successfully
 */
export class Store {
  readonly dir: string;
  constructor(readonly repo: string) {
    this.dir = path.join(repo, ".blueprint");
  }

  private p = (name: string) => path.join(this.dir, name);
  private modelPath = () => path.join(this.repo, "architecture.yaml");

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  private async readYaml(file: string): Promise<ArchitectureModel> {
    if (!existsSync(file)) return emptyModel();
    const parsed = YAML.parse(await readFile(file, "utf8")) ?? {};
    const base = emptyModel();
    return {
      context: { ...base.context, ...parsed.context },
      elements: (parsed.elements ?? []).map((e: any) => ({ attributes: [], description: "", ready: false, ...e })),
      relations: parsed.relations ?? [],
    };
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    if (!existsSync(file)) return fallback;
    return JSON.parse(await readFile(file, "utf8"));
  }

  model = () => this.readYaml(this.modelPath());
  saveModel = (m: ArchitectureModel) =>
    writeFile(this.modelPath(), "# Edited via blueprint. Agent implements elements marked ready: true\n" + YAML.stringify(m));

  implemented = () => this.readYaml(this.p("implemented.yaml"));
  saveImplemented = (m: ArchitectureModel) => writeFile(this.p("implemented.yaml"), YAML.stringify(m));

  layout = () => this.readJson<Layout>(this.p("layout.json"), {});
  saveLayout = (l: Layout) => writeFile(this.p("layout.json"), JSON.stringify(l, null, 2));

  agentState = () => this.readJson<AgentState>(this.p("state.json"), { elements: {} });
  saveAgentState = (s: AgentState) => writeFile(this.p("state.json"), JSON.stringify(s, null, 2));
}
