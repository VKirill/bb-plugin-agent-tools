// A focused TOML reader/writer for Codex's `[mcp_servers.*]` tables. Editing
// is done on the text, not on a re-serialized document, so comments, ordering
// and every unrelated setting in config.toml survive untouched.

type Raw = Record<string, unknown>;

interface SectionRange {
  readonly name: string;
  readonly start: number; // inclusive line index of the header
  readonly end: number; // exclusive
}

const HEADER = /^\s*\[([^\]]+)\]\s*$/;

/** Split a dotted TOML key path, honouring quoted segments. */
function splitPath(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "." && !quoted) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

function parseValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    try {
      return JSON.parse(trimmed.startsWith("'") ? `"${trimmed.slice(1, -1)}"` : trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed.replace(/,\s*\]$/, "]"));
    } catch {
      return [];
    }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

/** Join a multi-line array value into one logical line. */
function logicalLines(lines: readonly string[]): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let text = lines[index]!;
    if (/=\s*\[[^\]]*$/.test(text)) {
      let cursor = index;
      while (cursor + 1 < lines.length && !text.includes("]")) {
        cursor += 1;
        text += lines[cursor]!.trim();
      }
      out.push({ text, index });
      index = cursor;
      continue;
    }
    out.push({ text, index });
  }
  return out;
}

/** Every `[mcp_servers.<name>]` table, with its sub-tables folded in. */
export function readServers(source: string, pointer = "mcp_servers"): Record<string, Raw> {
  const lines = source.split("\n");
  const servers: Record<string, Raw> = {};
  let path: string[] = [];
  for (const { text } of logicalLines(lines)) {
    const header = HEADER.exec(text);
    if (header !== null) {
      path = splitPath(header[1]!);
      if (path[0] === pointer && path.length >= 2) servers[path[1]!] ??= {};
      continue;
    }
    if (path[0] !== pointer || path.length < 2) continue;
    const separator = text.indexOf("=");
    if (separator === -1 || text.trim().startsWith("#")) continue;
    const key = text.slice(0, separator).trim().replace(/^"|"$/g, "");
    if (key === "") continue;
    const value = parseValue(text.slice(separator + 1));
    const server = servers[path[1]!]!;
    if (path.length === 2) {
      server[key] = value;
      continue;
    }
    const nested = (server[path[2]!] ??= {}) as Raw;
    nested[key] = value;
  }
  return servers;
}

function ranges(source: string, pointer: string): SectionRange[] {
  const lines = source.split("\n");
  const found: SectionRange[] = [];
  let open: { name: string; start: number } | null = null;
  lines.forEach((line, index) => {
    const header = HEADER.exec(line);
    if (header === null) return;
    const path = splitPath(header[1]!);
    const belongs = path[0] === pointer && path.length >= 2;
    if (open !== null && (!belongs || path[1] !== open.name)) {
      found.push({ name: open.name, start: open.start, end: index });
      open = null;
    }
    if (belongs && open === null) open = { name: path[1]!, start: index };
  });
  if (open !== null) {
    found.push({ name: open!.name, start: open!.start, end: lines.length });
  }
  return found;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function renderTable(header: string, values: Raw): string[] {
  const scalars: string[] = [`[${header}]`];
  const tables: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      scalars.push(`${key} = [${value.map((item) => quote(String(item))).join(", ")}]`);
      continue;
    }
    if (value !== null && typeof value === "object") {
      const nested = Object.entries(value as Raw);
      if (nested.length === 0) continue;
      tables.push("", `[${header}.${key}]`);
      for (const [nestedKey, nestedValue] of nested) {
        tables.push(`${quoteKey(nestedKey)} = ${quote(String(nestedValue))}`);
      }
      continue;
    }
    scalars.push(
      `${key} = ${typeof value === "string" ? quote(value) : String(value)}`,
    );
  }
  return [...scalars, ...tables];
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : quote(key);
}

export function removeServer(source: string, name: string, pointer = "mcp_servers"): string {
  const lines = source.split("\n");
  const target = ranges(source, pointer).find((range) => range.name === name);
  if (target === undefined) return source;
  let start = target.start;
  // Take the comment block and blank lines immediately above the table with it.
  while (start > 0 && lines[start - 1]!.trim() === "") start -= 1;
  lines.splice(start, target.end - start);
  return lines.join("\n");
}

export function upsertServer(
  source: string,
  name: string,
  values: Raw,
  pointer = "mcp_servers",
): string {
  const without = removeServer(source, name, pointer);
  const body = renderTable(`${pointer}.${quoteKey(name)}`, values);
  const base = without.replace(/\s*$/, "");
  return `${base}\n\n${body.join("\n")}\n`;
}
