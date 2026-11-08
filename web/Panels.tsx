import { useEffect, useRef, useState } from "react";
import {
  ELEMENT_TYPES,
  RELATION_KINDS,
  type Attribute,
  type Element,
  type ElementAgentState,
  type ProjectContext,
  type Relation,
} from "../shared/model";
import type { AgentInfo, LogLine } from "./api";
import { STATUS_LABEL, TYPE_META } from "./ElementNode";

const parseAttributes = (text: string): Attribute[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, type] = l.split(":").map((s) => s.trim());
      return { name, type: type || "string" };
    })
    .filter((a, i, all) => a.name && all.findIndex((b) => b.name === a.name) === i);

const formatAttributes = (attrs: Attribute[]) => attrs.map((a) => `${a.name}: ${a.type}`).join("\n");

export function ContextPanel({ context, onChange }: { context: ProjectContext; onChange: (c: ProjectContext) => void }) {
  const field = (key: keyof ProjectContext) => ({
    value: context[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...context, [key]: e.target.value }),
  });
  return (
    <div className="panel">
      <h2>Project context</h2>
      <p className="hint">
        The agent reads this before every run. Fill in name, purpose and stack before you start drawing.
      </p>
      <label>
        Name
        <input {...field("name")} placeholder="Recipe Box" />
      </label>
      <label>
        Purpose
        <textarea {...field("purpose")} rows={4} placeholder="What problem does it solve, and for whom?" />
      </label>
      <label>
        Stack
        <input {...field("stack")} placeholder="Rails 8, SQLite, Hotwire, Minitest" />
      </label>
      <label>
        Constraints &amp; conventions
        <textarea
          {...field("constraints")}
          rows={5}
          placeholder={"e.g. no JS framework\nservice objects in app/services\nGerman UI"}
        />
      </label>
    </div>
  );
}

export function ElementInspector({
  el,
  st,
  onChange,
  onDelete,
  onOpenFile,
  onOpenInApp,
}: {
  el: Element;
  st?: ElementAgentState;
  onChange: (el: Element) => void;
  onDelete: () => void;
  onOpenFile: (path: string) => void;
  onOpenInApp: (path: string) => void;
}) {
  const [attrText, setAttrText] = useState(formatAttributes(el.attributes));
  const [answer, setAnswer] = useState("");
  const status = el.ready ? (st?.status ?? "pending") : "draft";

  const submitAnswer = () => {
    if (!answer.trim() || !st?.question) return;
    const qa = `Q: ${st.question}\nA: ${answer.trim()}`;
    onChange({ ...el, description: el.description.trim() ? `${el.description.trim()}\n\n${qa}` : qa });
    setAnswer("");
  };

  return (
    <div className="panel">
      <div className="panel__row">
        <h2>{TYPE_META[el.type].label}</h2>
        <span className={`chip chip--${status}`}>{STATUS_LABEL[status]}</span>
      </div>

      {status === "question" && st?.question && (
        <div className="callout callout--question">
          <strong>The agent asks:</strong>
          <p>{st.question}</p>
          <textarea
            rows={3}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your answer gets added to the description"
          />
          <button className="btn btn--primary" onClick={submitAnswer} disabled={!answer.trim()}>
            Answer
          </button>
        </div>
      )}

      <label>
        Name
        <input value={el.name} onChange={(e) => onChange({ ...el, name: e.target.value })} autoFocus={!el.name} />
      </label>
      <label>
        Type
        <select value={el.type} onChange={(e) => onChange({ ...el, type: e.target.value as Element["type"] })}>
          {ELEMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_META[t].label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Description
        <textarea
          rows={6}
          value={el.description}
          onChange={(e) => onChange({ ...el, description: e.target.value })}
          placeholder="Responsibilities, rules, behaviour. The agent implements what you write here."
        />
      </label>
      {(el.type === "entity" || el.attributes.length > 0) && (
        <label>
          Attributes <span className="hint">one per line, name: type</span>
          <textarea
            className="mono"
            rows={5}
            value={attrText}
            onChange={(e) => {
              setAttrText(e.target.value);
              onChange({ ...el, attributes: parseAttributes(e.target.value) });
            }}
            placeholder={"title: string\nservings: integer"}
          />
        </label>
      )}

      <label className="toggle">
        <input type="checkbox" checked={el.ready} onChange={(e) => onChange({ ...el, ready: e.target.checked })} />
        <span>
          <strong>Ready to implement</strong>
          <span className="hint">Drafts are ignored by the agent.</span>
        </span>
      </label>

      {st?.summary && (
        <div className="callout">
          <strong>In code</strong>
          <p>{st.summary}</p>
          {el.type === "screen" && st.path && (
            <button className="btn callout__btn" onClick={() => onOpenInApp(st.path!)}>
              Open in app ↗ <span className="mono hint">{st.path}</span>
            </button>
          )}
          {st.files && st.files.length > 0 && (
            <ul className="files">
              {st.files.map((f) => (
                <li key={f}>
                  <button className="link" onClick={() => onOpenFile(f)} title="Show what changed in this file">
                    {f}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button className="btn btn--danger" onClick={onDelete}>
        Delete box
      </button>
    </div>
  );
}

export function RelationInspector({
  rel,
  names,
  onChange,
  onDelete,
}: {
  rel: Relation;
  names: Map<string, string>;
  onChange: (r: Relation) => void;
  onDelete: () => void;
}) {
  return (
    <div className="panel">
      <h2>Relation</h2>
      <p className="relation-line">
        <strong>{names.get(rel.from) || "?"}</strong> → <strong>{names.get(rel.to) || "?"}</strong>
      </p>
      <label>
        Kind
        <select value={rel.kind} onChange={(e) => onChange({ ...rel, kind: e.target.value as Relation["kind"] })}>
          {RELATION_KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label>
        Label <span className="hint">optional</span>
        <input value={rel.label ?? ""} onChange={(e) => onChange({ ...rel, label: e.target.value || undefined })} />
      </label>
      <div className="panel__row">
        <button className="btn" onClick={() => onChange({ ...rel, from: rel.to, to: rel.from })}>
          Swap direction
        </button>
        <button className="btn btn--danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

export function AgentPanel({
  agent,
  logs,
  open,
  onToggle,
}: {
  agent: AgentInfo;
  logs: LogLine[];
  open: boolean;
  onToggle: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [logs.length, open]);

  return (
    <section className={`agent${open ? " is-open" : ""}`}>
      <button className="agent__bar" onClick={onToggle}>
        <span>Agent log</span>
        <span className="hint">
          {agent.pending.length ? `${agent.pending.length} pending change(s)` : "in sync with the diagram"}
        </span>
        <span aria-hidden>{open ? "▾" : "▴"}</span>
      </button>
      {open && (
        <div className="agent__body">
          {agent.pending.length > 0 && (
            <div className="agent__pending">
              <strong>Not implemented yet</strong>
              <ul>
                {agent.pending.map((c, i) => (
                  <li key={i}>{c.text}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="agent__log">
            {logs.length === 0 && <p className="hint">Nothing yet. Mark a box as ready to start.</p>}
            {logs.map((l, i) => (
              <div key={i} className={`log log--${l.kind}`}>
                {l.text}
              </div>
            ))}
            <div ref={end} />
          </div>
        </div>
      )}
    </section>
  );
}
