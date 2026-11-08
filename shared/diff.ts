import type { ArchitectureModel, Attribute, Element, ProjectContext, Relation } from "./model";

export interface Change {
  /** Element ids affected, so the UI and agent can attribute work to boxes. */
  elementIds: string[];
  text: string;
}

const attrKey = (a: Attribute) => `${a.name}:${a.type}`;

function diffContext(a: ProjectContext, b: ProjectContext): Change[] {
  return (Object.keys(b) as (keyof ProjectContext)[])
    .filter((k) => a[k].trim() !== b[k].trim())
    .map((k) => ({ elementIds: [], text: `Project ${k} changed to: ${JSON.stringify(b[k].trim())}` }));
}

function diffElement(a: Element, b: Element): Change[] {
  const ids = [b.id];
  const out: Change[] = [];
  const label = `${b.type} "${b.name}"`;
  if (a.name !== b.name) out.push({ elementIds: ids, text: `${a.type} "${a.name}" renamed to "${b.name}"` });
  if (a.type !== b.type) out.push({ elementIds: ids, text: `${label} changed type from ${a.type} to ${b.type}` });
  if (a.description.trim() !== b.description.trim())
    out.push({ elementIds: ids, text: `${label} description changed to: ${JSON.stringify(b.description.trim())}` });

  const before = new Map(a.attributes.map((x) => [x.name, x]));
  const after = new Map(b.attributes.map((x) => [x.name, x]));
  for (const [name, attr] of after) {
    const old = before.get(name);
    if (!old) out.push({ elementIds: ids, text: `${label}: attribute added ${attrKey(attr)}` });
    else if (old.type !== attr.type)
      out.push({ elementIds: ids, text: `${label}: attribute ${name} type changed ${old.type} -> ${attr.type}` });
  }
  for (const name of before.keys())
    if (!after.has(name)) out.push({ elementIds: ids, text: `${label}: attribute removed ${name}` });
  return out;
}

function describeRelation(r: Relation, names: Map<string, string>): string {
  const label = r.label ? ` (${r.label})` : "";
  return `"${names.get(r.from)}" ${r.kind} "${names.get(r.to)}"${label}`;
}

/**
 * Semantic diff between two models. Coordinates are not part of the model, so moving boxes
 * never produces changes. Both inputs should already be reduced with `readySubset`.
 */
export function diffModels(prev: ArchitectureModel, next: ArchitectureModel): Change[] {
  // On the very first run there is nothing to compare the context against; it's in the prompt anyway.
  const firstRun = prev.elements.length === 0 && !Object.values(prev.context).some((v) => v.trim());
  const changes: Change[] = firstRun ? [] : diffContext(prev.context, next.context);

  const prevEls = new Map(prev.elements.map((e) => [e.id, e]));
  const nextEls = new Map(next.elements.map((e) => [e.id, e]));
  const names = new Map([...prev.elements, ...next.elements].map((e) => [e.id, e.name]));

  for (const el of next.elements) {
    const old = prevEls.get(el.id);
    if (!old) {
      const attrs = el.attributes.length ? ` with attributes ${el.attributes.map(attrKey).join(", ")}` : "";
      changes.push({
        elementIds: [el.id],
        text: `New ${el.type} "${el.name}"${attrs}. Description: ${JSON.stringify(el.description.trim())}`,
      });
    } else changes.push(...diffElement(old, el));
  }
  for (const el of prev.elements)
    if (!nextEls.has(el.id)) changes.push({ elementIds: [], text: `${el.type} "${el.name}" was removed` });

  const prevRels = new Map(prev.relations.map((r) => [r.id, r]));
  const nextRels = new Map(next.relations.map((r) => [r.id, r]));
  for (const r of next.relations) {
    const old = prevRels.get(r.id);
    if (!old) changes.push({ elementIds: [r.from, r.to], text: `New relation: ${describeRelation(r, names)}` });
    else if (old.kind !== r.kind || old.from !== r.from || old.to !== r.to || (old.label ?? "") !== (r.label ?? ""))
      changes.push({
        elementIds: [r.from, r.to],
        text: `Relation changed: ${describeRelation(old, names)} -> ${describeRelation(r, names)}`,
      });
  }
  for (const r of prev.relations)
    if (!nextRels.has(r.id))
      changes.push({ elementIds: [r.from, r.to].filter((id) => nextEls.has(id)), text: `Relation removed: ${describeRelation(r, names)}` });

  return changes;
}
