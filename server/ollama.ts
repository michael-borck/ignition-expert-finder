/**
 * Client for the remote Ollama endpoint.
 *
 * One model, gemma4:12b, which is multimodal so it covers both plain text and
 * slide images. Do not add a second: the endpoint preloads this one into VRAM
 * and switching would evict it and stall every request.
 *
 * `think` is set per call rather than globally, and the difference is large.
 * Measured against this endpoint:
 *
 *   chat reply        think on  17.4s (16.1s to first token)   off  3.0s (1.2s)
 *   structured pass   think on  43s                            off  11.5s
 *
 * Fast is not automatically better. With thinking off, the weakest-three areas
 * stopped agreeing across identical runs at temperature 0 - and that ranking is
 * what chooses the experts, so two founders giving the same answers could be
 * sent to different people. Conversation turns therefore run with thinking off
 * for responsiveness, and the single extraction that drives the recommendation
 * runs with it on.
 */

const BASE = (process.env.OLLAMA_BASE_URL ?? "").replace(/\/$/, "");
const KEY = process.env.OLLAMA_API_KEY ?? "";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:12b";
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT ?? 180) * 1000;

export const ollamaConfigured = () => Boolean(BASE);

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  /** base64 PNGs, for slide pages. */
  images?: string[];
}

interface CallOptions {
  think: boolean;
  format?: unknown;
  temperature?: number;
  signal?: AbortSignal;
}

function body(messages: Message[], o: CallOptions, stream: boolean) {
  return JSON.stringify({
    model: MODEL,
    messages,
    stream,
    think: o.think,
    // No keep_alive: the endpoint owns the preload policy, and sending our own
    // value would reset its unload timer.
    options: { temperature: o.temperature ?? 0 },
    ...(o.format ? { format: o.format } : {}),
  });
}

async function post(messages: Message[], o: CallOptions, stream: boolean) {
  if (!BASE) throw new Error("OLLAMA_BASE_URL is not set");
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: body(messages, o, stream),
    signal: o.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res;
}

/** Single response, no streaming. Used for the structured extraction. */
export async function complete(messages: Message[], o: CallOptions): Promise<string> {
  const res = await post(messages, o, false);
  return (await res.json()).message?.content ?? "";
}

/** Token-by-token, for conversation turns where waiting on a spinner is the
 *  difference between a usable chat and an abandoned one. */
export async function* stream(
  messages: Message[],
  o: CallOptions,
): AsyncGenerator<string> {
  const res = await post(messages, o, true);
  if (!res.body) throw new Error("Ollama returned no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Ollama emits newline-delimited JSON; a chunk can split a line in half.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: { message?: { content?: string }; done?: boolean };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // partial or malformed line; the next chunk completes it
      }
      const text = parsed.message?.content;
      if (text) yield text;
      if (parsed.done) return;
    }
  }
}

/**
 * Ask for JSON matching a schema and parse it.
 *
 * Ollama constrains generation to the schema, so a parse failure means
 * something went wrong upstream rather than the model rambling - worth
 * surfacing rather than silently retrying.
 */
export async function completeJSON<T>(
  messages: Message[],
  schema: unknown,
  o: Omit<CallOptions, "format">,
): Promise<T> {
  const raw = await complete(messages, { ...o, format: schema });
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`model did not return valid JSON: ${raw.slice(0, 200)}`);
  }
}
