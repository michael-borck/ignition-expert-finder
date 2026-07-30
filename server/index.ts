/**
 * API and static host for the Expert Finder.
 *
 * Deliberately thin: the bench is read from disk at startup, matching is pure
 * and lives in match.ts, and everything a founder does becomes a row in the
 * event log. There is no per-founder state on the server beyond that log - a
 * session is just an id the browser generates and sends back.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import type { AreaScore, Clinician, Pathway } from "../shared/types.ts";
import { PATHWAYS } from "../shared/types.ts";
import {
  BENCH_PATH,
  HEADSHOTS_PATH,
  SEED_DIR,
  coverage,
  loadBench,
  unreachableAreas,
} from "./bench.ts";
import { matchByName, parseDirectory, toAvatar } from "./directory.ts";
import { Store, type EventType } from "./db.ts";
import {
  analyse,
  describeSlides,
  suggestQuestions,
  INTERVIEW_PROMPT,
  type QuestionRequest,
} from "./chat.ts";
import {
  extract,
  MAX_ADMIN_UPLOAD_BYTES,
  MAX_RENDERED_PAGES,
  MAX_UPLOAD_BYTES,
  renderPages,
} from "./documents.ts";
import { DEFAULT_CAPACITY, recommend } from "./match.ts";
import { ollamaConfigured, stream as ollamaStream, type Message } from "./ollama.ts";
import { diffRoster, parseRoster, slug } from "./roster.ts";
import { ROSTER_HEADER, rosterRows, toCsv, writeSheet } from "./xlsx.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 3210);
const CAPACITY = Number(process.env.CLINIC_CAPACITY ?? DEFAULT_CAPACITY);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";

// Reassigned when an organiser uploads a new roster mid-programme.
let bench = loadBench();
const areasFile = JSON.parse(
  readFileSync(join(ROOT, "data", "areas.json"), "utf8"),
) as { aliases?: Record<string, string>; sector_tags?: string[] };
const store = new Store(process.env.DATABASE_PATH ?? join(ROOT, "data", "expert-finder.sqlite"));

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

/* ---------------------------------------------------------------- bench --- */

/** The directory pathway and every result card read from this. Emails are
 *  included: the founder needs them for the clinic, and the whole bench is
 *  already visible in the printed programme handbook. */
const UPLOAD_DISCLAIMER =
  process.env.UPLOAD_DISCLAIMER ??
  "Your document is read by a private AI model running on Curtin infrastructure. " +
    "It is held only while it is being analysed, is never saved, and never leaves Curtin.";

app.get("/api/bench", async () => ({
  // False until an organiser has uploaded the bench. A fresh deployment ships
  // with no clinician data, so the founder-facing app has to say so rather
  // than offer pathways that can only return nothing.
  ready: bench.clinicians.some((c) => c.active),
  areas: bench.areas,
  stages: bench.stages,
  disclaimer: UPLOAD_DISCLAIMER,
  chatAvailable: ollamaConfigured(),
  clinicians: bench.clinicians.filter((c) => c.active),
}));

/* -------------------------------------------------------------- session --- */

app.post("/api/session", async (req) => {
  const sessionId = randomUUID();
  store.record({ sessionId, pathway: null, type: "session_started" });
  req.log.info({ sessionId }, "session started");
  return { sessionId };
});

/* --------------------------------------------------------------- events --- */

interface EventBody {
  sessionId: string;
  pathway?: Pathway;
  type: EventType;
  payload?: unknown;
}

/**
 * Catch-all tracking endpoint. The Ignition team have not decided what they
 * want to analyse, so the app logs everything and the reporting gets written
 * later against data that already exists.
 */
app.post<{ Body: EventBody }>("/api/events", async (req, reply) => {
  const { sessionId, pathway, type } = req.body ?? {};
  if (!sessionId || !type) {
    return reply.code(400).send({ error: "sessionId and type are required" });
  }
  if (pathway && !PATHWAYS.includes(pathway)) {
    return reply.code(400).send({ error: `unknown pathway: ${pathway}` });
  }
  store.record({ sessionId, pathway: pathway ?? null, type, payload: req.body.payload });
  return { ok: true };
});

/* ------------------------------------------------------------ recommend --- */

interface RecommendBody {
  sessionId: string;
  pathway: Pathway;
  scores: AreaScore[];
}

