import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ELEMENT_TYPES,
  RELATION_KINDS,
  type AgentState,
  type ArchitectureModel,
  type Element,
  type ElementType,
  type Layout,
  type ProjectContext,
} from "../shared/model";

// Reverse direction: read an existing codebase and draw the diagram for it.

const IGNORED = new Set([".git", ".blueprint", "architecture.yaml", ".DS_Store"]);

/** True if the folder holds anything besides git and blueprint's own files. */
export async function hasCode(repo: string): Promise<boolean> {
  const entries = await readdir(repo).catch(() => []);
  return entries.some((e) => !IGNORED.has(e));
}

export const DISCOVER_SYSTEM = `
# Blueprint mapping mode
You are reading an existing codebase so that "blueprint" can show its architecture as a diagram.
The user will keep designing on that diagram, and another agent will implement their changes, so the
diagram must describe what the code actually does today. You only read; never change files.

Element types:
- entity: persisted domain models (database tables, documents, records). List their main attributes as name: type.
- service: application/domain logic objects (service objects, jobs, use cases, domain modules).
- external: third-party systems the code talks to (APIs, payment providers, mail, storage, auth providers).
- screen: user-facing pages or views. Group the CRUD pages of one resource into one screen. For an API-only app,
  skip screens.
Relation kinds: has_many / has_one / belongs_to between entities; calls / uses between services, externals and
entities; shows from a screen to what it displays.

Guidelines:
- Cover the whole app, but at architecture level: skip framework boilerplate, helpers, concerns, migrations, tests.
  Aim for what an architect would draw, usually 5 to 40 elements.
- Descriptions are 1 to 3 sentences on responsibilities and rules, written as a design (what it does), not a code tour.
- For each element give the main files (repo-relative) and, for screens, the URL path.
- Fill in the project context (name, purpose, stack, conventions) from README, manifests and code.
- When done, call mcp__blueprint__set_architecture exactly once with everything.
`;

export const DISCOVER_PROMPT =
  "Map this repository onto a blueprint architecture diagram, then call mcp__blueprint__set_architecture.";

export const architectureSchema = {
  context: z.object({
    name: z.string(),
    purpose: z.string(),
    stack: z.string(),
    constraints: z.string().describe("Notable conventions, e.g. 'service objects in app/services'"),
  }),
  elements: z.array(
    z.object({
      key: z.string().describe("Short unique key, used in relations"),
      type: z.enum(ELEMENT_TYPES),
      name: z.string(),
      description: z.string(),
      attributes: z.array(z.object({ name: z.string(), type: z.string() })).optional().describe("Entities only"),
      files: z.array(z.string()).optional().describe("Main files, repo-relative"),
      path: z.string().optional().describe("Screens only: URL path, e.g. /recipes"),
    }),
  ),
  relations: z.array(
    z.object({ from: z.string(), to: z.string(), kind: z.enum(RELATION_KINDS), label: z.string().optional() }),
  ),
};

type Discovered = {
  context: ProjectContext;
  elements: { key: string; type: ElementType; name: string; description: string; attributes?: Element["attributes"]; files?: string[]; path?: string }[];
  relations: { from: string; to: string; kind: (typeof RELATION_KINDS)[number]; label?: string }[];
};

/**
 * Adds the discovered design to `current` (normally empty) and returns the new model, layout and state.
 * Everything discovered is ready and already implemented.
 */
export function applyDiscovery(
  current: ArchitectureModel,
  layout: Layout,
  state: AgentState,
  found: Discovered,
): { model: ArchitectureModel; layout: Layout; state: AgentState } {
  const ids = new Map<string, string>();
  const elements: Element[] = found.elements.map((e) => {
    const id = `${e.type.slice(0, 3)}_${randomUUID().slice(0, 6)}`;
    ids.set(e.key, id);
    return { id, type: e.type, name: e.name, description: e.description, attributes: e.type === "entity" ? e.attributes ?? [] : [], ready: true };
  });
  const relations = found.relations
    .filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to)
    .map((r) => ({ id: `rel_${randomUUID().slice(0, 6)}`, from: ids.get(r.from)!, to: ids.get(r.to)!, kind: r.kind, ...(r.label && { label: r.label }) }));

  // No positions for the new boxes: the canvas measures them and arranges them as a graph (web/layout.ts).

  const nextState: AgentState = { elements: { ...state.elements } };
  for (const e of found.elements) {
    const p = e.path?.trim() ? "/" + e.path.trim().replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "") : undefined;
    nextState.elements[ids.get(e.key)!] = {
      status: "done",
      summary: "Found in the existing code.",
      ...(e.files?.length && { files: e.files }),
      ...(e.type === "screen" && p && { path: p }),
    };
  }

  // Context fields the user already filled in win.
  const ctx = { ...current.context };
  for (const k of ["name", "purpose", "stack", "constraints"] as const) if (!ctx[k].trim()) ctx[k] = found.context[k]?.trim() ?? "";

  return {
    model: { context: ctx, elements: [...current.elements, ...elements], relations: [...current.relations, ...relations] },
    layout,
    state: nextState,
  };
}
