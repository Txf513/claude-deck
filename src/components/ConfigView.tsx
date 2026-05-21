import { useEffect, useState, type ReactNode } from "react";
import {
  applyMcpServers,
  listAgents,
  listCommands,
  listPlugins,
  listSkills,
  maskSecretsInJsonText,
  parseMcpServers,
  readConfig,
  readMarkdownFile,
  setPluginEnabled,
  writeConfig,
  writeTextFile,
  type AgentInfo,
  type ConfigFile,
  type ConfigKind,
  type McpServer,
  type PluginInfo,
  type SkillInfo,
} from "../lib/config";

type Section =
  | "settings"
  | "appearance"
  | "skills"
  | "plugins"
  | "agents"
  | "commands"
  | "mcp";

type MarkdownEntry = {
  name: string;
  description: string;
  path: string;
  source: string;
};

type McpTransport = McpServer["transport"];

type McpInvalidServer = {
  name: string;
  raw: unknown;
};

type McpKeyValueRow = {
  id: string;
  key: string;
  value: string;
};

type McpServerForm =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: McpKeyValueRow[];
    }
  | {
      name: string;
      transport: "http" | "sse";
      url: string;
      headers: McpKeyValueRow[];
    };

type McpEditorState = {
  index: number;
  isNew: boolean;
  form: McpServerForm;
};

type MarkdownSourceManagerProps<T extends MarkdownEntry> = {
  loadItems: () => Promise<T[]>;
  emptyDirLabel: string;
  renderCardBadges?: (item: T) => ReactNode;
};

export function ConfigView({
  fontScale,
  onFontScaleChange,
  fontScaleMin,
  fontScaleMax,
}: {
  fontScale: number;
  onFontScaleChange: (value: number) => void;
  fontScaleMin: number;
  fontScaleMax: number;
}) {
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
          className={section === "appearance" ? "active" : ""}
          onClick={() => setSection("appearance")}
        >
          外观
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
        <button
          className={section === "agents" ? "active" : ""}
          onClick={() => setSection("agents")}
        >
          Agents
        </button>
        <button
          className={section === "commands" ? "active" : ""}
          onClick={() => setSection("commands")}
        >
          Commands
        </button>
        <button
          className={section === "mcp" ? "active" : ""}
          onClick={() => setSection("mcp")}
        >
          MCP
        </button>
      </div>
      <div className="config-body">
        {section === "settings" && <SettingsEditor />}
        {section === "appearance" && (
          <AppearanceSettings
            fontScale={fontScale}
            onFontScaleChange={onFontScaleChange}
            min={fontScaleMin}
            max={fontScaleMax}
          />
        )}
        {section === "plugins" && <PluginsList />}
        {section === "skills" && <SkillsList />}
        {section === "agents" && <AgentsList />}
        {section === "commands" && <CommandsList />}
        {section === "mcp" && <McpServersList />}
      </div>
    </div>
  );
}

