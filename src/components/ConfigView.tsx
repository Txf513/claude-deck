import { useEffect, useState } from "react";
import {
  listPlugins,
  listSkills,
  maskSecretsInJsonText,
  readConfig,
  setPluginEnabled,
  writeConfig,
  type ConfigFile,
  type ConfigKind,
  type PluginInfo,
  type SkillInfo,
} from "../lib/config";

type Section = "settings" | "skills" | "plugins";

export function ConfigView() {
  const [section, setSection] = useState<Section>("settings");
  return (
    <div className="config-view">
      <div className="config-tabs">
        <button
          className={section === "settings" ? "active" : ""}
          onClick={() => setSection("settings")}
        >
          Settings
        </button>
        <button
          className={section === "plugins" ? "active" : ""}
          onClick={() => setSection("plugins")}
        >
          Plugins
        </button>
        <button
          className={section === "skills" ? "active" : ""}
          onClick={() => setSection("skills")}
        >
          Skills
        </button>
      </div>
      <div className="config-body">
        {section === "settings" && <SettingsEditor />}
        {section === "plugins" && <PluginsList />}
        {section === "skills" && <SkillsList />}
      </div>
    </div>
  );
}

function SettingsEditor() {
  const [kind, setKind] = useState<ConfigKind>("settings");
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [draft, setDraft] = useState("");
  const [maskSecrets, setMaskSecrets] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setError(null);
    readConfig(kind)
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        setDraft(f.content);
        setParseErr(f.valid_json ? null : f.parse_error);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [kind]);

  function onChange(text: string) {
    setDraft(text);
    setStatus(null);
    try {
      JSON.parse(text);
      setParseErr(null);
    } catch (e) {
      setParseErr(String(e));
    }
  }

  async function save() {
    if (parseErr) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await writeConfig(kind, draft);
      setStatus(
        r.backup ? `saved · backup: ${r.backup}` : `saved · ${r.path}`
      );
      const fresh = await readConfig(kind);
      setFile(fresh);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function reload() {
    readConfig(kind).then((f) => {
      setFile(f);
      setDraft(f.content);
      setParseErr(f.valid_json ? null : f.parse_error);
      setStatus(null);
      setError(null);
    });
  }

  const displayed = maskSecrets ? maskSecretsInJsonText(draft) : draft;
  const dirty = file ? draft !== file.content : false;
  const editable = !maskSecrets;

  return (
    <div className="settings-editor">
      <div className="toolbar">
        <div className="toolbar-left">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ConfigKind)}
          >
            <option value="settings">~/.claude/settings.json</option>
            <option value="settings_local">~/.claude/settings.local.json</option>
          </select>
          <label className="toggle">
            <input
              type="checkbox"
              checked={maskSecrets}
              onChange={(e) => setMaskSecrets(e.target.checked)}
            />
            mask secrets
          </label>
        </div>
        <div className="toolbar-right">
          <button onClick={reload} disabled={busy}>
            reload
          </button>
          <button
            onClick={save}
            disabled={busy || !!parseErr || !dirty || !editable}
            title={
              !editable
                ? "uncheck 'mask secrets' to edit"
                : parseErr
                ? "fix JSON before saving"
                : dirty
                ? "save"
                : "no changes"
            }
          >
            {busy ? "saving…" : "save"}
          </button>
        </div>
      </div>
      <div className="status-row">
        {parseErr && <span className="err">JSON error: {parseErr}</span>}
        {error && <span className="err">{error}</span>}
        {status && <span className="ok">{status}</span>}
        {!parseErr && !error && !status && file && (
          <span className="muted">
            {file.exists ? file.path : `${file.path} (will be created)`}
          </span>
        )}
      </div>
      <textarea
        className="json-editor"
        spellCheck={false}
        value={displayed}
        readOnly={!editable}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function SkillsList() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    listSkills()
      .then(setSkills)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="err">{error}</div>;
  if (!skills) return <div className="muted">loading…</div>;

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.source.toLowerCase().includes(q)
      )
    : skills;

  return (
    <div className="skills-list">
      <div className="toolbar">
        <input
          placeholder={`search ${skills.length} skills`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="filter-input"
        />
      </div>
      <div className="cards">
        {filtered.map((s) => (
          <div key={`${s.source}/${s.name}`} className="card">
            <div className="card-head">
              <div className="card-title">{s.name}</div>
              <div className="card-source">{s.source}</div>
            </div>
            <div className="card-desc">{s.description || "(no description)"}</div>
            <div className="card-path">{s.path}</div>
          </div>
        ))}
        {filtered.length === 0 && <div className="muted">no skills match</div>}
      </div>
    </div>
  );
}

function PluginsList() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function refresh() {
    listPlugins()
      .then(setPlugins)
      .catch((e) => setError(String(e)));
  }

  useEffect(refresh, []);

  async function toggle(p: PluginInfo) {
    setBusyId(p.id);
    setError(null);
    try {
      await setPluginEnabled(p.id, !p.enabled);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <div className="err">{error}</div>;
  if (!plugins) return <div className="muted">loading…</div>;

  return (
    <div className="plugins-list">
      <div className="cards">
        {plugins.map((p) => (
          <div key={p.id} className="card">
            <div className="card-head">
              <div className="card-title">{p.id}</div>
              <button
                className={`pill ${p.enabled ? "on" : "off"}`}
                onClick={() => toggle(p)}
                disabled={busyId === p.id}
              >
                {busyId === p.id ? "…" : p.enabled ? "enabled" : "disabled"}
              </button>
            </div>
            <div className="card-desc">
              {p.installed ? (
                <>
                  installed{p.version ? ` · ${p.version}` : ""}
                </>
              ) : (
                <span className="muted">not installed locally</span>
              )}
            </div>
            {p.install_path && <div className="card-path">{p.install_path}</div>}
          </div>
        ))}
        {plugins.length === 0 && (
          <div className="muted">
            no plugins recorded in settings.json or installed_plugins.json
          </div>
        )}
      </div>
    </div>
  );
}
