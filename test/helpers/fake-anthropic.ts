import http from "node:http";
import type { AddressInfo } from "node:net";

/** 偽の入口に届いた要求の記録 */
export interface RecordedRequest {
  method: string;
  url: string;
  /** x-api-key ヘッダ */
  apiKey?: string;
  /** authorization ヘッダ（Bearer を含む全体） */
  authorization?: string;
  /** body の JSON（読めなければ undefined） */
  body?: AnthropicBody;
}

export interface AnthropicBody {
  model?: string;
  stream?: boolean;
  tools?: { name: string }[];
  tool_choice?: unknown;
  messages?: {
    role: string;
    content: string | { type: string; [key: string]: unknown }[];
  }[];
  [key: string]: unknown;
}

/** 偽の入口が返す1回分の答え */
export type Reply =
  | { kind: "text"; text: string }
  | {
      kind: "tool_use";
      calls: { name: string; input: unknown }[];
      /** 返す usage の input/output のトークン */
    }
  | { kind: "http"; status: number; body: unknown }
  /** 返事をしない（接続は開けたまま） */
  | { kind: "hang" };

export type Handler = (body: AnthropicBody, nth: number) => Reply;

export interface FakeAnthropic {
  /** http://127.0.0.1:〈ポート〉 */
  url: string;
  requests: RecordedRequest[];
  /** /v1/messages への要求だけ */
  messages: () => RecordedRequest[];
  /** 答え方を差し替える */
  setHandler: (handler: Handler) => void;
  close: () => Promise<void>;
}

export const FAKE_USAGE = { input_tokens: 11, output_tokens: 7 };

const hasToolResult = (body: AnthropicBody): boolean =>
  (body.messages ?? []).some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((block) => block.type === "tool_result"),
  );

/** 最後の tool_result の文字列（Bash の出力など）。なければ空 */
export function lastToolResultText(body: AnthropicBody): string {
  for (const message of [...(body.messages ?? [])].reverse()) {
    if (!Array.isArray(message.content)) continue;
    for (const block of [...message.content].reverse()) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content))
        return content
          .map((c) => (typeof c?.text === "string" ? c.text : ""))
          .join("");
    }
  }
  return "";
}

/**
 * 既定の答え方。
 * - 道具に StructuredOutput があれば（claude の --json-schema）、
 *   `claude.bash` があるうちは最初に Bash を呼び、そのあと structured を返す
 * - それ以外で道具があれば、その最初の道具を呼ぶ
 * - 道具がなければ短い文を返す
 */
export function defaultHandler(
  options: {
    /** StructuredOutput に渡す中身 */
    structured?: unknown | ((body: AnthropicBody) => unknown);
    /** 最初の周で Bash に渡すコマンド */
    bash?: string;
  } = {},
): Handler {
  return (body) => {
    const tools = body.tools ?? [];
    const structuredTool = tools.find((t) => t.name === "StructuredOutput");
    if (structuredTool) {
      if (
        options.bash !== undefined &&
        !hasToolResult(body) &&
        tools.some((t) => t.name === "Bash")
      )
        return {
          kind: "tool_use",
          calls: [{ name: "Bash", input: { command: options.bash } }],
        };
      const value =
        typeof options.structured === "function"
          ? (options.structured as (b: AnthropicBody) => unknown)(body)
          : (options.structured ?? { findings: [] });
      return {
        kind: "tool_use",
        calls: [{ name: "StructuredOutput", input: value }],
      };
    }
    if (tools.length > 0)
      return {
        kind: "tool_use",
        calls: [{ name: tools[0]!.name, input: {} }],
      };
    return { kind: "text", text: "pong" };
  };
}

function messageObject(body: AnthropicBody, reply: Reply, id: string) {
  const content =
    reply.kind === "text"
      ? [{ type: "text", text: reply.text }]
      : reply.kind === "tool_use"
        ? reply.calls.map((call, i) => ({
            type: "tool_use",
            id: `toolu_fake_${id}_${i}`,
            name: call.name,
            input: call.input,
          }))
        : [];
  return {
    id: `msg_fake_${id}`,
    type: "message",
    role: "assistant",
    model: body.model ?? "unknown",
    content,
    stop_reason: reply.kind === "tool_use" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: FAKE_USAGE,
  };
}

function sseEvents(message: ReturnType<typeof messageObject>): string {
  const out: string[] = [];
  const emit = (event: string, data: unknown) =>
    out.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("message_start", {
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: FAKE_USAGE.input_tokens, output_tokens: 1 },
    },
  });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      emit("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      emit("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: (block as { text: string }).text },
      });
    } else {
      const call = block as { id: string; name: string; input: unknown };
      emit("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: {},
        },
      });
      emit("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(call.input),
        },
      });
    }
    emit("content_block_stop", { type: "content_block_stop", index });
  });
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: FAKE_USAGE.output_tokens },
  });
  emit("message_stop", { type: "message_stop" });
  return out.join("");
}

/** 127.0.0.1 の空きポートで、Anthropic 互換の偽の入口を起動する。届いた要求を全部記録する */
export async function startFakeAnthropic(
  handler: Handler = defaultHandler(),
): Promise<FakeAnthropic> {
  let current = handler;
  let nth = 0;
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: AnthropicBody | undefined;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
      const header = (name: string) => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        apiKey: header("x-api-key"),
        authorization: header("authorization"),
        body,
      });

      const url = (req.url ?? "").split("?")[0];
      if (url === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (req.method !== "POST" || url !== "/v1/messages" || !body) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "not_found_error", message: "not found" },
          }),
        );
        return;
      }
      const reply = current(body, nth++);
      if (reply.kind === "hang") return;
      if (reply.kind === "http") {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
        return;
      }
      const message = messageObject(body, reply, String(nth));
      if (body.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.end(sseEvents(message));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    messages: () =>
      requests.filter((r) => r.url.split("?")[0] === "/v1/messages"),
    setHandler: (next) => {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** 記録のキーが全部 local か。本物のキーが送られていない確かめ用。キーのない要求は数えない */
export function allKeysAreLocal(requests: readonly RecordedRequest[]): boolean {
  return requests.every(
    (r) =>
      (r.apiKey === undefined || r.apiKey === "local") &&
      (r.authorization === undefined || r.authorization === "Bearer local"),
  );
}