function buildAndStore(sessionId: string, pathway: Pathway, scores: AreaScore[]) {
  // Read load fresh every time: a cohort works through this simultaneously, so
  // a cached count would send several founders to the same person.
  const result = recommend(
    scores,
    bench.areas,
    bench.clinicians,
    store.primaryCounts(),
    sessionId,
    CAPACITY,
  );
  store.recordRecommendation(
    sessionId,
    pathway,
    result.areas.flatMap((a) => [
      { areaId: a.area.id, clinicianId: a.primary.clinician.id, role: "primary" as const },
      ...a.alternates.map((m) => ({
        areaId: a.area.id,
        clinicianId: m.clinician.id,
        role: "alternate" as const,
      })),
    ]),
  );
  store.record({ sessionId, pathway, type: "recommendation_shown", payload: { scores } });
  return { sessionId, pathway, ...result };
}

app.post<{ Body: RecommendBody }>("/api/recommend", async (req, reply) => {
  const { sessionId, pathway, scores } = req.body ?? {};
  if (!sessionId || !PATHWAYS.includes(pathway) || !Array.isArray(scores)) {
    return reply.code(400).send({ error: "sessionId, pathway and scores are required" });
  }
  if (scores.length === 0) {
    return reply.code(400).send({ error: "no area scores supplied" });
  }
  return buildAndStore(sessionId, pathway, scores);
});

/* ----------------------------------------------------------------- chat --- */

// The plugin limit has to accommodate the largest legitimate upload, which is
// the 25MB contributors directory an organiser sends. Founder uploads are held
// to the tighter MAX_UPLOAD_BYTES inside extract().
await app.register(fastifyMultipart, {
  limits: { fileSize: MAX_ADMIN_UPLOAD_BYTES, files: 1 },
});

/**
 * Read an uploaded document and hand back its text.
 *
 * Nothing is written to disk - the bytes are parsed in memory and dropped,
 * which is exactly what the disclaimer above the upload control promises.
 */
app.post<{ Querystring: { render?: string } }>("/api/upload", async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "no file received" });

  const sessionId = (file.fields.sessionId as any)?.value as string | undefined;
  try {
    const bytes = await file.toBuffer();

    // Second pass, only after the founder has agreed to wait for it. The file
    // is never stored, so the browser re-sends the bytes it still holds -
    // which keeps the promise in the upload disclaimer literally true.
    if (req.query.render === "1") {
      if (!ollamaConfigured()) {
        return reply.code(503).send({ error: "the assistant is not configured on this server" });
      }
      const images = await renderPages(bytes);
      if (images.length === 0) return reply.code(400).send({ error: "nothing to read in that file" });
      const text = await describeSlides(images);
      if (sessionId) {
        store.record({
          sessionId,
          pathway: "chat",
          type: "document_uploaded",
          payload: { kind: "pdf", rendered: images.length, characters: text.length },
        });
      }
      return { kind: "pdf", pages: images.length, usable: text.length > 0, characters: text.length, text };
    }

    const result = await extract(file.filename, bytes);
    if (sessionId) {
      store.record({
        sessionId,
        pathway: "chat",
        type: "document_uploaded",
        // The document itself is never logged; only what it was and whether
        // we could read it.
        payload: {
          kind: result.kind,
          pages: result.pages,
          characters: result.text.length,
          usable: result.usable,
        },
      });
    }
    return {
      kind: result.kind,
      pages: result.pages,
      usable: result.usable,
      characters: result.text.length,
      text: result.text,
      // A PDF with pages but no text is a deck exported as slide images. We can
      // read those, but it costs a vision call per page, so the founder is
      // asked rather than made to wait without explanation.
      renderable:
        result.kind === "pdf" && !result.usable && (result.pages ?? 0) > 0 && ollamaConfigured(),
      renderablePages: Math.min(result.pages ?? 0, MAX_RENDERED_PAGES),
    };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

interface ChatBody {
  sessionId: string;
  messages: Message[];
  documentText?: string;
}

/** A conversation turn, streamed as plain text. Thinking off - the founder is
 *  waiting on this one. */
app.post<{ Body: ChatBody }>("/api/chat", async (req, reply) => {
  const { sessionId, messages, documentText } = req.body ?? {};
  if (!sessionId || !Array.isArray(messages)) {
    return reply.code(400).send({ error: "sessionId and messages are required" });
  }
  if (!ollamaConfigured()) {
    return reply.code(503).send({ error: "OLLAMA_BASE_URL is not set on the server" });
  }

  store.record({
    sessionId,
    pathway: "chat",
    type: "chat_message",
    payload: { turn: messages.length, text: messages.at(-1)?.content?.slice(0, 2000) },
  });

  const system = documentText
    ? `${INTERVIEW_PROMPT}\n\nThe founder uploaded a document. Here is its text:\n"""\n${documentText.slice(0, 60_000)}\n"""`
    : INTERVIEW_PROMPT;

  reply.raw.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-cache",
    // Without this a proxy can hold the whole reply and undo the streaming.
    "x-accel-buffering": "no",
  });

  try {
    for await (const chunk of ollamaStream(
      [{ role: "system", content: system }, ...messages],
      { think: false, temperature: 0.3 },
    )) {
      reply.raw.write(chunk);
    }
  } catch (e) {
    app.log.error(e);
    reply.raw.write("\n\n[The assistant is unavailable right now. You can still browse the bench.]");
  }
  reply.raw.end();
});

