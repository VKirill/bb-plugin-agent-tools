// Translation between each CLI's config dialect and the normalized McpServer,
// plus the comparison and "machine-bound" rules the catalogue relies on.
import type { McpStyle } from "./agents";
import type { McpServer } from "./contract";

type Raw = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const strArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

const strRecord = (value: unknown): Record<string, string> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Raw)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Read one entry of a server map written in `style`. */
export function fromDialect(
  style: McpStyle,
  name: string,
  value: unknown,
): McpServer | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Raw;
  const disabled =
    raw.disabled === true || raw.enabled === false || raw.enable === false
      ? true
      : undefined;

  if (style === "opencode") {
    const type = str(raw.type);
    if (type === "remote") {
      const url = str(raw.url);
      if (url === undefined) return null;
      return {
        name,
        transport: "http",
        url,
        headers: strRecord(raw.headers),
        disabled,
      };
    }
    const parts = strArray(raw.command) ?? [];
    if (parts.length === 0) return null;
    return {
      name,
      transport: "stdio",
      command: parts[0],
      args: parts.length > 1 ? parts.slice(1) : undefined,
      env: strRecord(raw.environment) ?? strRecord(raw.env),
      disabled,
    };
  }

  const url = str(raw.url) ?? str(raw.serverUrl) ?? str(raw.serverURL) ?? str(raw.httpUrl);
  const command = str(raw.command);
  if (command !== undefined) {
    return {
      name,
      transport: "stdio",
      command,
      args: strArray(raw.args),
      env: strRecord(raw.env),
      disabled,
    };
  }
  if (url !== undefined) {
    const declared = str(raw.type) ?? str(raw.transport) ?? str(raw.transportType);
    return {
      name,
      transport: declared === "sse" ? "sse" : "http",
      url,
      headers: strRecord(raw.headers) ?? strRecord(raw.http_headers),
      disabled,
    };
  }
  return null;
}

/** Render a server back into `style`. */
export function toDialect(style: McpStyle, server: McpServer): Raw {
  if (style === "opencode") {
    if (server.transport === "stdio") {
      const out: Raw = {
        type: "local",
        command: [server.command ?? "", ...(server.args ?? [])],
        enabled: server.disabled !== true,
      };
      if (server.env !== undefined) out.environment = server.env;
      return out;
    }
    const out: Raw = { type: "remote", url: server.url ?? "", enabled: server.disabled !== true };
    if (server.headers !== undefined) out.headers = server.headers;
    return out;
  }

  if (style === "codex-toml" || style === "grok-toml") {
    const out: Raw =
      server.transport === "stdio"
        ? { command: server.command ?? "" }
        : { url: server.url ?? "" };
    if (server.transport === "stdio") {
      if (server.args !== undefined && server.args.length > 0) out.args = server.args;
      if (server.env !== undefined) out.env = server.env;
    } else if (server.headers !== undefined) {
      if (style === "codex-toml") out.http_headers = server.headers;
      else out.headers = server.headers;
    }
    // Grok writes the flag explicitly, so mirror it instead of relying on a default.
    out.enabled = server.disabled !== true;
    return out;
  }

  if (style === "metamcp") {
    // Конфиг гибридного шлюза: transportType обязателен и пишется явно.
    if (server.transport === "stdio") {
      const out: Raw = { command: server.command ?? "" };
      if (server.args !== undefined && server.args.length > 0) out.args = server.args;
      if (server.env !== undefined) out.env = server.env;
      if (server.disabled === true) out.disabled = true;
      return out;
    }
    const out: Raw = { url: server.url ?? "", transportType: server.transport };
    if (server.headers !== undefined) out.headers = server.headers;
    if (server.disabled === true) out.disabled = true;
    return out;
  }

  if (server.transport === "stdio") {
    const out: Raw = { command: server.command ?? "" };
    if (server.args !== undefined && server.args.length > 0) out.args = server.args;
    if (server.env !== undefined) out.env = server.env;
    if (server.disabled === true) out.disabled = true;
    return out;
  }

  if (style === "antigravity") {
    const out: Raw = { serverUrl: server.url ?? "" };
    if (server.headers !== undefined) out.headers = server.headers;
    if (server.disabled === true) out.disabled = true;
    return out;
  }
  if (style === "gemini") {
    if (server.transport === "sse") {
      const out: Raw = { url: server.url ?? "" };
      if (server.headers !== undefined) out.headers = server.headers;
      if (server.disabled === true) out.disabled = true;
      return out;
    }
    const out: Raw = { httpUrl: server.url ?? "" };
    if (server.headers !== undefined) out.headers = server.headers;
    if (server.disabled === true) out.disabled = true;
    return out;
  }
  const out: Raw = { type: server.transport, url: server.url ?? "" };
  if (server.headers !== undefined) out.headers = server.headers;
  if (server.disabled === true) out.disabled = true;
  return out;
}

