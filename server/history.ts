import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface RunEntry {
  /** Commit sha, or "working" for uncommitted changes in the target repo. */
  sha: string;
  title: string;
  date: string;
  changes: string[];
  files: FileChange[];
}

/** Blueprint's own bookkeeping; never interesting as "what the agent changed". */
const isInternal = (p: string) => p === "architecture.yaml" || p.startsWith(".blueprint/");

/** Read-only view of what the agent did to the target repo, based on git. */
export class History {
  constructor(private repo: string) {}

  private git = async (args: string[]) =>
    (await exec("git", args, { cwd: this.repo, maxBuffer: 32 * 1024 * 1024 })).stdout;

  get available() {
    return existsSync(path.join(this.repo, ".git"));
  }

  async list(limit = 50): Promise<RunEntry[]> {
    if (!this.available) return [];
    const entries: RunEntry[] = [];
    const working = await this.working();
    if (working.files.length) entries.push(working);

    const SEP = "\x1e";
    const out = await this.git([
      "log", `-n${limit}`, "--grep=^blueprint:", "--numstat", "-M",
      `--format=${SEP}%H%x1f%cI%x1f%s%x1f%b%x1f`,
    ]).catch(() => "");
    for (const chunk of out.split(SEP).filter(Boolean)) {
      const [sha, date, subject, body, numstat = ""] = chunk.split("\x1f");
      const files = parseNumstat(numstat);
      const status = await this.statuses(sha);
      for (const f of files) f.status = status.get(f.path) ?? f.status;
      entries.push({
        sha,
        date,
        title: subject.replace(/^blueprint:\s*/, ""),
        changes: body.split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean),
        files: files.filter((f) => !isInternal(f.path)),
      });
    }
    return entries;
  }

  /** Unified diff of one file in one run. */
  async diff(sha: string, file: string): Promise<string> {
    if (!this.available) return "";
    if (sha === "working") {
      const tracked = await this.git(["diff", "HEAD", "-M", "--", file]).catch(() => "");
      if (tracked.trim()) return tracked;
      // Untracked file: diff against nothing. Exit code 1 means "differences found".
      return exec("git", ["diff", "--no-index", "--", "/dev/null", file], { cwd: this.repo, maxBuffer: 32 * 1024 * 1024 })
        .then((r) => r.stdout)
        .catch((e) => String(e.stdout ?? ""));
    }
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("bad sha");
    return this.git(["show", "-M", "--format=", sha, "--", file]);
  }

  private async statuses(sha: string) {
    const out = await this.git(["show", "-M", "--name-status", "--format=", sha]).catch(() => "");
    const map = new Map<string, FileChange["status"]>();
    for (const line of out.split("\n").filter(Boolean)) {
      const [code, a, b] = line.split("\t");
      map.set(b ?? a, codeToStatus(code));
    }
    return map;
  }

  private async working(): Promise<RunEntry> {
    const entry: RunEntry = { sha: "working", title: "Uncommitted changes", date: new Date().toISOString(), changes: [], files: [] };
    // A fresh project has no commit yet: everything in it is new.
    const hasHead = await this.git(["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
    const stats = hasHead ? parseNumstat(await this.git(["diff", "HEAD", "--numstat", "-M"]).catch(() => "")) : [];
    const status = new Map<string, FileChange["status"]>();
    const nameStatus = hasHead ? await this.git(["diff", "HEAD", "--name-status", "-M"]).catch(() => "") : "";
    for (const line of nameStatus.split("\n").filter(Boolean)) {
      const [code, a, b] = line.split("\t");
      status.set(b ?? a, codeToStatus(code));
    }
    for (const f of stats) f.status = status.get(f.path) ?? f.status;

    const untracked = (await this.git(["ls-files", "--others", "--exclude-standard"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    for (const p of untracked) {
      const diff = await this.diff("working", p);
      const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      stats.push({ path: p, added, removed: 0, status: "added" });
    }
    entry.files = stats.filter((f) => !isInternal(f.path));
    return entry;
  }
}

function codeToStatus(code: string): FileChange["status"] {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  return "modified";
}

function parseNumstat(text: string): FileChange[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...rest] = l.split("\t");
      return {
        path: renamedPath(rest.join("\t")),
        added: Number(a) || 0,
        removed: Number(r) || 0,
        status: "modified" as const,
      };
    });
}

/** numstat prints renames as "dir/{old => new}/file" or "old => new". */
function renamedPath(p: string): string {
  const braces = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braces) return (braces[1] + braces[3] + braces[4]).replace(/\/\//g, "/");
  const plain = p.split(" => ");
  return plain[plain.length - 1];
}
