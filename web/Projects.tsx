import { useState } from "react";
import { projectsApi, type ProjectSummary, type Settings } from "./api";

type Form = "none" | "new" | "existing" | "settings";

export function ProjectsSidebar({
  projects,
  activeId,
  settings,
  onSelect,
  onSettings,
}: {
  projects: ProjectSummary[];
  activeId?: string;
  settings?: Settings;
  onSelect: (id: string) => void;
  onSettings: (s: Settings) => void;
}) {
  const [form, setForm] = useState<Form>(projects.length ? "none" : "new");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const openForm = (f: Form) => {
    setForm((cur) => (cur === f ? "none" : f));
    setValue(f === "settings" ? settings?.projectsDir ?? "" : "");
    setError(undefined);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (form === "settings") {
        const res = await projectsApi.setProjectsDir(value);
        if (!res.ok) throw new Error(res.error);
        onSettings(res.settings);
      } else {
        const res = form === "new" ? await projectsApi.create(value) : await projectsApi.addExisting(value);
        if (!res.ok) throw new Error(res.error);
        onSelect(res.project.id);
      }
      setForm("none");
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: ProjectSummary) => {
    if (!confirm(`Remove “${p.name}” from the list?\nThe folder ${p.path} stays on disk.`)) return;
    const res = await projectsApi.remove(p.id);
    if (!res.ok) alert(res.error);
  };

  return (
    <nav className="projects" aria-label="Projects">
      <div className="projects__head">
        <h2>Projects</h2>
        <button
          className={`icon-btn${form === "settings" ? " is-active" : ""}`}
          onClick={() => openForm("settings")}
          title="Default projects directory"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>

      <ul className="projects__list">
        {projects.length === 0 && <li className="hint projects__none">No projects yet.</li>}
        {projects.map((p) => (
          <li key={p.id}>
            <button
              className={`project${p.id === activeId ? " is-active" : ""}${p.missing ? " is-missing" : ""}`}
              onClick={() => !p.missing && onSelect(p.id)}
              disabled={p.missing}
              title={p.missing ? `${p.path} no longer exists` : p.path}
            >
              <span className={`project__dot project__dot--${p.status ?? "closed"}`} aria-hidden />
              <span className="project__text">
                <span className="project__name">{p.name}</span>
                <span className="project__path">{p.missing ? "folder missing" : p.path}</span>
              </span>
            </button>
            {p.removable && (
              <button className="project__remove" onClick={() => void remove(p)} title="Remove from list" aria-label={`Remove ${p.name}`}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="projects__foot">
        {form !== "none" && (
          <form className="projects__form" onSubmit={submit}>
            <label>
              {form === "new" ? "Project name" : form === "existing" ? "Path to an existing folder" : "Default projects directory"}
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={form === "new" ? "Recipe Box" : form === "existing" ? "~/p/my-app" : "~/Blueprint"}
                spellCheck={false}
              />
            </label>
            <span className="hint">
              {form === "new"
                ? `Creates a folder in ${settings?.projectsDir ?? "the projects directory"} with a fresh git repo.`
                : form === "existing"
                  ? "The agent will work inside this folder."
                  : "New projects go here. Folders in it that have an architecture.yaml are listed automatically."}
            </span>
            {error && <span className="projects__error">{error}</span>}
            <div className="projects__actions">
              <button type="button" className="btn" onClick={() => setForm("none")}>
                Cancel
              </button>
              <button className="btn btn--primary" disabled={!value.trim() || busy}>
                {form === "new" ? "Create" : form === "existing" ? "Add" : "Save"}
              </button>
            </div>
          </form>
        )}
        {form !== "new" && form !== "existing" && (
          <div className="projects__adds">
            <button className="btn btn--primary" onClick={() => openForm("new")}>
              + New project
            </button>
            <button className="btn" onClick={() => openForm("existing")}>
              Add existing…
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
