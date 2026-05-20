import { invoke } from "@tauri-apps/api/core";

export type ConfigKind = "settings" | "settings_local";

export type ConfigFile = {
  kind: ConfigKind;
  path: string;
  exists: boolean;
  content: string;
  valid_json: boolean;
  parse_error: string | null;
};

export type WriteResult = {
  path: string;
  backup: string | null;
};

export type SkillInfo = {
  name: string;
  description: string;
  source: string;
  path: string;
};

export type PluginInfo = {
  id: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  install_path: string | null;
};

export type ModelOption = {
  id: string;
  family: string;
  label: string;
  thinking: boolean;
  context_1m: boolean;
  source: string;
};

export async function listModels(): Promise<ModelOption[]> {
  return await invoke<ModelOption[]>("list_models");
}

export async function readConfig(kind: ConfigKind): Promise<ConfigFile> {
  return await invoke<ConfigFile>("read_config", { kind });
}

export async function writeConfig(
  kind: ConfigKind,
  content: string
): Promise<WriteResult> {
  return await invoke<WriteResult>("write_config", { kind, content });
}

export async function listSkills(): Promise<SkillInfo[]> {
  return await invoke<SkillInfo[]>("list_skills");
}

export async function listPlugins(): Promise<PluginInfo[]> {
  return await invoke<PluginInfo[]>("list_plugins");
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke("set_plugin_enabled", { id, enabled });
}

const SECRET_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /apikey/i,
  /api[_-]?key/i,
  /auth/i,
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

export function maskSecretsInJsonText(content: string): string {
  try {
    const value = JSON.parse(content);
    const masked = maskValue(value, []);
    return JSON.stringify(masked, null, 2);
  } catch {
    return content;
  }
}

function maskValue(v: unknown, path: string[]): unknown {
  if (Array.isArray(v)) return v.map((item, i) => maskValue(item, [...path, String(i)]));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isSecretKey(k) && typeof val === "string" && val.length > 0) {
        out[k] = maskString(val);
      } else {
        out[k] = maskValue(val, [...path, k]);
      }
    }
    return out;
  }
  return v;
}

function maskString(s: string): string {
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}••••${s.slice(-2)}`;
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await invoke("write_text_file", { filePath, content });
}
