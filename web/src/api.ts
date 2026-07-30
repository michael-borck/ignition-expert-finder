/** Thin API client. Every call carries the session id so the event log can
 *  stitch a founder's journey together without any server-side session state. */

import type { Area, Clinician, Pathway, Recommendation, Stage } from "../../shared/types.ts";

let sessionId: string | null = null;

/**
 * Every startup call goes through here so a broken API surfaces as a message
 * rather than a spinner that never resolves.
 *
 * The timeout is the important part: a proxy pointed at a port where something
 * is listening but not answering will hang indefinitely, and the founder just
 * sees "loading" forever with no clue why.
 */
async function apiCall(path: string, init: RequestInit = {}): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(path, { ...init, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new Error(
      e instanceof DOMException && e.name === "TimeoutError"
        ? `The server did not respond. Is the API running, and is the dev proxy pointed at its port?`
        : `Could not reach the server. Check that it is running.`,
    );
  }
  if (!r.ok) throw new Error(`The server returned ${r.status} for ${path}.`);
  return r;
}

export async function startSession(): Promise<string> {
  if (sessionId) return sessionId;
  const r = await apiCall("/api/session", { method: "POST" });
  sessionId = (await r.json()).sessionId;
  return sessionId!;
}

export async function getBench(): Promise<{
  ready: boolean;
  areas: Area[];
  clinicians: Clinician[];
  stages: Stage[];
  disclaimer: string;
  chatAvailable: boolean;
}> {
  const r = await apiCall("/api/bench");
  return r.json();
}

/**
 * Fire-and-forget tracking. Deliberately never awaited by callers and never
 * throws: a founder's flow must not stall or break because the log is
 * unreachable.
 */
export function track(type: string, pathway?: Pathway, payload?: unknown): void {
  if (!sessionId) return;
  void fetch("/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, pathway, type, payload }),
  }).catch(() => {});
}

export async function getRecommendation(
  pathway: Pathway,
  scores: { area: string; confidence: number }[],
): Promise<Recommendation> {
  const r = await fetch("/api/recommend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, pathway, scores }),
  });
  if (!r.ok) throw new Error("could not build a recommendation");
  return r.json();
}

export interface UploadResult {
  kind: string;
  pages?: number;
  usable: boolean;
  characters: number;
  text: string;
  /** A deck exported as slide images: readable, but a vision call per page. */
  renderable?: boolean;
  renderablePages?: number;
}

/**
 * `render` asks the server to read the slides as images. Only offered after
 * text extraction came back empty, and only once the founder has agreed to
 * wait - so the file is deliberately sent a second time rather than held on
 * the server between the two calls.
 */
export async function uploadDocument(file: File, render = false): Promise<UploadResult> {
  const form = new FormData();
  form.append("sessionId", sessionId ?? "");
  form.append("file", file);
  // No timeout: a large PDF legitimately takes a while, and reading slides is
  // slower still. Aborting mid-parse would look like a rejected file.
  const r = await fetch(`/api/upload${render ? "?render=1" : ""}`, {
    method: "POST",
    body: form,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "that file could not be read");
  return data;
}

/**
 * Stream a conversation turn, calling `onChunk` as text arrives.
 *
 * Streaming is the whole point: the reply completes in about 3s, but tokens
 * start appearing in about 1s, and that difference is what makes it feel like
 * a conversation rather than a form submission.
 */
export async function streamChat(
  messages: { role: string; content: string }[],
  documentText: string | undefined,
  onChunk: (text: string) => void,
): Promise<string> {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, messages, documentText }),
  });
  if (!r.ok || !r.body) {
    const detail = await r.text().catch(() => "");
    throw new Error(detail.slice(0, 200) || "the assistant is unavailable");
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    full += text;
    onChunk(text);
  }
  return full;
}

/** The slow call. Runs with thinking on, so allow minutes rather than seconds. */
export async function analyseConversation(
  messages: { role: string; content: string }[],
  documentText?: string,
): Promise<Recommendation> {
  const r = await fetch("/api/analyse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, messages, documentText }),
    signal: AbortSignal.timeout(240_000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "could not analyse the conversation");
  return data;
}

/**
 * Three questions to take into each clinic.
 *
 * Requested after the shortlist is on screen, so it never delays it. A failure
 * here is not worth surfacing - the founder still has everything they need.
 */
export async function fetchQuestions(
  pathway: Pathway,
  areas: { areaId: string; clinicianId: string; evidence?: string }[],
): Promise<Record<string, string[]>> {
  const r = await fetch("/api/questions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, pathway, areas }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error("questions unavailable");
  return r.json();
}

/** Never awaited, never throws: a founder should not see an error about
 *  telemetry after being handed their shortlist. */
export function sendFeedback(pathway: Pathway, helpful: boolean, comment?: string): void {
  void fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, pathway, helpful, comment }),
  }).catch(() => {});
}