function AppearanceSettings({
  fontScale,
  onFontScaleChange,
  min,
  max,
}: {
  fontScale: number;
  onFontScaleChange: (value: number) => void;
  min: number;
  max: number;
}) {
  const percent = Math.round(fontScale * 100);
  return (
    <div className="config-section" style={{ padding: 16, maxWidth: 560 }}>
      <h3 style={{ marginTop: 0, marginBottom: 4 }}>字体缩放</h3>
      <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
        整体 UI 缩放比例。设置即时生效，刷新后保留。
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <input
          type="range"
          min={min}
          max={max}
          step={0.05}
          value={fontScale}
          onChange={(e) => onFontScaleChange(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <div
          style={{
            minWidth: 56,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {percent}%
        </div>
        <button
          className="cd-pill"
          onClick={() => onFontScaleChange(1)}
          disabled={fontScale === 1}
          title="恢复 100%"
        >
          重置
        </button>
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

function McpServersList() {
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [original, setOriginal] = useState<McpServer[]>([]);
  const [draft, setDraft] = useState<McpServer[]>([]);
  const [originalInvalid, setOriginalInvalid] = useState<McpInvalidServer[]>([]);
  const [invalid, setInvalid] = useState<McpInvalidServer[]>([]);
  const [editor, setEditor] = useState<McpEditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  async function load(showSaved = false) {
    setLoading(true);
    setError(null);
    if (!showSaved) {
      setStatus(null);
    }
    try {
      const nextFile = await readConfig("settings");
      const parsed = parseMcpServers(nextFile.content);
      const nextOriginal = parsed.servers.map(cloneMcpServer);
      const nextInvalid = parsed.invalid.map(cloneInvalidServer);
      setFile(nextFile);
      setOriginal(nextOriginal);
      setDraft(nextOriginal.map(cloneMcpServer));
      setOriginalInvalid(nextInvalid);
      setInvalid(nextInvalid.map(cloneInvalidServer));
      setEditor(null);
      setJsonError(
        nextFile.valid_json ? null : nextFile.parse_error ?? "settings.json 不是有效 JSON"
      );
      if (showSaved) {
        setStatus("已保存");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const dirty = !sameServers(draft, original) || !sameInvalid(invalid, originalInvalid);
  const hasInvalidEntries = invalid.length > 0;
  const hasFileJsonError = !!jsonError;
  const addDisabled = busy || loading || !!editor || hasFileJsonError;
  const saveDisabled =
    busy || loading || !!editor || !dirty || hasFileJsonError || hasInvalidEntries;
  const cancelDisabled = busy || loading || (!dirty && !editor);

  function cancelAll() {
    setDraft(original.map(cloneMcpServer));
    setInvalid(originalInvalid.map(cloneInvalidServer));
    setEditor(null);
    setStatus(null);
    setError(null);
  }

  function startAdd(transport: McpTransport) {
    const nextServer = createEmptyMcpServer(transport, draft);
    const nextDraft = [...draft, nextServer];
    setDraft(nextDraft);
    setEditor({
      index: nextDraft.length - 1,
      isNew: true,
      form: serverToForm(nextServer),
    });
    setStatus(null);
    setError(null);
  }

  function startEdit(index: number) {
    setEditor({
      index,
      isNew: false,
      form: serverToForm(draft[index]),
    });
    setStatus(null);
    setError(null);
  }

  function cancelInlineEdit() {
    if (!editor) return;
    if (editor.isNew) {
      setDraft((current) => current.filter((_, index) => index !== editor.index));
    }
    setEditor(null);
  }

  function deleteServer(index: number) {
    setDraft((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setStatus(null);
    setError(null);
  }

  function deleteInvalidServer(name: string) {
    setInvalid((current) => current.filter((item) => item.name !== name));
    setStatus(null);
    setError(null);
  }

  const inlineError = editor ? validateMcpForm(editor.form, draft, editor.index) : null;

  function commitInlineEdit() {
    if (!editor || inlineError) return;
    const nextServer = formToServer(editor.form);
    setDraft((current) =>
      current.map((item, index) => (index === editor.index ? nextServer : item))
    );
    setEditor(null);
    setStatus(null);
    setError(null);
  }

  async function save() {
    if (!file || saveDisabled) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const nextText = applyMcpServers(file.content, draft);
      await writeConfig("settings", nextText);
      await load(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !file) {
    return <div className="muted">读取中…</div>;
  }

  if (error && !file) {
    return <div className="err">{error}</div>;
  }

  const pathText = file
    ? file.exists
      ? file.path
      : `${file.path} (will be created)`
    : "~/.claude/settings.json";

  return (
    <div className="mcp-servers-list">
      <div className="toolbar">
        <div className="toolbar-left mcp-toolbar-left">
          <span className="config-detail-path">{pathText}</span>
          <button onClick={() => startAdd("stdio")} disabled={addDisabled}>
            新增 stdio
          </button>
          <button onClick={() => startAdd("http")} disabled={addDisabled}>
            新增 http
          </button>
          <button onClick={() => startAdd("sse")} disabled={addDisabled}>
            新增 sse
          </button>
        </div>
        <div className="toolbar-right">
          <button onClick={() => void save()} disabled={saveDisabled}>
            {busy ? "保存中…" : "保存"}
          </button>
          <button onClick={cancelAll} disabled={cancelDisabled}>
            取消
          </button>
        </div>
      </div>

      <div className="status-row">
        {error && <span className="err">{error}</span>}
        {!error && jsonError && (
          <span className="err">settings.json 不是有效 JSON：{jsonError}</span>
        )}
        {!error && !jsonError && hasInvalidEntries && (
          <span className="err">存在格式错误的 MCP server，请先删除后再保存。</span>
        )}
        {!error && !jsonError && !hasInvalidEntries && status && (
          <span className="ok">{status}</span>
        )}
        {!error && !jsonError && !hasInvalidEntries && !status && (
          <span className="muted">只会修改 ~/.claude/settings.json 的 mcpServers 字段</span>
        )}
      </div>

      <div className="mcp-scroll">
        {draft.length === 0 ? (
          <div className="config-empty-state mcp-empty-state">
            <div className="muted">尚未配置 MCP server。点击上方按钮新增。</div>
          </div>
        ) : (
          <div className="mcp-card-list">
            {draft.map((server, index) => {
              const isEditing = editor?.index === index;
              return (
                <div key={`${server.name}-${index}`} className="card">
                  <div className="card-head">
                    <div className="card-title">{server.name}</div>
                    <span
                      className={`card-source mcp-transport-badge mcp-transport-${server.transport}`}
                    >
                      {server.transport}
                    </span>
                  </div>

                  {isEditing && editor ? (
                    <McpServerEditor
                      form={editor.form}
                      error={inlineError}
                      busy={busy}
                      onChange={(form) => setEditor({ ...editor, form })}
                      onComplete={commitInlineEdit}
                      onCancel={cancelInlineEdit}
                    />
                  ) : (
                    <>
                      <div className="card-desc">{summarizeMcpServer(server)}</div>
                      <div className="mcp-card-actions">
                        <button
                          type="button"
                          onClick={() => startEdit(index)}
                          disabled={busy || !!editor}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteServer(index)}
                          disabled={busy || !!editor}
                        >
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {invalid.length > 0 && (
          <div className="mcp-invalid-section">
            <div className="mcp-section-title">格式错误</div>
            <div className="mcp-card-list">
              {invalid.map((item) => (
                <div key={item.name} className="card mcp-invalid-card">
                  <div className="card-head">
                    <div className="card-title">{item.name}</div>
                    <span className="card-source mcp-transport-badge mcp-transport-invalid">
                      invalid
                    </span>
                  </div>
                  <div className="card-desc">{formatInvalidServer(item.raw)}</div>
                  <div className="mcp-card-actions">
                    <button
                      type="button"
                      onClick={() => deleteInvalidServer(item.name)}
                      disabled={busy || !!editor}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function McpServerEditor({
  form,
  error,
  busy,
  onChange,
  onComplete,
  onCancel,
}: {
  form: McpServerForm;
  error: string | null;
  busy: boolean;
  onChange: (form: McpServerForm) => void;
  onComplete: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mcp-form">
      <label className="mcp-field">
        <span>name</span>
        <input
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
        />
      </label>

      {form.transport === "stdio" ? (
        <>
          <label className="mcp-field">
            <span>command</span>
            <input
              value={form.command}
              onChange={(e) => onChange({ ...form, command: e.target.value })}
            />
          </label>
          <StringListEditor
            label="args"
            values={form.args}
            addLabel="添加参数"
            onChange={(args) => onChange({ ...form, args })}
          />
          <KeyValueRowsEditor
            label="env"
            rows={form.env}
            addLabel="添加环境变量"
            onChange={(env) => onChange({ ...form, env })}
          />
        </>
      ) : (
        <>
          <label className="mcp-field">
            <span>url</span>
            <input
              value={form.url}
              onChange={(e) => onChange({ ...form, url: e.target.value })}
            />
          </label>
          <KeyValueRowsEditor
            label="headers"
            rows={form.headers}
            addLabel="添加 Header"
            onChange={(headers) => onChange({ ...form, headers })}
          />
        </>
      )}

      {error && <div className="err">{error}</div>}

      <div className="mcp-form-actions">
        <button type="button" onClick={onComplete} disabled={busy || !!error}>
          完成
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

function StringListEditor({
  label,
  values,
  addLabel,
  onChange,
}: {
  label: string;
  values: string[];
  addLabel: string;
  onChange: (values: string[]) => void;
}) {
  function updateValue(index: number, nextValue: string) {
    onChange(values.map((value, currentIndex) => (currentIndex === index ? nextValue : value)));
  }

  function removeValue(index: number) {
    onChange(values.filter((_, currentIndex) => currentIndex !== index));
  }

  function addValue() {
    onChange([...values, ""]);
  }

  return (
    <div className="mcp-field-group">
      <div className="mcp-field-label">{label}</div>
      {values.length > 0 ? (
        <div className="mcp-inline-list">
          {values.map((value, index) => (
            <div key={`${label}-${index}`} className="mcp-inline-row">
              <input
                value={value}
                onChange={(e) => updateValue(index, e.target.value)}
              />
              <button type="button" onClick={() => removeValue(index)}>
                −
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted">暂无 {label}</div>
      )}
      <button type="button" onClick={addValue}>
        + {addLabel}
      </button>
    </div>
  );
}

function KeyValueRowsEditor({
  label,
  rows,
  addLabel,
  onChange,
}: {
  label: string;
  rows: McpKeyValueRow[];
  addLabel: string;
  onChange: (rows: McpKeyValueRow[]) => void;
}) {
  function updateRow(id: string, patch: Partial<Omit<McpKeyValueRow, "id">>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    onChange(rows.filter((row) => row.id !== id));
  }

  function addRow() {
    onChange([...rows, createKeyValueRow("", "")]);
  }

  return (
    <div className="mcp-field-group">
      <div className="mcp-field-label">{label}</div>
      {rows.length > 0 ? (
        <div className="mcp-inline-list">
          {rows.map((row) => (
            <div key={row.id} className="mcp-inline-row mcp-key-value-row">
              <input
                value={row.key}
                placeholder="key"
                onChange={(e) => updateRow(row.id, { key: e.target.value })}
              />
              <input
                value={row.value}
                placeholder="value"
                onChange={(e) => updateRow(row.id, { value: e.target.value })}
              />
              <button type="button" onClick={() => removeRow(row.id)}>
                −
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted">暂无 {label}</div>
      )}
      <button type="button" onClick={addRow}>
        + {addLabel}
      </button>
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

function AgentsList() {
  return (
    <MarkdownSourceManager
      loadItems={listAgents}
      emptyDirLabel="~/.claude/agents"
      renderCardBadges={(agent: AgentInfo) => (
        <>
          {agent.model && <span className="card-source">model: {agent.model}</span>}
          {agent.tools.length > 0 && (
            <span className="card-source">{agent.tools.length} tools</span>
          )}
        </>
      )}
    />
  );
}

function CommandsList() {
  return (
    <MarkdownSourceManager
      loadItems={listCommands}
      emptyDirLabel="~/.claude/commands"
    />
  );
}

function MarkdownSourceManager<T extends MarkdownEntry>({
  loadItems,
  emptyDirLabel,
  renderCardBadges,
}: MarkdownSourceManagerProps<T>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function refreshList(preferredPath: string | null = selectedPath) {
    setListError(null);
    try {
      const next = await loadItems();
      setItems(next);
      if (preferredPath && next.some((item) => item.path === preferredPath)) {
        setSelectedPath(preferredPath);
      } else {
        setSelectedPath(next[0]?.path ?? null);
      }
    } catch (e) {
      setItems([]);
      setSelectedPath(null);
      setListError(String(e));
    }
  }

  useEffect(() => {
    void refreshList(null);
  }, [loadItems]);

  useEffect(() => {
    if (!selectedPath) {
      setContent("");
      setDraft("");
      setEditing(false);
      setLoadingContent(false);
      setDetailError(null);
      setStatus(null);
      return;
    }

    let cancelled = false;
    setLoadingContent(true);
    setEditing(false);
    setDetailError(null);
    setStatus(null);
    setContent("");
    setDraft("");

    readMarkdownFile(selectedPath)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setDraft(text);
      })
      .catch((e) => {
        if (cancelled) return;
        setDetailError(String(e));
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingContent(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  const selectedItem =
    items?.find((item) => item.path === selectedPath) ?? null;
  const dirty = draft !== content;

  async function save() {
    if (!selectedItem) return;
    setBusy(true);
    setDetailError(null);
    setStatus(null);
    try {
      await writeTextFile(selectedItem.path, draft);
      const fresh = await readMarkdownFile(selectedItem.path);
      setContent(fresh);
      setDraft(fresh);
      setEditing(false);
      setStatus("已保存");
      await refreshList(selectedItem.path);
    } catch (e) {
      setDetailError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function cancelEdit() {
    setDraft(content);
    setEditing(false);
    setStatus(null);
    setDetailError(null);
  }

  if (items === null) {
    return <div className="muted">读取中…</div>;
  }

  return (
    <div className="config-split">
      <div className="config-list-pane">
        <div className="toolbar">
          <div className="muted">{items.length} 个文件</div>
          <button onClick={() => void refreshList()}>刷新</button>
        </div>
        {listError && (
          <div className="status-row">
            <span className="err">{listError}</span>
          </div>
        )}
        {items.length === 0 ? (
          <div className="config-empty-state">
            <div className="muted">
              {emptyDirLabel} 目录下暂无文件，可在该目录创建 .md 文件后回到此处刷新
            </div>
            <button onClick={() => void refreshList()}>刷新</button>
          </div>
        ) : (
          <div className="cards">
            {items.map((item) => (
              <button
                key={item.path}
                type="button"
                className={`card config-select-card ${
                  item.path === selectedPath ? "active" : ""
                }`}
                onClick={() => setSelectedPath(item.path)}
              >
                <div className="card-head">
                  <div className="card-title">{item.name}</div>
                </div>
                <div className="card-desc">
                  {truncateDescription(item.description)}
                </div>
                {renderCardBadges && (
                  <div className="config-card-badges">
                    {renderCardBadges(item)}
                  </div>
                )}
                <div className="card-path">{item.path}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="config-detail-pane">
        {selectedItem ? (
          <>
            <div className="config-detail-header">
              <div className="config-detail-path">{selectedItem.path}</div>
              <div className="toolbar-right">
                {!editing ? (
                  <button
                    onClick={() => setEditing(true)}
                    disabled={loadingContent || busy}
                  >
                    编辑
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => void save()}
                      disabled={busy || !dirty}
                    >
                      {busy ? "保存中…" : "保存"}
                    </button>
                    <button onClick={cancelEdit} disabled={busy}>
                      取消
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="status-row">
              {detailError && <span className="err">{detailError}</span>}
              {status && <span className="ok">{status}</span>}
            </div>
            {loadingContent ? (
              <div className="config-empty-state">读取中…</div>
            ) : (
              <textarea
                className="json-editor config-markdown-editor"
                spellCheck={false}
                value={draft}
                readOnly={!editing}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </>
        ) : (
          <div className="config-empty-state">
            <div className="muted">请选择左侧文件</div>
          </div>
        )}
      </div>
    </div>
  );
}

function truncateDescription(text: string, max = 120) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return "(无描述)";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

let mcpRowId = 0;

function createKeyValueRow(key: string, value: string): McpKeyValueRow {
  mcpRowId += 1;
  return {
    id: `mcp-row-${mcpRowId}`,
    key,
    value,
  };
}

function cloneMcpServer(server: McpServer): McpServer {
  if (server.transport === "stdio") {
    return {
      ...server,
      args: [...server.args],
      env: { ...server.env },
    };
  }

  return {
    ...server,
    headers: { ...server.headers },
  };
}

function cloneInvalidServer(server: McpInvalidServer): McpInvalidServer {
  return {
    name: server.name,
    raw: server.raw,
  };
}

function sameServers(left: McpServer[], right: McpServer[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameInvalid(left: McpInvalidServer[], right: McpInvalidServer[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createEmptyMcpServer(
  transport: McpTransport,
  existing: McpServer[]
): McpServer {
  const name = nextMcpServerName(transport, existing);
  if (transport === "stdio") {
    return {
      name,
      transport,
      command: "",
      args: [],
      env: {},
    };
  }

  return {
    name,
    transport,
    url: "",
    headers: {},
  };
}

function nextMcpServerName(transport: McpTransport, existing: McpServer[]): string {
  const used = new Set(existing.map((server) => server.name));
  const base = `${transport}_server`;
  let suffix = 1;
  let candidate = base;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}

function serverToForm(server: McpServer): McpServerForm {
  if (server.transport === "stdio") {
    return {
      name: server.name,
      transport: "stdio",
      command: server.command,
      args: [...server.args],
      env: Object.entries(server.env).map(([key, value]) => createKeyValueRow(key, value)),
    };
  }

  return {
    name: server.name,
    transport: server.transport,
    url: server.url,
    headers: Object.entries(server.headers).map(([key, value]) =>
      createKeyValueRow(key, value)
    ),
  };
}

function formToServer(form: McpServerForm): McpServer {
  const name = form.name.trim();
  if (form.transport === "stdio") {
    return {
      name,
      transport: "stdio",
      command: form.command.trim(),
      args: [...form.args],
      env: rowsToRecord(form.env),
    };
  }

  return {
    name,
    transport: form.transport,
    url: form.url.trim(),
    headers: rowsToRecord(form.headers),
  };
}

function rowsToRecord(rows: McpKeyValueRow[]) {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] = row.value;
  }
  return out;
}

function validateMcpForm(
  form: McpServerForm,
  draft: McpServer[],
  index: number
): string | null {
  const name = form.name.trim();
  if (!name) return "name 必填";
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return "name 只能包含字母、数字、下划线和中划线";
  }

  const duplicate = draft.some(
    (server, currentIndex) => currentIndex !== index && server.name === name
  );
  if (duplicate) {
    return "name 不能重复";
  }

  if (form.transport === "stdio") {
    if (!form.command.trim()) {
      return "command 必填";
    }
    return validateKeyValueRows(form.env, "环境变量名");
  }

  if (!/^https?:\/\//.test(form.url.trim())) {
    return "url 必须以 http:// 或 https:// 开头";
  }
  return validateKeyValueRows(form.headers, "Header 名称");
}

function validateKeyValueRows(rows: McpKeyValueRow[], label: string): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && row.value.length > 0) {
      return `${label}不能为空`;
    }
    if (!key) continue;
    if (seen.has(key)) {
      return `${label}不能重复`;
    }
    seen.add(key);
  }
  return null;
}

function summarizeMcpServer(server: McpServer) {
  if (server.transport === "stdio") {
    const commandLine = [server.command, ...server.args].filter(Boolean).join(" ");
    return truncateText(commandLine || "(未配置 command)", 80);
  }
  return truncateText(server.url || "(未配置 URL)", 80);
}

function truncateText(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatInvalidServer(raw: unknown) {
  try {
    return truncateText(JSON.stringify(raw), 120);
  } catch {
    return String(raw);
  }
}