/**
 * Ключи, которыми владеет плагин: их он полностью задаёт сам. Всё остальное в
 * записи (таймауты, `bearer_token_env_var`, `cwd`, флаги конкретного CLI)
 * принадлежит пользователю и обязано пережить любую нашу правку.
 */
const CONTROLLED_KEYS = [
  "command",
  "args",
  "env",
  "environment",
  "url",
  "serverUrl",
  "serverURL",
  "httpUrl",
  "headers",
  "http_headers",
  "type",
  "transport",
  "transportType",
  "enabled",
  "disabled",
];

/** Накладывает новую запись на существующую, сохраняя чужие поля. */
export function mergeEntry(existing: unknown, next: Raw): Raw {
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    return next;
  }
  const base: Raw = { ...(existing as Raw) };
  for (const key of CONTROLLED_KEYS) delete base[key];
  return { ...base, ...next };
}

/** Stable signature used to tell "same server" from "configured differently". */
export function signature(server: McpServer): string {
  const sorted = (record?: Record<string, string>) =>
    record === undefined
      ? []
      : Object.entries(record)
          .map(([key, value]) => `${key}=${value}`)
          .sort();
  return JSON.stringify([
    server.transport,
    basename(server.command ?? ""),
    server.args ?? [],
    server.url ?? "",
    sorted(server.env),
    sorted(server.headers),
  ]);
}

/** Commands are compared by executable name: /opt/homebrew/bin/x === /usr/bin/x. */
function basename(command: string): string {
  const cut = command.lastIndexOf("/");
  return cut === -1 ? command : command.slice(cut + 1);
}

export function sameServer(a: McpServer, b: McpServer): boolean {
  return signature(a) === signature(b);
}

const LOOPBACK = /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i;
const PLACEHOLDER = /\$\{[^}]+\}/;
const APP_BUNDLE = /\.app\/|^\/Applications\//;
const GATEWAY_URL = /\/metamcp\/[^/]+\//i;

/**
 * What the entry actually is. A gateway is an entrance to another MCP set, a
 * vendor server ships inside a CLI's own application bundle — neither belongs
 * in the list of servers a user would roll out to other machines.
 */
export type ServerRole = "server" | "gateway" | "vendor";

export function classifyRole(server: McpServer): ServerRole {
  const command = server.command ?? "";
  if (/metamcp/i.test(command) || (server.url !== undefined && GATEWAY_URL.test(server.url))) {
    return "gateway";
  }
  if (APP_BUNDLE.test(command)) return "vendor";
  return "server";
}

/**
 * Machine-bound servers keep their machine: absolute executables, loopback
 * URLs and `${SECRET}` references cannot be copied to another host as-is.
 */
export function classifyLocal(server: McpServer): {
  localOnly: boolean;
  reason: string;
} {
  const command = server.command ?? "";
  if (APP_BUNDLE.test(command)) {
    return { localOnly: true, reason: `внутри приложения: ${command}` };
  }
  if (command.startsWith("./") || command.startsWith("../")) {
    return { localOnly: true, reason: `относительный путь: ${command}` };
  }
  if (command.startsWith("/") && !command.startsWith("/usr/bin/env")) {
    return { localOnly: true, reason: `абсолютный путь: ${command}` };
  }
  for (const arg of server.args ?? []) {
    if (arg.startsWith("/") && arg.includes("/")) {
      return { localOnly: true, reason: `аргумент с локальным путём: ${arg}` };
    }
  }
  if (server.url !== undefined && LOOPBACK.test(server.url)) {
    return { localOnly: true, reason: `адрес на loopback: ${server.url}` };
  }
  const secretSource = JSON.stringify([server.env ?? {}, server.headers ?? {}]);
  if (PLACEHOLDER.test(secretSource)) {
    return { localOnly: true, reason: "ссылка на локальный секрет ${…}" };
  }
  return { localOnly: false, reason: "" };
}