interface AnalyseBody {
  sessionId: string;
  messages: Message[];
  documentText?: string;
}

/**
 * The slow one. Turns the conversation into the same area scores the other
 * pathways produce, then runs the same matcher.
 */
app.post<{ Body: AnalyseBody }>("/api/analyse", async (req, reply) => {
  const { sessionId, messages, documentText } = req.body ?? {};
  if (!sessionId || !Array.isArray(messages)) {
    return reply.code(400).send({ error: "sessionId and messages are required" });
  }
  if (!ollamaConfigured()) {
    return reply.code(503).send({ error: "OLLAMA_BASE_URL is not set on the server" });
  }

  try {
    const { scores, sector } = await analyse(bench.areas, messages, documentText);
    store.record({ sessionId, pathway: "chat", type: "areas_scored", payload: { sector, scores } });
    return buildAndStore(sessionId, "chat", scores);
  } catch (e) {
    app.log.error(e);
    return reply.code(502).send({ error: (e as Error).message });
  }
});

interface QuestionsBody {
  sessionId: string;
  pathway: Pathway;
  areas: { areaId: string; clinicianId: string; evidence?: string }[];
}

/**
 * Three questions to take into each clinic.
 *
 * Requested separately from /api/recommend so the shortlist is never held up
 * waiting for it. A founder who never sees these still has everything they
 * need; one who does arrives at the clinic prepared.
 */
app.post<{ Body: QuestionsBody }>("/api/questions", async (req, reply) => {
  const { sessionId, pathway, areas } = req.body ?? {};
  if (!sessionId || !Array.isArray(areas)) {
    return reply.code(400).send({ error: "sessionId and areas are required" });
  }
  if (!ollamaConfigured()) return reply.code(503).send({ error: "not configured" });

  const requests: QuestionRequest[] = [];
  for (const a of areas) {
    const area = bench.areas.find((x) => x.id === a.areaId);
    const clinician = bench.clinicians.find((c) => c.id === a.clinicianId);
    if (!area || !clinician) continue;
    requests.push({
      areaId: area.id,
      areaLabel: area.label,
      areaPrompt: area.prompt,
      expertName: clinician.name,
      expertise: clinician.tags.slice(0, 4),
      evidence: a.evidence,
    });
  }

  try {
    const questions = await suggestQuestions(requests);
    store.record({ sessionId, pathway, type: "questions_suggested", payload: { areas: Object.keys(questions) } });
    return questions;
  } catch (e) {
    app.log.error(e);
    return reply.code(502).send({ error: (e as Error).message });
  }
});

interface FeedbackBody {
  sessionId: string;
  pathway: Pathway;
  helpful: boolean;
  comment?: string;
}

/**
 * Was the recommendation any good?
 *
 * Never blocking and never required - it sits after the save button so it is
 * not standing between a founder and the paper booking sheet. One thumb per
 * session is enough; the comment behind a thumbs-down is the part worth
 * reading.
 */
