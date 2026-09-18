// Reads a MetaMCP gateway (metatool-ai) over its public OpenAPI endpoint.
// Tool ids there are `<server>__<tool>`, which is enough to list the MCP
// servers a namespace aggregates without touching the gateway's database.

export interface MetaMcpServer {
  readonly name: string;
  readonly tools: number;
}

export interface MetaMcpNamespace {
  readonly namespace: string;
  readonly url: string;
  readonly servers: MetaMcpServer[];
  readonly error: string | null;
  readonly fetchedAt: number;
}

export async function fetchNamespace(
  baseUrl: string,
  namespace: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MetaMcpNamespace> {
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}/metamcp/${encodeURIComponent(namespace)}/api/openapi.json`;
  const base = { namespace, url, servers: [] as MetaMcpServer[], fetchedAt: Date.now() };
  try {
    const response = await fetch(url, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      return { ...base, error: `HTTP ${response.status}` };
    }
    const document = (await response.json()) as { paths?: Record<string, unknown> };
    const counts = new Map<string, number>();
    for (const route of Object.keys(document.paths ?? {})) {
      const tool = route.replace(/^\//, "");
      const cut = tool.indexOf("__");
      const server = cut === -1 ? "(без сервера)" : tool.slice(0, cut);
      counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    const servers = [...counts.entries()]
      .map(([name, tools]) => ({ name, tools }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ...base, servers, error: null };
  } catch (cause) {
    return { ...base, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function fetchGateway(
  baseUrl: string,
  namespaces: readonly string[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<MetaMcpNamespace[]> {
  return Promise.all(
    namespaces.map((namespace) => fetchNamespace(baseUrl, namespace, apiKey, signal)),
  );
}
