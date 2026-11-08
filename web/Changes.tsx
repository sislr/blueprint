import { useEffect, useMemo, useState } from "react";
import type { ProjectApi, RunEntry } from "./api";

type Line = { kind: "hunk" | "add" | "del" | "ctx" | "note"; text: string; old?: number; new?: number };

function parseDiff(diff: string): Line[] {
  const lines: Line[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      o = Number(hunk[1]);
      n = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw });
    } else if (!inHunk) {
      if (raw.startsWith("Binary files")) lines.push({ kind: "note", text: "Binary file" });
    } else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), new: n++ });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), old: o++ });
    else if (raw.startsWith("\\")) lines.push({ kind: "note", text: raw.slice(2) });
    else if (raw.startsWith("diff --git")) inHunk = false;
    else if (raw !== "" || lines.length) lines.push({ kind: "ctx", text: raw.slice(1), old: o++, new: n++ });
  }
  while (lines.length && lines[lines.length - 1].kind === "ctx" && !lines[lines.length - 1].text) lines.pop();
  return lines;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const STATUS_MARK = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

export function ChangesView({
  api,
  running,
  refreshKey,
  focusFile,
  onClose,
}: {
  api: ProjectApi;
  running: boolean;
  /** Bumped by the parent whenever the server reports a new commit. */
  refreshKey: number;
  /** Open on the newest run that touched this file. */
  focusFile?: string;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<RunEntry[] | null>(null);
  const [git, setGit] = useState(true);
  const [sel, setSel] = useState<{ sha: string; file: string } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.history().then((h) => {
        if (!alive) return;
        setGit(h.git);
        setRuns(h.runs);
      });
    void load();
    // While the agent works, its uncommitted edits show up live.
    const t = running ? setInterval(load, 3000) : undefined;
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, running, refreshKey]);

  // Pick a sensible selection once data arrives, or when the current one disappears.
  useEffect(() => {
    if (!runs) return;
    const exists = sel && runs.some((r) => r.sha === sel.sha && r.files.some((f) => f.path === sel.file));
    if (exists) return;
    const byFocus = focusFile && runs.find((r) => r.files.some((f) => f.path === focusFile));
    const first = byFocus ?? runs.find((r) => r.files.length);
    setSel(first ? { sha: first.sha, file: byFocus ? focusFile! : first.files[0].path } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, focusFile]);

  useEffect(() => {
    if (!sel) return setDiff(null);
    let alive = true;
    setDiff(null);
    void api.diff(sel.sha, sel.file).then((d) => alive && setDiff(d));
    return () => {
      alive = false;
    };
    // Re-fetch working-tree diffs on refresh, committed ones never change.
  }, [sel?.sha, sel?.file, sel?.sha === "working" ? runs : null]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = useMemo(() => (diff == null ? null : parseDiff(diff)), [diff]);

  return (
    <section className="changes" aria-label="Code changes">
      <header className="changes__head">
        <h2>Code changes</h2>
        <span className="hint">What the agent changed in the repository, per run</span>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </header>

      {!git ? (
        <p className="changes__empty">The target repository isn't a git repository, so there is no history to show.</p>
      ) : runs && runs.length === 0 ? (
        <p className="changes__empty">No agent runs yet. Mark a box as ready and its code changes appear here.</p>
      ) : (
        <div className="changes__body">
          <nav className="changes__runs">
            {runs?.map((r) => (
              <div key={r.sha} className={`run${r.sha === "working" ? " run--working" : ""}`}>
                <div className="run__head">
                  <strong>{r.sha === "working" ? (running ? "In progress" : r.title) : r.title}</strong>
                  <span className="hint">{r.sha === "working" ? "not committed" : `${when(r.date)} · ${r.sha.slice(0, 7)}`}</span>
                </div>
                {r.changes.length > 0 && (
                  <ul className="run__changes">
                    {r.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
                <ul className="run__files">
                  {r.files.length === 0 && <li className="hint">No code files changed</li>}
                  {r.files.map((f) => (
                    <li key={f.path}>
                      <button
                        className={sel?.sha === r.sha && sel.file === f.path ? "is-selected" : ""}
                        onClick={() => setSel({ sha: r.sha, file: f.path })}
                        title={f.path}
                      >
                        <span className={`fstat fstat--${f.status}`}>{STATUS_MARK[f.status]}</span>
                        <span className="run__path">{f.path}</span>
                        <span className="run__num">
                          {f.added > 0 && <span className="plus">+{f.added}</span>}
                          {f.removed > 0 && <span className="minus">−{f.removed}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          <div className="diff">
            {sel && <div className="diff__file mono">{sel.file}</div>}
            {!sel ? (
              <p className="changes__empty">Select a file.</p>
            ) : lines == null ? (
              <p className="changes__empty">Loading…</p>
            ) : lines.length === 0 ? (
              <p className="changes__empty">No textual changes.</p>
            ) : (
              <table className="diff__table">
                <tbody>
                  {lines.map((l, i) =>
                    l.kind === "hunk" || l.kind === "note" ? (
                      <tr key={i} className={`dl dl--${l.kind}`}>
                        <td colSpan={3}>{l.text}</td>
                      </tr>
                    ) : (
                      <tr key={i} className={`dl dl--${l.kind}`}>
                        <td className="dl__num">{l.old ?? ""}</td>
                        <td className="dl__num">{l.new ?? ""}</td>
                        <td className="dl__code">
                          <span className="dl__sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                          {l.text}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
