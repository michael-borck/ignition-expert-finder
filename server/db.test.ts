import assert from "node:assert/strict";
import test from "node:test";

import { Store } from "./db.ts";

const store = () => new Store(":memory:");

test("events round-trip with their payload", () => {
  const s = store();
  s.record({ sessionId: "s1", pathway: "chat", type: "chat_message", payload: { turn: 1 } });
  const rows = s.allEvents() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, "s1");
  assert.deepEqual(JSON.parse(rows[0].payload), { turn: 1 });
  s.close();
});

test("an event with no payload is allowed", () => {
  const s = store();
  s.record({ sessionId: "s1", pathway: null, type: "session_started" });
  assert.equal((s.allEvents() as any[])[0].payload, null);
  s.close();
});

test("only primaries count towards a clinician's load", () => {
  // Being listed as an alternate costs nothing - the founder was pointed at
  // someone else first - so it must not consume capacity.
  const s = store();
  s.recordRecommendation("s1", "score", [
    { areaId: "ip", clinicianId: "a", role: "primary" },
    { areaId: "ip", clinicianId: "b", role: "alternate" },
    { areaId: "ip", clinicianId: "c", role: "alternate" },
  ]);
  s.recordRecommendation("s2", "guided", [
    { areaId: "ip", clinicianId: "a", role: "primary" },
  ]);
  const counts = s.primaryCounts();
  assert.equal(counts.get("a"), 2);
  assert.equal(counts.get("b"), undefined);
  s.close();
});

test("pathway popularity counts sessions, not events", () => {
  // A chatty founder sending twenty messages is still one person choosing chat.
  const s = store();
  for (let i = 0; i < 20; i++) {
    s.record({ sessionId: "chatty", pathway: "chat", type: "chat_message" });
  }
  s.record({ sessionId: "brief", pathway: "directory", type: "directory_searched" });
  s.record({ sessionId: "other", pathway: "directory", type: "directory_searched" });
  // node:sqlite hands back null-prototype objects, so spread them before
  // comparing or deepStrictEqual fails on the prototype rather than the data.
  const counts = (s.pathwayCounts() as any[]).map((r) => ({ ...r }));
  assert.deepEqual(counts, [
    { pathway: "directory", sessions: 2 },
    { pathway: "chat", sessions: 1 },
  ]);
  s.close();
});

test("a bad role is rejected rather than silently stored", () => {
  const s = store();
  assert.throws(() =>
    s.recordRecommendation("s1", "score", [
      { areaId: "ip", clinicianId: "a", role: "featured" as any },
    ]),
  );
  s.close();
});
