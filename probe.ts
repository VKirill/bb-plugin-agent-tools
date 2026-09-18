// Живая проверка MCP-сервера: тот же handshake, что делает любой MCP-клиент —
// `initialize`, затем `tools/list`. Выполняется только по явной команде
// пользователя: для stdio это запуск настоящего процесса на его машине.
import { spawn } from "node:child_process";
import type { McpServer } from "./contract.js";

const CLIENT = { name: "bb-mcp-catalog", version: "0.1.0" };
const PROTOCOL = "2025-06-18";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT },
};
const toolsRequest = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

export interface ProbeOutcome {
  ok: boolean;
  tools: number | null;
  error: string | null;
}

/** Подставляет ${VAR} из окружения машины — так же, как это делают сами CLI. */
function expand(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function expandRecord(record?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) out[key] = expand(value);
  return out;
}

function countTools(payload: unknown): number | null {
  const tools = (payload as { result?: { tools?: unknown[] } } | null)?.result?.tools;
  return Array.isArray(tools) ? tools.length : null;
}

function isError(payload: unknown): string | null {
  const error = (payload as { error?: { message?: string; code?: number } } | null)?.error;
  if (error === undefined || error === null) return null;
  return error.message ?? `код ${error.code ?? "?"}`;
}

/** Один JSON-RPC ответ: тело либо JSON, либо поток SSE с кадрами `data:`. */
function parseBody(contentType: string, text: string): unknown[] {
  if (!contentType.includes("text/event-stream")) {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }
  const payloads: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      payloads.push(JSON.parse(line.slice(5).trim()));
    } catch {
      // кадр не JSON — пропускаем
    }
  }
  return payloads;
}

async function probeHttp(server: McpServer, timeoutMs: number): Promise<ProbeOutcome> {
  const url = server.url;
  if (url === undefined) return { ok: false, tools: null, error: "нет адреса" };
  const headers: Record<string, string> = {
    ...expandRecord(server.headers),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const call = async (body: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      sessionId: response.headers.get("mcp-session-id"),
      payloads: parseBody(response.headers.get("content-type") ?? "", text),
      text,
    };
  };

  const first = await call(initializeRequest);
  if (!first.ok) return { ok: false, tools: null, error: `HTTP ${first.status}` };
  const handshake = first.payloads.find((payload) => (payload as { id?: number }).id === 1);
  const handshakeError = isError(handshake);
  if (handshakeError !== null) return { ok: false, tools: null, error: handshakeError };
  if (handshake === undefined) {
    return { ok: false, tools: null, error: "ответ без результата initialize" };
  }
  if (first.sessionId !== null) headers["mcp-session-id"] = first.sessionId;

  try {
    const second = await call(toolsRequest);
    const list = second.payloads.find((payload) => (payload as { id?: number }).id === 2);
    return { ok: true, tools: countTools(list), error: null };
  } catch {
    // сервер ответил на handshake — этого достаточно, чтобы считать его живым
    return { ok: true, tools: null, error: null };
  }
}

async function probeStdio(server: McpServer, timeoutMs: number): Promise<ProbeOutcome> {
  const command = server.command;
  if (command === undefined) return { ok: false, tools: null, error: "нет команды" };
  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(expand(command), (server.args ?? []).map(expand), {
        env: { ...process.env, ...expandRecord(server.env) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      resolve({
        ok: false,
        tools: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }

    const timer = setTimeout(() => finish({ ok: false, tools: null, error: "нет ответа за отведённое время" }), timeoutMs);
    let stdout = "";
    let stderr = "";
    let handshakeDone = false;

    child.on("error", (cause: Error) => {
      finish({
        ok: false,
        tools: null,
        error: cause.message.includes("ENOENT") ? "команда не найдена" : cause.message,
      });
    });
    child.on("exit", (code) => {
      const tail = stderr.trim().split("\n").pop() ?? "";
      finish({
        ok: false,
        tools: null,
        error: `процесс завершился (код ${code ?? "?"})${tail === "" ? "" : `: ${tail.slice(0, 160)}`}`,
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let cut = stdout.indexOf("\n");
      while (cut !== -1) {
        const line = stdout.slice(0, cut).trim();
        stdout = stdout.slice(cut + 1);
        cut = stdout.indexOf("\n");
        if (line === "") continue;
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          continue; // сервер может писать в stdout свои логи
        }
        const id = (payload as { id?: number }).id;
        const failure = isError(payload);
        if (id === 1) {
          if (failure !== null) {
            finish({ ok: false, tools: null, error: failure });
            return;
          }
          handshakeDone = true;
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin?.write(`${JSON.stringify(toolsRequest)}\n`);
          continue;
        }
        if (id === 2 && handshakeDone) {
          finish({ ok: true, tools: countTools(payload), error: null });
          return;
        }
      }
    });

    child.stdin?.on("error", () => {
      /* сервер мог закрыть поток — это увидим по exit */
    });
    child.stdin?.write(`${JSON.stringify(initializeRequest)}\n`);
  });
}

export async function probeServer(server: McpServer, timeoutMs: number): Promise<ProbeOutcome> {
  if (server.disabled === true) return { ok: false, tools: null, error: "выключен в конфиге" };
  try {
    return server.transport === "stdio"
      ? await probeStdio(server, timeoutMs)
      : await probeHttp(server, timeoutMs);
  } catch (cause) {
    return { ok: false, tools: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
