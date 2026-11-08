import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { Element, ElementAgentState } from "../shared/model";
import { MAX_ATTRS } from "./layout";

export type ElementNodeData = { el: Element; st?: ElementAgentState };
export type ElementNodeType = Node<ElementNodeData, "element">;

export const TYPE_META: Record<Element["type"], { label: string; glyph: string }> = {
  entity: { label: "Entity", glyph: "▤" },
  service: { label: "Service", glyph: "⚙" },
  external: { label: "External", glyph: "☁" },
  screen: { label: "Screen", glyph: "▢" },
};

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending: "Pending",
  implementing: "Implementing…",
  done: "Implemented",
  question: "Question",
  error: "Failed",
};

export function ElementNode({ data, selected }: NodeProps<ElementNodeType>) {
  const { el, st } = data;
  const status = el.ready ? (st?.status ?? "pending") : "draft";
  return (
    <div className={`node node--${el.type} node--${status}${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node__head">
        <span className="node__glyph" aria-hidden>{TYPE_META[el.type].glyph}</span>
        <span className="node__type">{TYPE_META[el.type].label}</span>
        <span className={`chip chip--${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      <div className="node__name">{el.name || <em>Unnamed</em>}</div>
      {el.description && <div className="node__desc">{el.description}</div>}
      {el.attributes.length > 0 && (
        <ul className="node__attrs">
          {el.attributes.slice(0, el.attributes.length > MAX_ATTRS + 1 ? MAX_ATTRS : undefined).map((a) => (
            <li key={a.name}>
              <span>{a.name}</span>
              <span className="node__attr-type">{a.type}</span>
            </li>
          ))}
          {el.attributes.length > MAX_ATTRS + 1 && <li className="node__more">+{el.attributes.length - MAX_ATTRS} more</li>}
        </ul>
      )}
      {status === "question" && st?.question && <div className="node__question">❓ {st.question}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export type LaneNodeType = Node<{ label: string; type: Element["type"] }, "lane">;

/** Heading above a column of boxes of one type. Not selectable or draggable. */
export function LaneNode({ data }: NodeProps<LaneNodeType>) {
  return (
    <div className={`lane lane--${data.type}`}>
      <span aria-hidden>{TYPE_META[data.type].glyph}</span> {data.label}
    </div>
  );
}