app.post<{ Body: FeedbackBody }>("/api/feedback", async (req, reply) => {
  const { sessionId, pathway, helpful, comment } = req.body ?? {};
  if (!sessionId || typeof helpful !== "boolean") {
    return reply.code(400).send({ error: "sessionId and helpful are required" });
  }
  if (pathway && !PATHWAYS.includes(pathway)) {
    return reply.code(400).send({ error: `unknown pathway: ${pathway}` });
  }
  store.record({
    sessionId,
    pathway: pathway ?? null,
    type: "feedback_given",
    // Capped rather than rejected: a founder who writes an essay should not
    // lose it to a validation error.
    payload: { helpful, comment: comment?.trim().slice(0, 2000) || undefined },
  });
  return { ok: true };
});

/* ---------------------------------------------------------------- admin --- */

/** Guards the organiser views. Not a login - one shared password handed to the
 *  Ignition team, which is proportionate for a week-long internal tool. */
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/admin")) return;
  if (!ADMIN_PASSWORD) return reply.code(503).send({ error: "ADMIN_PASSWORD is not set" });
  if (req.headers.authorization !== `Bearer ${ADMIN_PASSWORD}`) {
    return reply.code(401).send({ error: "unauthorised" });
  }
});

app.get("/api/admin/summary", async () => {
  const byId = new Map(bench.clinicians.map((c) => [c.id, c]));
  const areaLabel = new Map(bench.areas.map((a) => [a.id, a.label]));
  return {
    founders: store.sessionCount(),
    capacity: CAPACITY,
    ready: bench.clinicians.some((c) => c.active),
    unreachable: unreachableAreas(bench).map((a) => a.label),
    coverage: coverage(bench).map((c) => ({
      areaId: c.area.id,
      area: c.area.label,
      experts: c.experts,
      specialists: c.specialists,
    })),
    demand: (store.areaDemand() as any[]).map((d) => ({
      ...d,
      area: areaLabel.get(d.area_id) ?? d.area_id,
    })),
    funnel: store.funnel(),
    feedback: store.feedback(),
    pathways: store.pathwayCounts(),
    // Names, not ids: this is read by the Ignition team, who know the people
    // and not the slugs.
    load: [...store.primaryCounts().entries()]
      .map(([clinicianId, primaries]) => ({
        clinicianId,
        name: byId.get(clinicianId)?.name ?? clinicianId,
        company: byId.get(clinicianId)?.company ?? "",
        primaries,
      }))
      .sort((a, b) => b.primaries - a.primaries),
  };
});

/** Raw event log as CSV, so the team can take it away and analyse it however
 *  they end up wanting to - which they have not decided yet. */
