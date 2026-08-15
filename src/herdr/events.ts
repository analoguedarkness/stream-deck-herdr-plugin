import net from "node:net";
import os from "node:os";
import path from "node:path";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export function herdrSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

// Pure: split an accumulated buffer + new chunk into complete lines and the
// remaining partial line. Keeps multi-chunk JSON lines intact.
export function feedLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
}

// `pane.updated` fires on any pane state change (agent_status included) and
// needs no pane_id. Since herdr 0.8, `pane.agent_status_changed` requires a
// concrete pane_id, which rejects the whole subscribe request — and the server
// honors only one subscribe per connection, so the set must be valid as a whole.
const SUBSCRIBE =
  JSON.stringify({
    id: "sd-sub",
    method: "events.subscribe",
    params: {
      subscriptions: [
        { type: "pane.updated" },
        { type: "pane.created" },
        { type: "pane.closed" },
        { type: "pane.exited" },
        { type: "pane.agent_detected" },
      ],
    },
  }) + "\n";

// Decide which socket lines warrant a refresh. pane_updated fires on every
// pane state change (scroll, terminal titles, output), so refreshing per line
// would spawn `herdr agent list` continuously while an agent streams output.
// Only the fields the deck renders from (agent, status, cwd) count; anything
// unrecognized errs on the side of refreshing. Stateful per connection: keeps
// one fingerprint per pane.
export function createRelevanceFilter(): (line: string) => boolean {
  const seen = new Map<string, string>();
  return (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return true;
    }
    const { event, data } = (msg ?? {}) as {
      event?: unknown;
      data?: { pane_id?: unknown; pane?: { pane_id?: unknown; agent?: unknown; agent_status?: unknown; cwd?: unknown } };
    };
    if (typeof event !== "string") return true; // subscribe acks, errors, unknown shapes
    if (event === "pane_closed" || event === "pane_exited") {
      const id = data?.pane_id ?? data?.pane?.pane_id;
      if (typeof id === "string") seen.delete(id);
      return true;
    }
    if (event !== "pane_updated") return true;
    const pane = data?.pane;
    const id = pane?.pane_id;
    if (typeof id !== "string") return true;
    const fingerprint = `${String(pane?.agent ?? "")}|${String(pane?.agent_status ?? "")}|${String(pane?.cwd ?? "")}`;
    if (seen.get(id) === fingerprint) return false;
    seen.set(id, fingerprint);
    return true;
  };
}

export type EventsClient = { start(): void; stop(): void };

// Calls onChange() whenever herdr emits a subscribed event line (and once on the
// subscribe ack). Auto-reconnects with exponential backoff. Never throws.
export function createHerdrEvents(opts: { onChange: () => void; socketPath?: string }): EventsClient {
  const sockPath = opts.socketPath ?? herdrSocketPath();
  let stopped = false;
  let conn: net.Socket | null = null;
  let backoff = RECONNECT_MIN_MS;

  const connect = (): void => {
    if (stopped) return;
    const c = net.createConnection(sockPath);
    conn = c;
    let buffer = "";
    const relevant = createRelevanceFilter();
    c.on("connect", () => {
      backoff = RECONNECT_MIN_MS;
      c.write(SUBSCRIBE);
    });
    c.on("data", (chunk: Buffer) => {
      const fed = feedLines(buffer, chunk.toString("utf8"));
      buffer = fed.rest;
      // filter (not some): every line must reach the filter so it fingerprints
      // all panes in the chunk, not just up to the first relevant one.
      if (fed.lines.filter(relevant).length > 0) opts.onChange();
    });
    const reconnect = (): void => {
      if (stopped) return;
      c.removeAllListeners();
      if (conn === c) conn = null;
      const wait = backoff;
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      setTimeout(connect, wait);
    };
    c.on("error", reconnect);
    c.on("close", reconnect);
  };

  return {
    start: () => {
      stopped = false;
      connect();
    },
    stop: () => {
      stopped = true;
      conn?.destroy();
      conn = null;
    },
  };
}
