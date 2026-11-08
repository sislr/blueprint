// The architecture model. This is what lives in `architecture.yaml` in the target repo.
// Layout (x/y) and agent state are stored separately so that moving a box or an agent
// status update never counts as an architecture change.

export const ELEMENT_TYPES = ["entity", "service", "external", "screen"] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const RELATION_KINDS = ["has_many", "has_one", "belongs_to", "calls", "uses", "shows"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export interface Attribute {
  name: string;
  type: string;
}

export interface Element {
  id: string;
  type: ElementType;
  name: string;
  description: string;
  attributes: Attribute[];
  /** Draft elements are ignored by the agent. Mark ready once you're happy with the design. */
  ready: boolean;
}

export interface Relation {
  id: string;
  from: string;
  to: string;
  kind: RelationKind;
  label?: string;
}

export interface ProjectContext {
  name: string;
  purpose: string;
  stack: string;
  constraints: string;
}

export interface ArchitectureModel {
  context: ProjectContext;
  elements: Element[];
  relations: Relation[];
}

export type Layout = Record<string, { x: number; y: number }>;

export type ElementStatus = "draft" | "pending" | "implementing" | "done" | "question" | "error";

export interface ElementAgentState {
  status: ElementStatus;
  summary?: string;
  files?: string[];
  /** Screens only: URL path where the screen can be viewed in the running app, e.g. "/recipes". */
  path?: string;
  question?: string;
}

export interface AgentState {
  elements: Record<string, ElementAgentState>;
}

export type RunStatus = "idle" | "waiting" | "running" | "error";

export const emptyModel = (): ArchitectureModel => ({
  context: { name: "", purpose: "", stack: "", constraints: "" },
  elements: [],
  relations: [],
});

/** The part of the model the agent is allowed to see: ready elements and relations between them. */
export function readySubset(model: ArchitectureModel): ArchitectureModel {
  const elements = model.elements.filter((e) => e.ready && e.name.trim());
  const ids = new Set(elements.map((e) => e.id));
  return {
    context: model.context,
    elements,
    relations: model.relations.filter((r) => ids.has(r.from) && ids.has(r.to)),
  };
}

export function contextIsComplete(c: ProjectContext): boolean {
  return Boolean(c.name.trim() && c.purpose.trim() && c.stack.trim());
}
