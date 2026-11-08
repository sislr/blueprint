import ELK from "elkjs/lib/elk.bundled.js";
import type { Element, ElementType, Layout, Relation } from "../shared/model";

/** Left to right: what the user sees → logic → data → the outside world. */
export const LANES: { type: ElementType; label: string }[] = [
  { type: "screen", label: "Screens" },
  { type: "service", label: "Services" },
  { type: "entity", label: "Data model" },
  { type: "external", label: "External services" },
];
const LANE_INDEX = Object.fromEntries(LANES.map((l, i) => [l.type, i])) as Record<ElementType, number>;

/**
 * `belongs_to` relations whose inverse `has_many`/`has_one` also exists, mapped to that inverse.
 * Both describe the same association, so the sheet draws them as one line.
 */
export function inversePairs(relations: Relation[]): Map<string, string> {
  const parents = new Map(
    relations.filter((r) => r.kind === "has_many" || r.kind === "has_one").map((r) => [`${r.from}>${r.to}`, r.id]),
  );
  const out = new Map<string, string>();
  for (const r of relations) {
    const twin = r.kind === "belongs_to" && parents.get(`${r.to}>${r.from}`);
    if (twin) out.set(r.id, twin);
  }
  return out;
}

export type Size = { width: number; height: number };

const elk = new ELK();

/**
 * Arranges boxes as a layered graph: one lane per element type (screens → services → data model → externals),
 * ordered within each lane so that connected boxes sit next to each other and lines cross as little as possible.
 * Inside the data model, parents come before their children (Project → Coordinate).
 */
export async function autoLayout(
  elements: Element[],
  relations: Relation[],
  sizeOf: (id: string) => Size,
  origin = { x: 80, y: 80 },
): Promise<Layout> {
  if (!elements.length) return {};
  const ids = new Set(elements.map((e) => e.id));
  const seen = new Set<string>();
  const edges = [];
  for (const r of relations) {
    if (!ids.has(r.from) || !ids.has(r.to) || r.from === r.to) continue;
    // A child belongs to its parent: lay it out after the parent, like the has_many it mirrors.
    const [source, target] = r.kind === "belongs_to" ? [r.to, r.from] : [r.from, r.to];
    const key = `${source}>${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: r.id, sources: [source], targets: [target] });
  }

  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      // Keep unconnected boxes (e.g. a monitoring service nothing points at) in their lane too.
      "elk.separateConnectedComponents": "false",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "36",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: elements.map((e) => ({
      id: e.id,
      ...sizeOf(e.id),
      layoutOptions: { "elk.partitioning.partition": String(LANE_INDEX[e.type]) },
    })),
    edges,
  });

  const out: Layout = {};
  for (const n of graph.children ?? [])
    out[n.id] = { x: Math.round(origin.x + (n.x ?? 0)), y: Math.round(origin.y + (n.y ?? 0)) };
  return out;
}

/** Rough box height before React Flow has measured it, mirroring ElementNode's markup. */
export function estimateSize(el: Element): Size {
  const descLines = el.description ? Math.min(3, Math.ceil(el.description.length / 34)) : 0;
  const attrs = Math.min(el.attributes.length, MAX_ATTRS + 1);
  return { width: 230, height: 70 + descLines * 18 + (attrs ? 14 + attrs * 18 : 0) };
}

/** Attributes shown on a box; the rest are summarised as "+N more" (all of them are in the inspector). */
export const MAX_ATTRS = 6;
