<p align="center"><img src="docs/logo.svg" width="96" alt="Blueprint logo"></p>

<h1 align="center">Blueprint</h1>

<p align="center">You design the system, an agent writes the code.<br>
<a href="docs/demo.mp4">▶ Watch the demo (1:27)</a></p>

---

Sketch your app as boxes (screens, services, entities, external systems) and connect them.
Mark a box **ready** and a Claude agent implements exactly what changed, in your repo, with one commit per change.
Point it at existing code and it draws the diagram for you first.

## Quick start

```sh
git clone git@github.com:sislr/blueprint.git && blueprint/bin/setup   # once

cd ~/path/to/your-app
blueprint                     # opens this project on http://localhost:4317
blueprint update              # later: get the latest version
```

Setup offers to install Node.js (via Homebrew) if it's missing and puts the `blueprint` command on your PATH.
After that there's nothing to rebuild by hand: `blueprint` installs and builds whatever changed when it starts.

## How it works

- `architecture.yaml` in your repo is the source of truth. The canvas edits it.
- Only boxes marked ready reach the agent. It gets a list of what changed, not a picture.
- Unclear description? The agent asks on the box instead of guessing.
- **Code changes** shows the diff behind every box; **Open app** runs the result.

> The agent edits files and runs shell commands unattended in the target repo. Use it on repos where that's fine.

## Configuration

| Env | Default | |
|---|---|---|
| `BLUEPRINT_MODEL` | `claude-opus-5-5` | Agent model |
| `PORT` | `4317` | Canvas port |
| `BLUEPRINT_APP_URL` | `http://localhost:3000` | Where **Open app** looks for your app |
| `BLUEPRINT_APP_CMD` | `bin/dev` or `npm run dev` | How **Open app** starts it |
