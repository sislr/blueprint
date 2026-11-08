import path from "node:path";
import { existsSync } from "node:fs";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import { authDescription, strippedVars } from "./auth";
import { Projects, type Workspace } from "./projects";
import { hasCode } from "./discover";
import type { ArchitectureModel, Layout } from "../shared/model";

// Optional: a repo to add and open first (`blueprint ~/p/my-app`, or TARGET_REPO for `npm run dev`).
const initialArg = process.argv[2] || process.env.TARGET_REPO || undefined;
const port = Number(process.env.PORT ?? 4317);

const clients = new Set<WSContext>();
const projects = new Projects((e) => {
  const data = JSON.stringify(e);
  for (const ws of clients) ws.send(data);
});
await projects.init(initialArg && path.resolve(initialArg));

// Apps started via "Open app" are children of this process; take them down with it.
process.on("exit", () => projects.stopAll());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => process.exit(0));

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const fail = (c: Context, err: unknown, status: 400 | 404 | 500 = 400) =>
  c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, status);

// ── Projects (global) ─────────────────────────────────────────────

app.get("/api/projects", async (c) =>
  c.json({ projects: await projects.list(), initial: await projects.initialId(), settings: projects.settings() }),
);

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ name?: string; path?: string }>();
  try {
    const p = body.path ? await projects.addExisting(body.path) : await projects.create(body.name ?? "");
    return c.json({ ok: true, project: p });
  } catch (err) {
    return fail(c, err);
  }
});

app.delete("/api/projects/:id", async (c) => {
  try {
    await projects.remove(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

app.put("/api/settings", async (c) => {
  try {
    await projects.setProjectsDir((await c.req.json<{ projectsDir: string }>()).projectsDir);
    return c.json({ ok: true, settings: projects.settings() });
  } catch (err) {
    return fail(c, err);
  }
});

// ── One project ───────────────────────────────────────────────────

const project = new Hono<{ Variables: { ws: Workspace } }>();
project.use("*", async (c, next) => {
  try {
    c.set("ws", await projects.open(c.req.param("id")!));
  } catch (err) {
    return fail(c, err, 404);
  }
  await next();
});

project.get("/bootstrap", async (c) => {
  const { repo, store, agent } = c.var.ws;
  return c.json({
    repo,
    model: await store.model(),
    layout: await store.layout(),
    state: await store.agentState(),
    agent: await agent.snapshot(),
    logs: agent.recentLogs(),
    hasCode: await hasCode(repo),
  });
});

project.put("/model", async (c) => {
  const { store, agent } = c.var.ws;
  await store.saveModel(await c.req.json<ArchitectureModel>());
  await agent.onModelChanged();
  return c.json({ ok: true });
});

project.put("/layout", async (c) => {
  await c.var.ws.store.saveLayout(await c.req.json<Layout>());
  return c.json({ ok: true });
});

project.get("/history", async (c) => {
  const { history } = c.var.ws;
  return c.json({ git: history.available, runs: await history.list() });
});
project.get("/diff", async (c) => {
  const sha = c.req.query("sha") ?? "";
  const file = c.req.query("file") ?? "";
  if (!file || path.isAbsolute(file) || file.split("/").includes("..")) return c.text("bad file", 400);
  try {
    return c.text(await c.var.ws.history.diff(sha, file));
  } catch (err) {
    return c.text(String(err), 400);
  }
});

project.get("/app", async (c) => c.json(await c.var.ws.app.info()));
project.post("/app/start", async (c) => {
  try {
    await projects.startApp(c.var.ws);
    return c.json({ ok: true, url: c.var.ws.app.url });
  } catch (err) {
    return fail(c, err, 500);
  }
});

project.get("/pending", async (c) => c.json(await c.var.ws.agent.pending()));
project.post("/agent/run", async (c) => {
  void c.var.ws.agent.run();
  return c.json({ ok: true });
});
project.post("/agent/discover", async (c) => {
  void c.var.ws.agent.discover();
  return c.json({ ok: true });
});
project.post("/agent/stop", async (c) => {
  await c.var.ws.agent.stop();
  return c.json({ ok: true });
});
project.post("/agent/auto", async (c) => {
  const { auto } = await c.req.json<{ auto: boolean }>();
  await c.var.ws.agent.setAuto(auto);
  return c.json({ ok: true });
});

app.route("/api/projects/:id", project);

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen: (_e, ws) => void clients.add(ws),
    onClose: (_e, ws) => void clients.delete(ws),
  })),
);

// Production build of the canvas (npm run build). In dev, Vite serves it and proxies /api + /ws.
const dist = path.resolve(import.meta.dirname, "../dist");
if (existsSync(dist)) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), dist) }));
}

const server = serve({ fetch: app.fetch, port }, async () => {
  const { projectsDir } = projects.settings();
  console.log(`blueprint → http://localhost:${port}  (projects in ${projectsDir})`);
  console.log(`auth: Claude subscription via ${authDescription()}`);
  const ignored = strippedVars();
  if (ignored.length) console.log(`      ignoring ${ignored.join(", ")} for the agent`);
});
injectWebSocket(server);
