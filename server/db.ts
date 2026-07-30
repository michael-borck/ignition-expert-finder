/**
 * Append-only event log.
 *
 * The Ignition team want to know which pathway founders chose, what they told
 * us and who they were sent to - but not yet what the analysis should look
 * like. So this records everything as flat events and derives nothing at write
 * time; the reporting can be written later against data already collected.
 *
 * node:sqlite is used deliberately over better-sqlite3: it ships with Node, so
 * the Docker image needs no compiler and the VPS deploy stays a single stage.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Pathway } from "../shared/types.ts";

/** Every event kind the app writes. Kept explicit so the analysis has a
 *  closed vocabulary rather than whatever strings accumulated. */
export type EventType =
  | "session_started"
  | "pathway_chosen"
  | "pathway_abandoned"
  | "document_uploaded"
  | "chat_message"
  | "areas_scored"
  | "recommendation_shown"
  | "expert_expanded"
  | "questions_suggested"
  | "directory_searched"
  | "pdf_saved"
  | "feedback_given"
  | "restarted";

export interface EventRow {
  sessionId: string;
  pathway: Pathway | null;
  type: EventType;
  payload?: unknown;
}

export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL DEFAULT (datetime('now')),
        session_id TEXT NOT NULL,
        pathway    TEXT,
        type       TEXT NOT NULL,
        payload    TEXT
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS events_type    ON events(type);

      -- One row per expert slot shown to a founder. Denormalised out of the
      -- event payload because it is read on every recommendation to drive
      -- capacity-aware matching, and grouping a JSON blob per request would
      -- not hold up across a week of traffic.
      CREATE TABLE IF NOT EXISTS recommendations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           TEXT NOT NULL DEFAULT (datetime('now')),
        session_id   TEXT NOT NULL,
        pathway      TEXT NOT NULL,
        area_id      TEXT NOT NULL,
        clinician_id TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('primary','alternate'))
      );
      CREATE INDEX IF NOT EXISTS rec_clinician ON recommendations(clinician_id);
      CREATE INDEX IF NOT EXISTS rec_session   ON recommendations(session_id);
    `);
  }

  record(e: EventRow): void {
    this.#db
      .prepare(
        "INSERT INTO events (session_id, pathway, type, payload) VALUES (?, ?, ?, ?)",
      )
      .run(
        e.sessionId,
        e.pathway ?? null,
        e.type,
        e.payload === undefined ? null : JSON.stringify(e.payload),
      );
  }

  recordRecommendation(
    sessionId: string,
    pathway: Pathway,
    slots: { areaId: string; clinicianId: string; role: "primary" | "alternate" }[],
  ): void {
    const stmt = this.#db.prepare(
      "INSERT INTO recommendations (session_id, pathway, area_id, clinician_id, role) VALUES (?, ?, ?, ?, ?)",
    );
    for (const s of slots) {
      stmt.run(sessionId, pathway, s.areaId, s.clinicianId, s.role);
    }
  }

  /**
   * How many times each clinician has been the primary recommendation. Drives
   * capacity-aware matching.
   *
   * Only primaries count: being listed as an alternate costs a clinician
   * nothing, since the founder was pointed at someone else first.
   */
  primaryCounts(): Map<string, number> {
    const rows = this.#db
      .prepare(
        "SELECT clinician_id, COUNT(*) AS n FROM recommendations WHERE role = 'primary' GROUP BY clinician_id",
      )
      .all() as { clinician_id: string; n: number }[];
    return new Map(rows.map((r) => [r.clinician_id, r.n]));
  }

  /**
   * How often each area was recommended across the cohort.
   *
   * This is the heat-map the scoping brief called the most valuable output of
   * the whole tool: where is this room actually struggling. It is drawn from
   * recommendations rather than raw self-scores so that all four pathways
   * contribute on the same footing.
   */
  areaDemand() {
    return this.#db
      .prepare(
        `SELECT area_id,
                COUNT(DISTINCT session_id) AS founders,
                SUM(CASE WHEN role = 'primary' THEN 1 ELSE 0 END) AS primaries
         FROM recommendations
         GROUP BY area_id
         ORDER BY founders DESC`,
      )
      .all();
  }

  /**
   * How far founders got. A pathway that many start and few finish is a
   * usability problem the team can still act on mid-programme.
   */
  funnel() {
    return this.#db
      .prepare(
        `SELECT pathway,
                COUNT(DISTINCT CASE WHEN type = 'pathway_chosen'        THEN session_id END) AS started,
                COUNT(DISTINCT CASE WHEN type = 'recommendation_shown'  THEN session_id END) AS completed,
                COUNT(DISTINCT CASE WHEN type = 'pdf_saved'             THEN session_id END) AS saved
         FROM events
         WHERE pathway IS NOT NULL
         GROUP BY pathway`,
      )
      .all();
  }

  /** How many times a clinician has been put in front of a founder, in any
   *  role. Decides whether they can be deleted outright or must be stood down:
   *  deleting someone with history orphans it. */
  timesRecommended(clinicianId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM recommendations WHERE clinician_id = ?")
      .get(clinicianId) as { n: number };
    return row.n;
  }

  /**
   * What founders made of their recommendation.
   *
   * The counts give the Ignition team one number to judge the tool by. The
   * comments are the actual payload: with a cohort of sixty, a handful of
   * founders explaining what the tool misread is worth more than any amount
   * of thumb-counting, which is far too sparse at this scale to say anything
   * statistical about eight areas and thirty-five clinicians.
   */
  feedback() {
    const counts = this.#db
      .prepare(
        `SELECT json_extract(payload, '$.helpful') AS helpful, COUNT(*) AS n
         FROM events WHERE type = 'feedback_given' GROUP BY helpful`,
      )
      .all() as { helpful: number; n: number }[];

    const comments = this.#db
      .prepare(
        `SELECT ts, pathway, json_extract(payload, '$.comment') AS comment
         FROM events
         WHERE type = 'feedback_given' AND json_extract(payload, '$.comment') IS NOT NULL
         ORDER BY id DESC LIMIT 200`,
      )
      .all();

    return {
      helpful: counts.find((c) => c.helpful === 1)?.n ?? 0,
      unhelpful: counts.find((c) => c.helpful === 0)?.n ?? 0,
      comments,
    };
  }

  /** Distinct founders who opened the tool at all. */
  sessionCount(): number {
    const row = this.#db
      .prepare("SELECT COUNT(DISTINCT session_id) AS n FROM events")
      .get() as { n: number };
    return row.n;
  }

  /** Everything, newest first - for the organiser export. */
  allEvents(limit = 10_000) {
    return this.#db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit);
  }

  /** Pathway popularity, the first question the Ignition team asked. */
  pathwayCounts() {
    return this.#db
      .prepare(
        `SELECT pathway, COUNT(DISTINCT session_id) AS sessions
         FROM events WHERE pathway IS NOT NULL GROUP BY pathway ORDER BY sessions DESC`,
      )
      .all();
  }

  /** What a reset would remove, so the confirmation can say so precisely. */
  countsForReset() {
    const one = (sql: string) => (this.#db.prepare(sql).get() as { n: number }).n;
    return {
      sessions: one("SELECT COUNT(DISTINCT session_id) AS n FROM events"),
      events: one("SELECT COUNT(*) AS n FROM events"),
      recommendations: one("SELECT COUNT(*) AS n FROM recommendations"),
    };
  }

  /**
   * Delete every founder interaction.
   *
   * The realistic need is not a mistake but a rehearsal: the team will try the
   * deployed app before the programme, and none of that belongs in the numbers
   * they report afterwards. Clearing beats teaching everyone to mentally
   * subtract the first twenty sessions.
   */
  clearFounderData(): void {
    this.#db.exec("DELETE FROM recommendations; DELETE FROM events;");
    // Reclaim the space rather than leaving the file at its high-water mark.
    this.#db.exec("VACUUM");
  }

  close(): void {
    this.#db.close();
  }
}