app.get("/api/admin/export.csv", async (_req, reply) => {
  const rows = store.allEvents(100_000) as any[];
  const esc = (v: unknown) =>
    v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`;
  const csv = [
    "id,timestamp,session_id,pathway,type,payload",
    ...rows.map((r) =>
      [r.id, r.ts, r.session_id, r.pathway, r.type, r.payload].map(esc).join(","),
    ),
  ].join("\n");
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", 'attachment; filename="expert-finder-events.csv"')
    .send(csv);
});

app.get("/api/admin/events", async () => store.allEvents());

/* ------------------------------------------------- admin: bench updates --- */

const knownTags = new Set<string>([
  ...bench.areas.flatMap((a) => a.tags),
  ...(areasFile.sector_tags ?? []),
]);

/**
 * Apply a revised contributors directory: email, biography, headshot.
 *
 * Kept separate from the spreadsheet because the two documents carry different
 * things and Ignition maintain them separately. Names disagree between them, so
 * matching is lenient - see directory.ts.
 */
function applyDirectory(bytes: Uint8Array, entries: Awaited<ReturnType<typeof parseDirectory>>) {
  const matches = matchByName(entries, bench.clinicians);
  mkdirSync(HEADSHOTS_PATH, { recursive: true });

  let photos = 0;
  for (const [clinician, entry] of matches) {
    clinician.email = entry.email || clinician.email;
    clinician.bio = entry.bio || clinician.bio;
    if (entry.photo) {
      const file = `${clinician.id}.jpg`;
      writeFileSync(join(HEADSHOTS_PATH, file), entry.photo);
      clinician.headshot = `headshots/${file}`;
      photos++;
    }
  }
  writeFileSync(BENCH_PATH, JSON.stringify(bench.clinicians, null, 2) + "\n");
  bench = loadBench();
  return {
    matched: matches.size,
    photos,
    unmatchedBench: bench.clinicians.filter((c) => ![...matches.keys()].some((k) => k.id === c.id)).map((c) => c.name),
    unmatchedDirectory: entries.filter((e) => ![...matches.values()].includes(e)).map((e) => e.name),
  };
}

/** Dry run for either document. Nothing is written - this exists so an
 *  organiser can see that a sheet would remove eleven people before it does. */
app.post("/api/admin/bench/preview", async (req, reply) => {
  try {
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: "no file received" });
    const bytes = new Uint8Array(await file.toBuffer());

    if (file.filename.toLowerCase().endsWith(".docx")) {
      const entries = await parseDirectory(bytes);
      const matches = matchByName(entries, bench.clinicians);
      return {
        document: "directory" as const,
        total: entries.length,
        matched: matches.size,
        photos: [...matches.values()].filter((e) => e.photo).length,
        unmatchedBench: bench.clinicians
          .filter((c) => ![...matches.keys()].some((k) => k.id === c.id))
          .map((c) => c.name),
        unmatchedDirectory: entries
          .filter((e) => ![...matches.values()].includes(e))
          .map((e) => e.name),
      };
    }

    const rows = parseRoster(bytes);
    if (rows.length === 0) throw new Error("that sheet has no clinician rows");
    const { merged, ...diff } = diffRoster(
      rows,
      bench.clinicians,
      bench.areas,
      areasFile.aliases ?? {},
      knownTags,
    );
    return { document: "roster" as const, ...diff, total: merged.length };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.post("/api/admin/bench/apply", async (req, reply) => {
  try {
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: "no file received" });
    const bytes = new Uint8Array(await file.toBuffer());

    if (file.filename.toLowerCase().endsWith(".docx")) {
      const result = applyDirectory(bytes, await parseDirectory(bytes));
      app.log.warn(result, "contributors directory applied by an organiser");
      return { ok: true, document: "directory" as const, ...result };
    }

    const rows = parseRoster(bytes);
    if (rows.length === 0) throw new Error("that sheet has no clinician rows");
    const diff = diffRoster(
      rows,
      bench.clinicians,
      bench.areas,
      areasFile.aliases ?? {},
      knownTags,
    );
    writeFileSync(BENCH_PATH, JSON.stringify(diff.merged, null, 2) + "\n");
    bench = loadBench();
    app.log.warn(
      { added: diff.added.length, removed: diff.removed.length },
      "bench replaced by an organiser upload",
    );
    return {
      ok: true,
      document: "roster" as const,
      total: diff.merged.length,
      added: diff.added,
      removed: diff.removed,
    };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

function saveBench() {
  writeFileSync(BENCH_PATH, JSON.stringify(bench.clinicians, null, 2) + "\n");
  bench = loadBench();
}

/**
 * Every tag currently in use, with how many clinicians carry it and whether it
 * reaches a need area.
 *
 * This drives autocomplete in the editor, which is the point of the editor:
 * matching is exact-string, and the 2026 sheet arrived with "Intellifgence",
 * "Inovation" and "Trade Marks" in it. Each silently cost that clinician every
 * match they should have won. Offering the existing spelling stops the next one
 * being created.
 */
app.get("/api/admin/tags", async () => {
  const counts = new Map<string, number>();
  for (const c of bench.clinicians) {
    for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  for (const t of knownTags) if (!counts.has(t)) counts.set(t, 0);
  return [...counts]
    .map(([tag, used]) => ({ tag, used, reachesArea: knownTags.has(tag) }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
});

/** Add someone who is in neither document yet. */
app.post<{ Body: Partial<Clinician> }>("/api/admin/clinician", async (req, reply) => {
  const name = (req.body?.name ?? "").trim();
  if (!name) return reply.code(400).send({ error: "a name is required" });

  const id = slug(name);
  if (bench.clinicians.some((c) => c.id === id)) {
    return reply.code(409).send({ error: `${name} is already on the bench` });
  }

  const created = {
    id,
    active: true,
    name,
    company: (req.body.company ?? "").trim(),
    title: (req.body.title ?? "").trim(),
    tags: (req.body.tags ?? []).map((t) => t.trim()).filter(Boolean),
    linkedin: (req.body.linkedin ?? "").trim(),
    email: (req.body.email ?? "")?.trim() || null,
    bio: (req.body.bio ?? "")?.trim() || null,
    headshot: null,
  };
  bench.clinicians.push(created);
  saveBench();
  app.log.warn({ id, name }, "clinician added by an organiser");
  return created;
});

/**
 * Edit a clinician, including standing them down.
 *
 * The thing that actually happens on the day is "Roy has just cancelled", and
 * it needs to be one click rather than a spreadsheet round-trip. The id never
 * changes, even when the name is corrected - recommendations already logged
 * point at it.
 */
app.post<{ Params: { id: string }; Body: Partial<Clinician> }>(
  "/api/admin/clinician/:id",
  async (req, reply) => {
    const target = bench.clinicians.find((c) => c.id === req.params.id);
    if (!target) return reply.code(404).send({ error: "no such clinician" });

    const b = req.body ?? {};
    if (typeof b.active === "boolean") target.active = b.active;
    if (typeof b.name === "string" && b.name.trim()) target.name = b.name.trim();
    if (typeof b.company === "string") target.company = b.company.trim();
    if (typeof b.title === "string") target.title = b.title.trim();
    if (typeof b.linkedin === "string") target.linkedin = b.linkedin.trim();
    if (typeof b.email === "string") target.email = b.email.trim() || null;
    if (typeof b.bio === "string") target.bio = b.bio.trim() || null;
    if (Array.isArray(b.tags)) target.tags = b.tags.map((t) => String(t).trim()).filter(Boolean);

    saveBench();
    app.log.warn({ id: target.id }, "clinician edited");
    return target;
  },
);

/**
 * Remove someone entirely - but only if no founder has ever been sent to them.
 *
 * Deleting a clinician with history orphans every recommendation logged against
 * them, and the organiser dashboard would show a slug where a name should be.
 * Once they have been recommended, standing down is the honest operation: it
 * has the same effect going forward and keeps the record intact.
 */
app.delete<{ Params: { id: string } }>("/api/admin/clinician/:id", async (req, reply) => {
  const index = bench.clinicians.findIndex((c) => c.id === req.params.id);
  if (index === -1) return reply.code(404).send({ error: "no such clinician" });

  const target = bench.clinicians[index];
  const seen = store.timesRecommended(target.id);
  if (seen > 0) {
    return reply.code(409).send({
      error:
        `${target.name} has already been recommended to founders ${seen} time${seen === 1 ? "" : "s"}. ` +
        `Deleting would orphan that history - stand them down instead, which stops any new recommendations.`,
      timesRecommended: seen,
    });
  }

  bench.clinicians.splice(index, 1);
  saveBench();
  app.log.warn({ id: target.id, name: target.name }, "clinician deleted by an organiser");
  return { ok: true, name: target.name };
});

/** Replace one person's photograph without re-uploading the whole directory. */
app.post<{ Params: { id: string } }>("/api/admin/clinician/:id/photo", async (req, reply) => {
  const target = bench.clinicians.find((c) => c.id === req.params.id);
  if (!target) return reply.code(404).send({ error: "no such clinician" });

  const file = await (req as any).file();
  if (!file) return reply.code(400).send({ error: "no file received" });

  const photo = await toAvatar(new Uint8Array(await file.toBuffer()));
  if (!photo) return reply.code(400).send({ error: "that file is not a readable image" });

  mkdirSync(HEADSHOTS_PATH, { recursive: true });
  writeFileSync(join(HEADSHOTS_PATH, `${target.id}.jpg`), photo);
  target.headshot = `headshots/${target.id}.jpg`;
  saveBench();
  return { id: target.id, headshot: target.headshot };
});

app.get("/api/admin/bench", async () => bench.clinicians);

/** What a reset would destroy. Read first, so the confirmation is specific. */
app.get("/api/admin/reset", async () => ({
  ...store.countsForReset(),
  clinicians: bench.clinicians.length,
}));

/**
 * Start again.
 *
 * Two scopes, because they are wanted at different moments. "founders" clears
 * the rehearsal traffic before the programme starts and keeps the bench, which
 * is the common case. "everything" also empties the bench, returning the
 * deployment to the state a fresh install is in.
 *
 * Guarded by typing the scope word rather than an "are you sure" dialog: this
 * deletes data with no undo, and a confirmation nobody has to read is not a
 * confirmation.
 */
app.post<{ Body: { scope?: "founders" | "everything"; confirm?: string } }>(
  "/api/admin/reset",
  async (req, reply) => {
    const scope = req.body?.scope ?? "founders";
    if (scope !== "founders" && scope !== "everything") {
      return reply.code(400).send({ error: "scope must be 'founders' or 'everything'" });
    }
    if (req.body?.confirm !== scope) {
      return reply.code(400).send({ error: `type "${scope}" to confirm` });
    }

    const removed = store.countsForReset();
    store.clearFounderData();

    let clinicians = 0;
    if (scope === "everything") {
      clinicians = bench.clinicians.length;
      writeFileSync(BENCH_PATH, "[]\n");
      bench = loadBench();
    }

    app.log.warn({ scope, ...removed, clinicians }, "data reset by an organiser");
    return { ok: true, scope, removed: { ...removed, clinicians } };
  },
);

/* ------------------------------------------------------ admin: exports --- */

/** The bench in the format Ignition sent it, so anything edited here can go
 *  back into whatever else they use it for - and be re-uploaded unchanged. */
app.get("/api/admin/export/roster.xlsx", async (_req, reply) => {
  const book = writeSheet(ROSTER_HEADER, rosterRows(bench.clinicians), "Clinician Expertise");
  return reply
    .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .header("content-disposition", 'attachment; filename="Clinician Expertise.xlsx"')
    .send(Buffer.from(book));
});

/**
 * Contact details and biographies as CSV.
 *
 * Not a regenerated .docx: that document is a laid-out handbook with
 * photography in it, and a machine-made replacement would be worse than what
 * they already have. This gives them the content to paste into it.
 */
app.get("/api/admin/export/contacts.csv", async (_req, reply) => {
  const csv = toCsv(
    ["Name", "Company", "Title", "Email", "LinkedIn", "Available", "Biography"],
    bench.clinicians.map((c) => [
      c.name,
      c.company,
      c.title,
      c.email ?? "",
      c.linkedin,
      c.active ? "yes" : "stood down",
      c.bio ?? "",
    ]),
  );
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", 'attachment; filename="clinician-contacts.csv"')
    .send(csv);
});

/* --------------------------------------------------------------- static --- */

// Headshots are served from the data directory rather than copied into the web
// build, so a bench update does not require a rebuild.
// Two roots: photographs an organiser uploaded, then the seeded originals.
// @fastify/static tries them in order, so an upload shadows the seed without
// having to modify the read-only mount.
mkdirSync(HEADSHOTS_PATH, { recursive: true });
// Deduplicated: in a container these are distinct mounts, but locally SEED_DIR
// defaults to the data directory and both resolve to the same place -
// @fastify/static rejects a root array with duplicates.
const headshotRoots = [...new Set([HEADSHOTS_PATH, join(SEED_DIR, "headshots")])].filter((p) =>
  existsSync(p),
);
await app.register(fastifyStatic, {
  root: headshotRoots,
  prefix: "/headshots/",
});

// In development Vite serves the frontend on its own port and proxies /api
// here, so the build directory legitimately does not exist yet.
const webRoot = join(ROOT, "dist", "web");
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    decorateReply: false,
  });
  // Client-side routing: unknown non-API paths return the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html", webRoot);
  });
} else {
  app.log.warn("dist/web missing - API only. Run `npm run build:web` to serve the UI.");
}

/* ----------------------------------------------------------------- boot --- */

if (bench.clinicians.length === 0) {
  app.log.warn(
    "no clinicians yet - upload the expertise spreadsheet and contributors " +
      "directory at /admin to finish setting this up",
  );
} else {
  const missing = unreachableAreas(bench);
  if (missing.length) {
    app.log.warn(
      `no active clinician covers: ${missing.map((a) => a.label).join(", ")}. ` +
        "Founders weakest in one of those get nothing back for it.",
    );
  }
  const thin = coverage(bench).filter((c) => c.specialists <= 1);
  if (thin.length) {
    app.log.warn(
      `thin bench coverage: ${thin
        .map((c) => `${c.area.label} (${c.specialists} specialist of ${c.experts})`)
        .join("; ")}`,
    );
  }
}

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}
