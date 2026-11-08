#!/usr/bin/env node
// blueprint [path]: opens a project in Blueprint, like `code .`
//   In a project folder (git repo or architecture.yaml), `blueprint` opens that folder; elsewhere the last project.
//   If Blueprint is already running, the project is added to it; otherwise the server starts.
//   Before starting, it installs dependencies and rebuilds the canvas if they're missing or out of date,
//   so a `git pull` (or `blueprint update`) is all an update takes.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("-")));
const arg = args.find((a) => !a.startsWith("-"));
const port = Number(process.env.PORT ?? 4317);
const base = `http://localhost:${port}`;

if (flags.has("-h") || flags.has("--help")) {
  console.log(`Usage: blueprint [path] [--no-open]
       blueprint update

  blueprint            open the current folder if it's a project (git repo or architecture.yaml)
  blueprint ~/p/app    open that folder; code without a diagram gets its diagram drawn
  blueprint update     get the latest Blueprint (git pull, install, rebuild)
  --no-open            don't open the browser

Serves http://localhost:${port} (PORT to change). Started once, later calls reuse it.`);
  process.exit(0);
}

function fail(msg) {
  console.error(`blueprint: ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail(`\`${[cmd, ...cmdArgs].join(" ")}\` failed`);
}

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
/** Newest modification time of a file, or of anything in a folder. */
const newest = (p) =>
  !existsSync(p)
    ? 0
    : statSync(p).isDirectory()
      ? Math.max(0, ...readdirSync(p).map((f) => newest(path.join(p, f))))
      : statSync(p).mtimeMs;

/** Installs dependencies and builds the canvas when they're missing or older than the code. */
function ensureReady() {
  const installed = path.join(root, "node_modules/.package-lock.json");
  if (Math.max(mtime(path.join(root, "package.json")), mtime(path.join(root, "package-lock.json"))) > mtime(installed)) {
    console.log("blueprint: installing dependencies…");
    run("npm", ["install", "--no-fund", "--no-audit", "--loglevel=error"]);
  }
  const sources = ["web", "shared", "vite.config.ts", "package-lock.json"].map((p) => newest(path.join(root, p)));
  if (Math.max(...sources) > mtime(path.join(root, "dist/index.html"))) {
    console.log("blueprint: building the canvas…");
    run("npm", ["run", "build", "--silent", "--", "--logLevel", "warn"]);
  }
}

if (arg === "update") {
  if (!existsSync(path.join(root, ".git"))) fail(`${root} isn't a git checkout, so it can't update itself`);
  run("git", ["pull", "--ff-only"]);
  ensureReady();
  console.log(
    (await running())
      ? "Updated. Blueprint is still running the old version: stop it (Ctrl+C where it runs) and start it again."
      : "Updated.",
  );
  process.exit(0);
}

const looksLikeProject = (dir) =>
  dir !== os.homedir() && dir !== root && (existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, "architecture.yaml")));

const target = arg ? path.resolve(arg) : looksLikeProject(process.cwd()) ? process.cwd() : undefined;
if (target && !existsSync(target)) fail(`${target} doesn't exist`);

async function running() {
  try {
    return (await fetch(`${base}/api/projects`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (flags.has("--no-open")) return;
  const [cmd, ...cmdArgs] =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

if (await running()) {
  // Hand the project to the running instance.
  let hash = "";
  if (target) {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    }).then((r) => r.json());
    if (!res.ok) fail(res.error);
    hash = `#/p/${res.project.id}`;
    console.log(`Opened ${res.project.name} in Blueprint → ${base}`);
  }
  openBrowser(base + "/" + hash);
} else {
  ensureReady();
  const tsx = path.join(root, "node_modules/.bin/tsx");
  const server = spawn(tsx, [path.join(root, "server/index.ts"), ...(target ? [target] : [])], { stdio: "inherit" });
  server.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
  // The server opens the given project first.
  for (let i = 0; i < 60 && !(await running()); i++) await new Promise((r) => setTimeout(r, 250));
  openBrowser(base);
}
