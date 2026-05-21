import {
  commands,
  type ConfigFile as BConfigFile,
  type WriteResult as BWriteResult,
  type SkillInfo as BSkillInfo,
  type AgentInfo as BAgentInfo,
  type CommandInfo as BCommandInfo,
  type PluginInfo as BPluginInfo,
  type ModelOption as BModelOption,
} from "./bindings";

export type ConfigKind = "settings" | "settings_local";

export type ConfigFile = BConfigFile;
export type WriteResult = BWriteResult;
export type SkillInfo = BSkillInfo;
export type AgentInfo = BAgentInfo;
export type CommandInfo = BCommandInfo;
export type PluginInfo = BPluginInfo;
export type ModelOption = BModelOption;

export type McpServerStdio = {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type McpServerHttp = {
  name: string;
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
};

export type McpServer = McpServerStdio | McpServerHttp;

export type ParseResult = {
  servers: McpServer[];
  invalid: { name: string; raw: unknown }[];
};

function unwrap<T>(
  r: { status: "ok"; data: T } | { status: "error"; error: string }
): T {
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export async function listModels(): Promise<ModelOption[]> {
  return unwrap(await commands.listModels());
}

export async function readConfig(kind: ConfigKind): Promise<ConfigFile> {
  return unwrap(await commands.readConfig(kind));
}

export async function writeConfig(
  kind: ConfigKind,
  content: string
): Promise<WriteResult> {
  return unwrap(await commands.writeConfig(kind, content));
}

export async function listSkills(): Promise<SkillInfo[]> {
  return unwrap(await commands.listSkills());
}

export async function listAgents(): Promise<AgentInfo[]> {
  return unwrap(await commands.listAgents());
}

export async function listCommands(): Promise<CommandInfo[]> {
  return unwrap(await commands.listCommands());
}

export async function listPlugins(): Promise<PluginInfo[]> {
  return unwrap(await commands.listPlugins());
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  unwrap(await commands.setPluginEnabled(id, enabled));
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

export function parseMcpServers(settingsJson: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return { servers: [], invalid: [] };
  }

  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return { servers: [], invalid: [] };
  }

  const servers: McpServer[] = [];
  const invalid: { name: string; raw: unknown }[] = [];

  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    const server = parseMcpServerEntry(name, raw);
    if (server) {
      servers.push(server);
    } else {
      invalid.push({ name, raw });
    }
  }

  return { servers, invalid };
}

export function applyMcpServers(
  settingsJson: string,
  servers: McpServer[]
): string {
  let parsed: unknown;
  if (settingsJson.trim() === "") {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(settingsJson);
    } catch {
      throw new Error("settings.json is not valid JSON");
    }
  }

  if (!isRecord(parsed)) {
    throw new Error("settings.json is not valid JSON");
  }

  if (servers.length === 0) {
    delete parsed.mcpServers;
  } else {
    const serialized: Record<string, unknown> = {};
    for (const server of servers) {
      serialized[server.name] = serializeMcpServer(server);
    }
    parsed.mcpServers = serialized;
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function parseMcpServerEntry(name: string, raw: unknown): McpServer | null {
  if (!isRecord(raw)) return null;

  if (typeof raw.url === "string") {
    const headers = toStringRecord(raw.headers);
    if (!headers) return null;
    return {
      name,
      transport: raw.type === "sse" ? "sse" : "http",
      url: raw.url,
      headers,
    };
  }

  if (typeof raw.command === "string") {
    const args = toStringArray(raw.args);
    const env = toStringRecord(raw.env);
    if (!args || !env) return null;
    return {
      name,
      transport: "stdio",
      command: raw.command,
      args,
      env,
    };
  }

  return null;
}

function serializeMcpServer(server: McpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    const value: Record<string, unknown> = {
      command: server.command,
    };
    if (server.args.length > 0) {
      value.args = [...server.args];
    }
    if (Object.keys(server.env).length > 0) {
      value.env = { ...server.env };
    }
    return value;
  }

  const value: Record<string, unknown> = {
    type: server.transport,
    url: server.url,
  };
  if (Object.keys(server.headers).length > 0) {
    value.headers = { ...server.headers };
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string")) return null;
  return [...value];
}

function toStringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;

  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  unwrap(await commands.writeTextFile(filePath, content));
}

export async function readMarkdownFile(path: string): Promise<string> {
  return unwrap(await commands.readMarkdownFile(path));
}
