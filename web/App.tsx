import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ELEMENT_TYPES,
  contextIsComplete,
  type AgentState,
  type ArchitectureModel,
  type Element,
  type ElementType,
  type Layout,
  type Relation,
  type RelationKind,
} from "../shared/model";
import { projectApi, projectsApi, subscribe, type AgentInfo, type LogLine, type ProjectApi, type ProjectSummary, type Settings } from "./api";
import { ElementNode, LaneNode, TYPE_META, type ElementNodeType, type LaneNodeType } from "./ElementNode";
import { LANES, autoLayout, estimateSize, inversePairs } from "./layout";
import { AgentPanel, ContextPanel, ElementInspector, RelationInspector } from "./Panels";
import { ChangesView } from "./Changes";
import { ProjectsSidebar } from "./Projects";

const nodeTypes = { element: ElementNode, lane: LaneNode };
type SheetNode = ElementNodeType | LaneNodeType;

const ASSOCIATIONS = new Set<RelationKind>(["has_many", "has_one", "belongs_to"]);
const edgeKindClass = (k: RelationKind) => (ASSOCIATIONS.has(k) ? "edge--assoc" : k === "shows" ? "edge--shows" : "edge--flow");
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 6)}`;

function defaultKind(from?: Element, to?: Element): RelationKind {
  if (from?.type === "screen") return "shows";
  if (from?.type === "entity" && to?.type === "entity") return "has_many";
  if (to?.type === "external" || to?.type === "service") return "calls";
  return "uses";
}

/** Debounced side effect. A pending call still runs on unmount, so switching projects never drops an edit. */
function useDebouncedEffect(fn: () => void, deps: unknown[], ms: number) {
  const first = useRef(true);
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    pending.current = fn;
    const t = setTimeout(() => {
      pending.current = null;
      fn();
    }, ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => () => pending.current?.(), []);
}

type Selection = { kind: "element" | "relation"; id: string } | null;
type Snapshot = { model: ArchitectureModel; layout: Layout };

/** Edits with the same key within this window form one undo step (typing, dragging). */
const COALESCE_MS = 800;
const HISTORY_LIMIT = 100;

const isTextField = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

function Canvas({
  projectId,
  api,
  navOpen,
  onToggleNav,
  onNameChange,
}: {
  projectId: string;
  api: ProjectApi;
  navOpen: boolean;
  onToggleNav: () => void;
  onNameChange: (name: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [repo, setRepo] = useState("");
  const [model, setModel] = useState<ArchitectureModel | null>(null);
  const [layout, setLayout] = useState<Layout>({});
  const [agentState, setAgentState] = useState<AgentState>({ elements: {} });
  const [agent, setAgent] = useState<AgentInfo>({ status: "idle", auto: true, pending: [] });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [logOpen, setLogOpen] = useState(true);
  const [changes, setChanges] = useState<{ open: boolean; file?: string }>({ open: false });
  const [historyKey, setHistoryKey] = useState(0);
  const [appStarting, setAppStarting] = useState(false);
  const [appError, setAppError] = useState<string>();
  const [appMenu, setAppMenu] = useState(false);
  const [hasCode, setHasCode] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [hoveredEdge, setHoveredEdge] = useState<string>();
  // Undo history of the sheet (model + layout). Bumping `rev` remounts the inspector after undo/redo.
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastEdit = useRef<{ key?: string; at: number }>({ at: 0 });
  const [rev, setRev] = useState(0);
  const current = useRef<Snapshot | null>(null);
  if (model) current.current = { model, layout };
  const flow = useReactFlow();

  const load = useCallback(async () => {
    const b = await api.bootstrap();
    setRepo(b.repo);
    setModel(b.model);
    setLayout(b.layout);
    setAgentState(b.state);
    setAgent(b.agent);
    setLogs(b.logs);
    setHasCode(b.hasCode);
    // A fresh copy from the server: earlier steps no longer apply to it.
    past.current = [];
    future.current = [];
    lastEdit.current = { at: 0 };
    setLoaded(true);
  }, [api]);

  useEffect(() => {
    void load();
    return subscribe((e) => {
      if (e.type === "projects" || e.project !== projectId) return;
      if (e.type === "agent") setAgent(e);
      else if (e.type === "state") setAgentState(e.state);
      else if (e.type === "log") setLogs((l) => [...l.slice(-300), e]);
      else if (e.type === "history") setHistoryKey((k) => k + 1);
      // The server drew the diagram (mapped from existing code): reload it and show all of it.
      else if (e.type === "model") void load().then(() => setFitKey((k) => k + 1));
    }, load);
  }, [load, projectId]);

  const name = model?.context.name ?? "";
  useEffect(() => {
    if (loaded && name.trim()) onNameChange(name.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, loaded]);

  useDebouncedEffect(() => model && void api.saveModel(model), [model], 600);
  useDebouncedEffect(() => void api.saveLayout(layout), [layout], 400);

  const openApp = async (urlPath = "/") => {
    setAppMenu(false);
    // Open the tab synchronously so the popup blocker allows it, then point it at the app once it answers.
    const tab = window.open("about:blank", "_blank");
    setAppError(undefined);
    setAppStarting(true);
    try {
      const res = await api.startApp();
      if (!res.ok) throw new Error(res.error);
      const url = res.url + urlPath;
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
    } catch (err) {
      tab?.close();
      setAppError(err instanceof Error ? err.message : String(err));
    } finally {
      setAppStarting(false);
    }
  };

  useEffect(() => {
    if (!fitKey) return;
    // Give React Flow a moment to measure the new nodes.
    const t = setTimeout(() => void flow.fitView({ maxZoom: 1, duration: 400 }), 120);
    return () => clearTimeout(t);
  }, [fitKey, flow]);

  /**
   * Records an undo step before a user edit. Edits sharing a key in quick succession (typing in one box,
   * one drag) are merged; edits without a key (add, delete, connect) are always their own step.
   */
  const checkpoint = (key?: string) => {
    const now = Date.now();
    const merge = key !== undefined && key === lastEdit.current.key && now - lastEdit.current.at < COALESCE_MS;
    lastEdit.current = { key, at: now };
    if (merge || !current.current) return;
    past.current = [...past.current.slice(-(HISTORY_LIMIT - 1)), current.current];
    future.current = [];
  };

  const restore = (from: React.MutableRefObject<Snapshot[]>, to: React.MutableRefObject<Snapshot[]>) => {
    const snap = from.current.at(-1);
    if (!snap || !current.current) return;
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, current.current];
    lastEdit.current = { at: 0 };
    setModel(snap.model);
    setLayout(snap.layout);
    setRev((r) => r + 1);
  };
  const undo = () => restore(past, future);
  const redo = () => restore(future, past);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || isTextField(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) undo();
      else if ((k === "z" && e.shiftKey) || k === "y") redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const update = (fn: (m: ArchitectureModel) => ArchitectureModel, key?: string) => {
    checkpoint(key);
    setModel((m) => (m ? fn(m) : m));
  };

  const addElement = (type: ElementType, position?: { x: number; y: number }) => {
    const id = newId(type.slice(0, 3));
    const pos =
      position ??
      flow.screenToFlowPosition({ x: window.innerWidth / 2 - 280, y: window.innerHeight / 2 - 80 + Math.random() * 60 });
    update((m) => ({
      ...m,
      elements: [...m.elements, { id, type, name: "", description: "", attributes: [], ready: false }],
    }));
    setLayout((l) => ({ ...l, [id]: pos }));
    setSelection({ kind: "element", id });
  };

  const removeElements = (ids: string[]) => {
    const set = new Set(ids);
    update((m) => ({
      ...m,
      elements: m.elements.filter((e) => !set.has(e.id)),
      relations: m.relations.filter((r) => !set.has(r.from) && !set.has(r.to)),
    }));
    setLayout((l) => Object.fromEntries(Object.entries(l).filter(([k]) => !set.has(k))));
    setSelection(null);
  };

  const removeRelations = (ids: string[]) => {
    const set = new Set(ids);
    update((m) => ({ ...m, relations: m.relations.filter((r) => !set.has(r.id)) }));
    setSelection(null);
  };

  /** belongs_to → its has_many/has_one twin. The pair is drawn, selected and deleted as one line. */
  const twins = useMemo(() => inversePairs(model?.relations ?? []), [model]);
  const twinOf = useMemo(() => new Map([...twins].map(([a, b]) => [b, a])), [twins]);

  /** With a box (or line) selected, everything not directly connected to it fades out. */
  const focus = useMemo(() => {
    if (!model || !selection) return null;
    if (selection.kind === "relation") {
      const r = model.relations.find((x) => x.id === selection.id);
      return r ? new Set([r.from, r.to]) : null;
    }
    const set = new Set([selection.id]);
    for (const r of model.relations) {
      if (r.from === selection.id) set.add(r.to);
      if (r.to === selection.id) set.add(r.from);
    }
    return set;
  }, [model, selection]);

  const nodes: SheetNode[] = useMemo(() => {
    const els = model?.elements ?? [];
    const out: SheetNode[] = els.map((el, i) => ({
      id: el.id,
      type: "element",
      position: layout[el.id] ?? { x: 80 + (i % 4) * 280, y: 80 + Math.floor(i / 4) * 220 },
      data: { el, st: agentState.elements[el.id] },
      selected: selection?.kind === "element" && selection.id === el.id,
      className: focus && !focus.has(el.id) ? "is-dimmed" : undefined,
    }));

    // Lane headings, as long as the boxes still form one column per type, left to right.
    const lanes = LANES.map((lane) => {
      const xs = els.filter((e) => e.type === lane.type && layout[e.id]).map((e) => layout[e.id].x);
      return xs.length ? { ...lane, min: Math.min(...xs), max: Math.max(...xs) + 230 } : null;
    }).filter((l) => l !== null);
    const ordered = lanes.every((l, i) => i === 0 || lanes[i - 1].max <= l.min);
    if (ordered && lanes.length > 1) {
      const top = Math.min(...els.filter((e) => layout[e.id]).map((e) => layout[e.id].y)) - 44;
      for (const l of lanes)
        out.push({
          id: `lane:${l.type}`,
          type: "lane",
          position: { x: l.min, y: top },
          data: { label: l.label, type: l.type },
          draggable: false,
          selectable: false,
          deletable: false,
          focusable: false,
          className: "lane-node",
        });
    }
    return out;
  }, [model, layout, agentState, selection, focus]);

  const edges: Edge[] = useMemo(
    () =>
      (model?.relations ?? [])
        .filter((r) => !twins.has(r.id))
        .map((r) => {
          const twin = twinOf.get(r.id);
          const touches = selection?.kind === "element" && (r.from === selection.id || r.to === selection.id);
          const selected = selection?.kind === "relation" && (selection.id === r.id || selection.id === twin);
          const kind = twin ? `${r.kind} ⇄ belongs_to` : r.kind;
          // Labels only where you're looking: they turn a 30-line diagram into a wall of text otherwise.
          const showLabel = selected || touches || hoveredEdge === r.id;
          return {
            id: r.id,
            source: r.from,
            target: r.to,
            label: showLabel ? (r.label ? `${kind} · ${r.label}` : kind) : undefined,
            markerEnd: { type: MarkerType.ArrowClosed },
            selected,
            zIndex: touches || selected ? 1 : 0,
            className: `edge ${edgeKindClass(r.kind)}${focus && !(touches || selected) ? " is-dimmed" : ""}`,
          };
        }),
    [model, selection, twins, twinOf, hoveredEdge, focus],
  );

  const sizeOf = (id: string) => {
    const el = model?.elements.find((e) => e.id === id);
    const est = el ? estimateSize(el) : { width: 230, height: 120 };
    const m = flow.getInternalNode(id)?.measured;
    return { width: m?.width ?? est.width, height: m?.height ?? est.height };
  };

  /** "Tidy up": re-arranges the whole sheet as a graph. One undo step. */
  const tidyUp = async () => {
    if (!model?.elements.length) return;
    const next = await autoLayout(model.elements, model.relations, sizeOf);
    checkpoint();
    setLayout((l) => ({ ...l, ...next }));
    setFitKey((k) => k + 1);
  };

  // Boxes without a position (just mapped from code, or added to the YAML by hand) get arranged once
  // React Flow has measured them. Existing boxes stay where they are; new ones go below them.
  const measured = useNodesInitialized();
  const arranging = useRef(false);
  useEffect(() => {
    if (!measured || !model || arranging.current) return;
    const missing = model.elements.filter((e) => !layout[e.id]);
    if (!missing.length) return;
    const placed = model.elements.filter((e) => layout[e.id]);
    const top = placed.length ? Math.max(...placed.map((e) => layout[e.id].y + sizeOf(e.id).height)) + 140 : 80;
    arranging.current = true;
    void autoLayout(missing, model.relations, sizeOf, { x: 80, y: top })
      .then((next) => {
        setLayout((l) => ({ ...next, ...l }));
        setFitKey((k) => k + 1);
      })
      .finally(() => (arranging.current = false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured, model, layout]);

  const onNodesChange = (changes: NodeChange<SheetNode>[]) => {
    const removed = changes.flatMap((c) => (c.type === "remove" && !c.id.startsWith("lane:") ? [c.id] : []));
    if (removed.length) return removeElements(removed);
    const moved = applyNodeChanges(
      changes.filter((c) => c.type === "position"),
      nodes,
    );
    if (changes.some((c) => c.type === "position")) {
      checkpoint(`move:${changes.map((c) => ("id" in c ? c.id : "")).join(",")}`);
      setLayout((l) => {
        const next = { ...l };
        for (const n of moved) next[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
        return next;
      });
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
    // Deleting a merged line deletes both directions of the association.
    if (removed.length) removeRelations([...removed, ...removed.map((id) => twinOf.get(id)).filter((id) => id !== undefined)]);
  };

  const onConnect = (c: Connection) => {
    if (!model || c.source === c.target) return;
    const byId = new Map(model.elements.map((e) => [e.id, e]));
    const rel: Relation = {
      id: newId("rel"),
      from: c.source,
      to: c.target,
      kind: defaultKind(byId.get(c.source), byId.get(c.target)),
    };
    update((m) => ({ ...m, relations: [...m.relations, rel] }));
    setSelection({ kind: "relation", id: rel.id });
  };

  if (!loaded || !model) return <div className="loading">Loading…</div>;

  const names = new Map(model.elements.map((e) => [e.id, e.name]));
  const selectedEl = selection?.kind === "element" ? model.elements.find((e) => e.id === selection.id) : undefined;
  const selectedRel = selection?.kind === "relation" ? model.relations.find((r) => r.id === selection.id) : undefined;
  const contextReady = contextIsComplete(model.context);
  const screens = model.elements
    .filter((e) => e.type === "screen")
    .map((e) => ({ el: e, path: agentState.elements[e.id]?.path }));
  const builtScreens = screens.filter((s): s is { el: Element; path: string } => !!s.path);

  const statusText =
    agent.status === "running"
      ? agent.reason ?? "Implementing…"
      : agent.status === "waiting"
        ? "Starting soon…"
        : agent.status === "error"
          ? "Last run failed"
          : agent.reason ?? (agent.pending.length ? "Changes pending" : "In sync");

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__left">
          <button
            className={`icon-btn${navOpen ? " is-active" : ""}`}
            onClick={onToggleNav}
            title={navOpen ? "Hide projects" : "Show projects"}
            aria-label="Toggle projects"
          >
            ☰
          </button>
          <div className="brand">
            <span className="brand__name">{model.context.name || "Untitled project"}</span>
            <span className="brand__repo" title={repo}>{repo}</span>
          </div>
          <div className="topbar__tools">
            <div className="menu-anchor">
              <button
                className={`btn${appMenu ? " is-active" : ""}`}
                onClick={() => setAppMenu((o) => !o)}
                disabled={appStarting}
                title={appError ?? "Open the generated app (starts it if it isn't running)"}
              >
                {appStarting ? "Starting app…" : appError ? "Open app ⚠" : "Open app ▾"}
              </button>
              {appMenu && (
                <>
                  <div className="menu-scrim" onClick={() => setAppMenu(false)} />
                  <div className="menu" role="menu">
                    {appError && <p className="menu__error">{appError}</p>}
                    {builtScreens.length > 0 ? (
                      <>
                        <span className="menu__label">Screens</span>
                        {builtScreens.map((s) => (
                          <button key={s.el.id} role="menuitem" onClick={() => void openApp(s.path)}>
                            <span>{s.el.name}</span>
                            <span className="mono hint">{s.path}</span>
                          </button>
                        ))}
                      </>
                    ) : (
                      <p className="menu__note">
                        {screens.length
                          ? "Your screens aren't implemented yet. Mark them ready and let the agent run."
                          : "There's nothing to look at yet: entities and services have no pages of their own. Add a Screen box (e.g. “Recipe list”) and mark it ready."}
                      </p>
                    )}
                    <button role="menuitem" onClick={() => void openApp("/")}>
                      <span>App root</span>
                      <span className="mono hint">/</span>
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="btn-group" role="group" aria-label="History">
              <button className="btn" onClick={undo} disabled={!past.current.length} title="Undo (⌘Z)" aria-label="Undo">
                ↶
              </button>
              <button className="btn" onClick={redo} disabled={!future.current.length} title="Redo (⇧⌘Z)" aria-label="Redo">
                ↷
              </button>
            </div>
            <button
              className="btn"
              onClick={() => void tidyUp()}
              disabled={!model.elements.length}
              title="Arrange the boxes by type and by how they're connected (undoable)"
            >
              Tidy up
            </button>
            <button
              className={`btn${changes.open ? " is-active" : ""}`}
              onClick={() => setChanges((c) => ({ open: !c.open }))}
            >
              Code changes
            </button>
          </div>
        </div>
        <div className="topbar__actions">
          <span className={`status status--${agent.status}`}>
            <span className="status__dot" />
            {statusText}
          </span>
          <label className="switch">
            <input type="checkbox" checked={agent.auto} onChange={(e) => void api.setAuto(e.target.checked)} />
            Auto-implement
          </label>
          {agent.status === "running" ? (
            <button className="btn" onClick={() => void api.stop()}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={!agent.pending.length || !contextReady}
              onClick={() => void api.run()}
            >
              Implement now
            </button>
          )}
        </div>
      </header>

      <main className="workspace">
        <div
          className="sheet"
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).classList.contains("react-flow__pane"))
              addElement("entity", flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => n.type === "element" && setSelection({ kind: "element", id: n.id })}
            onEdgeClick={(_, e) => setSelection({ kind: "relation", id: e.id })}
            onEdgeMouseEnter={(_, e) => setHoveredEdge(e.id)}
            onEdgeMouseLeave={() => setHoveredEdge(undefined)}
            onPaneClick={() => setSelection(null)}
            zoomOnDoubleClick={false}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView={model.elements.length > 0}
            fitViewOptions={{ maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
            <Controls showInteractive={false} />
          </ReactFlow>

          <div className="palette" role="toolbar" aria-label="Add box">
            {ELEMENT_TYPES.map((t) => (
              <button key={t} className={`palette__btn palette__btn--${t}`} onClick={() => addElement(t)}>
                <span aria-hidden>{TYPE_META[t].glyph}</span> {TYPE_META[t].label}
              </button>
            ))}
          </div>

          {model.elements.length === 0 && (
            <div className="empty">
              {agent.status === "running" ? (
                <>
                  <h1>Reading the code…</h1>
                  <p>The agent is mapping the existing code onto the sheet. The boxes appear when it's done.</p>
                </>
              ) : hasCode ? (
                <>
                  <h1>This folder already has code</h1>
                  <p>Let the agent read it and draw the architecture, then keep designing from there.</p>
                  <button className="btn btn--primary empty__btn" onClick={() => void api.discover()}>
                    Draw diagram from code
                  </button>
                  <p className="hint">Or start drawing yourself: add a box from the left.</p>
                </>
              ) : contextReady ? (
                <>
                  <h1>Blank sheet</h1>
                  <p>Add a box from the left or double-click the sheet. Drag from a box's right dot to connect it.</p>
                  <p className="hint">Mark a box as “ready” and the agent starts implementing it.</p>
                </>
              ) : (
                <>
                  <h1>Start with context</h1>
                  <p>What are you building, for whom, and with which stack? Fill that in on the right first.</p>
                </>
              )}
            </div>
          )}

          {changes.open && (
            <ChangesView
              api={api}
              running={agent.status === "running"}
              refreshKey={historyKey}
              focusFile={changes.file}
              onClose={() => setChanges({ open: false })}
            />
          )}

          <AgentPanel agent={agent} logs={logs} open={logOpen} onToggle={() => setLogOpen((o) => !o)} />
        </div>

        <aside className="sidebar">
          {selectedEl ? (
            <ElementInspector
              key={`${selectedEl.id}:${rev}`}
              el={selectedEl}
              st={agentState.elements[selectedEl.id]}
              onChange={(el) =>
                update((m) => ({ ...m, elements: m.elements.map((e) => (e.id === el.id ? el : e)) }), `el:${el.id}`)
              }
              onDelete={() => removeElements([selectedEl.id])}
              onOpenFile={(file) => setChanges({ open: true, file })}
              onOpenInApp={(p) => void openApp(p)}
            />
          ) : selectedRel ? (
            <RelationInspector
              key={`${selectedRel.id}:${rev}`}
              rel={selectedRel}
              names={names}
              onChange={(r) =>
                update((m) => ({ ...m, relations: m.relations.map((x) => (x.id === r.id ? r : x)) }), `rel:${r.id}`)
              }
              onDelete={() => removeRelations([selectedRel.id])}
            />
          ) : (
            <ContextPanel key={rev} context={model.context} onChange={(context) => update((m) => ({ ...m, context }), "context")} />
          )}
        </aside>
      </main>
    </div>
  );
}

const NAV_KEY = "blueprint.nav";
const readNav = () => {
  try {
    const v = localStorage.getItem(NAV_KEY);
    return v == null ? window.innerWidth > 860 : v === "1";
  } catch {
    return true;
  }
};

function Workspace() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [settings, setSettings] = useState<Settings>();
  const [activeId, setActiveId] = useState<string | undefined>(() => location.hash.match(/^#\/p\/(\w+)/)?.[1]);
  const [navOpen, setNavOpen] = useState(readNav);

  useEffect(() => {
    void projectsApi.list().then((r) => {
      setProjects(r.projects);
      setSettings(r.settings);
      setActiveId((cur) => (cur && r.projects.some((p) => p.id === cur && !p.missing) ? cur : r.initial));
    });
    return subscribe((e) => e.type === "projects" && setProjects(e.projects), () => void projectsApi.list().then((r) => setProjects(r.projects)));
  }, []);

  useEffect(() => {
    if (activeId) history.replaceState(null, "", `#/p/${activeId}`);
  }, [activeId]);

  useEffect(() => {
    const onHash = () => {
      const id = location.hash.match(/^#\/p\/(\w+)/)?.[1];
      if (id) setActiveId(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const toggleNav = () =>
    setNavOpen((o) => {
      try {
        localStorage.setItem(NAV_KEY, o ? "0" : "1");
      } catch {}
      return !o;
    });

  const api = useMemo(() => (activeId ? projectApi(activeId) : undefined), [activeId]);
  const active = projects?.find((p) => p.id === activeId);

  if (!projects) return <div className="loading">Loading…</div>;

  return (
    <div className={`shell${navOpen ? " has-nav" : ""}`}>
      {navOpen && (
        <ProjectsSidebar
          projects={projects}
          activeId={activeId}
          settings={settings}
          onSelect={setActiveId}
          onSettings={setSettings}
        />
      )}
      {api && activeId && active && !active.missing ? (
        <ReactFlowProvider key={activeId}>
          <Canvas
            projectId={activeId}
            api={api}
            navOpen={navOpen}
            onToggleNav={toggleNav}
            onNameChange={(name) =>
              setProjects((ps) => ps?.map((p) => (p.id === activeId && p.name !== name ? { ...p, name } : p)) ?? ps)
            }
          />
        </ReactFlowProvider>
      ) : (
        <div className="app">
          <header className="topbar">
            <div className="topbar__left">
              <button className={`icon-btn${navOpen ? " is-active" : ""}`} onClick={toggleNav} aria-label="Toggle projects">
                ☰
              </button>
              <span className="brand__name">Blueprint</span>
            </div>
          </header>
          <div className="empty empty--page">
            <h1>{projects.length ? "Pick a project" : "Create your first project"}</h1>
            <p>
              {projects.length
                ? "Choose one from the list on the left."
                : `Use “New project” on the left. It gets its own folder in ${settings?.projectsDir ?? "your projects directory"}.`}
            </p>
            {!navOpen && (
              <button className="btn btn--primary" onClick={toggleNav}>
                Show projects
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return <Workspace />;
}
