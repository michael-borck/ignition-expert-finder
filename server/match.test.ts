import assert from "node:assert/strict";
import test from "node:test";

import type { Area, AreaScore, Clinician } from "../shared/types.ts";
import {
  candidatesFor,
  pickPrimary,
  rankAreas,
  recommend,
  rng,
} from "./match.ts";

const area = (id: string, tags: string[]): Area => ({
  id: id as Area["id"],
  label: id,
  prompt: "",
  strength: "",
  tags,
});

const person = (id: string, tags: string[], active = true): Clinician => ({
  id,
  active,
  name: id,
  company: "",
  title: "",
  tags,
  linkedin: "",
  email: null,
  bio: null,
  headshot: null,
});

const AREAS = [
  area("ip", ["Patents", "Trademarks"]),
  area("funding", ["Grant Funding"]),
  area("pitch", ["Pitching"]),
  area("product", ["Tech"]),
];

const score = (a: string, confidence: number): AreaScore => ({
  area: a as AreaScore["area"],
  confidence,
});

test("rankAreas returns the three weakest areas", () => {
  const { weakest } = rankAreas(
    [score("ip", 1), score("funding", 0), score("pitch", 3), score("product", 5)],
    AREAS,
  );
  assert.deepEqual(
    weakest.map((w) => w.area),
    ["funding", "ip", "pitch"],
  );
});

test("rankAreas reports what the founder is already strong in", () => {
  const { strengths } = rankAreas(
    [score("ip", 1), score("funding", 0), score("pitch", 4), score("product", 5)],
    AREAS,
  );
  assert.deepEqual(
    strengths.map((s) => s.id),
    ["product", "pitch"],
  );
});

test("candidatesFor skips inactive clinicians", () => {
  const bench = [
    person("active-one", ["Patents"]),
    person("stood-down", ["Patents", "Trademarks"], false),
  ];
  const found = candidatesFor(AREAS[0], bench);
  assert.deepEqual(
    found.map((f) => f.clinician.id),
    ["active-one"],
  );
});

test("candidatesFor ranks better tag coverage first", () => {
  const bench = [person("one-tag", ["Patents"]), person("two-tags", ["Patents", "Trademarks"])];
  const found = candidatesFor(AREAS[0], bench);
  assert.equal(found[0].clinician.id, "two-tags");
  assert.deepEqual(found[0].matchedTags, ["Patents", "Trademarks"]);
});

test("pickPrimary prefers the least-recommended of equally good matches", () => {
  const tied = candidatesFor(AREAS[0], [
    person("busy", ["Patents"]),
    person("quiet", ["Patents"]),
  ]);
  const counts = new Map([
    ["busy", 9],
    ["quiet", 1],
  ]);
  assert.equal(pickPrimary(tied, counts, rng("seed")).clinician.id, "quiet");
});

test("fit beats load while the better match still has slots", () => {
  const candidates = candidatesFor(AREAS[0], [
    person("best-fit", ["Patents", "Trademarks"]),
    person("idle-weak-fit", ["Patents"]),
  ]);
  const counts = new Map([
    ["best-fit", 5],
    ["idle-weak-fit", 0],
  ]);
  // Busier, but not yet booked out, so the better match still wins.
  assert.equal(
    pickPrimary(candidates, counts, rng("seed"), 8).clinician.id,
    "best-fit",
  );
});

test("fit yields once the better match is booked out", () => {
  // The alternative to routing elsewhere is recommending a clinic the founder
  // cannot get into. A slightly worse match they can actually see is better.
  const candidates = candidatesFor(AREAS[0], [
    person("best-fit", ["Patents", "Trademarks"]),
    person("idle-weak-fit", ["Patents"]),
  ]);
  const counts = new Map([
    ["best-fit", 8],
    ["idle-weak-fit", 0],
  ]);
  assert.equal(
    pickPrimary(candidates, counts, rng("seed"), 8).clinician.id,
    "idle-weak-fit",
  );
});

test("when everyone qualified is booked out, spread rather than give up", () => {
  const candidates = candidatesFor(AREAS[0], [
    person("swamped", ["Patents", "Trademarks"]),
    person("also-swamped", ["Patents"]),
  ]);
  const counts = new Map([
    ["swamped", 30],
    ["also-swamped", 12],
  ]);
  // Both are past capacity, so fall back to whoever has taken fewest so far.
  assert.equal(
    pickPrimary(candidates, counts, rng("seed"), 8).clinician.id,
    "also-swamped",
  );
});

test("a clinician added mid-programme is not swamped by having no history", () => {
  // Seeding newcomers at zero would make them the least-loaded person on the
  // bench and send them every founder until they caught up.
  const candidates = candidatesFor(AREAS[0], [
    person("established", ["Patents"]),
    person("just-added", ["Patents"]),
  ]);
  const counts = new Map([["established", 4]]); // just-added is absent entirely
  const picks = new Set<string>();
  for (let i = 0; i < 50; i++) {
    picks.add(pickPrimary(candidates, counts, rng(`session-${i}`)).clinician.id);
  }
  // Median of [4] is 4, so the newcomer ties rather than undercutting.
  assert.ok(picks.has("established"), "established clinician should still appear");
  assert.ok(picks.has("just-added"), "newcomer should still appear");
});

const allSlots = (result: { areas: { primary: any; alternates: any[] }[] }) =>
  result.areas.flatMap((a) => [
    a.primary.clinician.id,
    ...a.alternates.map((x: any) => x.clinician.id),
  ]);

test("no clinician appears twice when the bench can cover every slot", () => {
  const bench = Array.from({ length: 9 }, (_, i) =>
    person(`p${i}`, ["Patents", "Trademarks", "Grant Funding", "Pitching"]),
  );
  const result = recommend(
    [score("ip", 0), score("funding", 1), score("pitch", 2), score("product", 5)],
    AREAS,
    bench,
    new Map(),
    "session-1",
  );
  const ids = allSlots(result);
  assert.equal(ids.length, 9, "expected three areas of three");
  assert.equal(new Set(ids).size, ids.length, `duplicate expert in ${ids.join(", ")}`);
});

test("a scarce bench drops alternates rather than repeating a face", () => {
  // Four people cannot fill nine slots, so something has to give. An area with
  // no primary is a hole in the recommendation; a missing alternate is barely
  // noticed. Alternates should thin out and stay unique.
  const bench = ["a", "b", "c", "d"].map((id) =>
    person(id, ["Patents", "Grant Funding", "Pitching"]),
  );
  const result = recommend(
    [score("ip", 0), score("funding", 1), score("pitch", 2)],
    AREAS,
    bench,
    new Map(),
    "session-1",
  );
  assert.equal(result.areas.length, 3, "all three areas should be present");
  for (const a of result.areas) {
    assert.ok(a.primary, `${a.area.id} has no primary`);
    const alts = a.alternates.map((x) => x.clinician.id);
    assert.ok(!alts.includes(a.primary.clinician.id), "alternate repeats its own primary");
  }
  const alternateIds = result.areas.flatMap((a) => a.alternates.map((x) => x.clinician.id));
  assert.equal(
    new Set(alternateIds).size,
    alternateIds.length,
    `alternates repeat across areas: ${alternateIds.join(", ")}`,
  );
});

test("an area with nobody qualified is omitted, not rendered empty", () => {
  const bench = [person("ip-only", ["Patents"])];
  const result = recommend([score("ip", 0), score("pitch", 1)], AREAS, bench, new Map(), "s");
  assert.deepEqual(
    result.areas.map((a) => a.area.id),
    ["ip"],
  );
});

test("the same session repeated gives the same experts", () => {
  const bench = [
    person("a", ["Patents"]),
    person("b", ["Patents"]),
    person("c", ["Patents"]),
  ];
  const scores = [score("ip", 0), score("funding", 1), score("pitch", 2)];
  const once = recommend(scores, AREAS, bench, new Map(), "same-session");
  const twice = recommend(scores, AREAS, bench, new Map(), "same-session");
  assert.equal(once.areas[0].primary.clinician.id, twice.areas[0].primary.clinician.id);
});

test("different sessions spread across equally good experts", () => {
  const bench = [
    person("a", ["Patents"]),
    person("b", ["Patents"]),
    person("c", ["Patents"]),
  ];
  const scores = [score("ip", 0)];
  const picked = new Set<string>();
  for (let i = 0; i < 40; i++) {
    picked.add(
      recommend(scores, AREAS, bench, new Map(), `session-${i}`).areas[0].primary.clinician.id,
    );
  }
  assert.ok(picked.size > 1, "identical-fit experts should not all go to one person");
});

test("tied areas are not resolved alphabetically", () => {
  // A founder who mentioned nothing about strategy, ip or pitch scores the
  // same on all three, but only three of eight areas get recommended. Sorting
  // by id meant `ip` beat `strategy` for every tied founder, forever.
  const areas = [
    area("ip", ["Patents"]),
    area("funding", ["Grant Funding"]),
    area("pitch", ["Pitching"]),
    area("strategy", ["Strategy"]),
  ];
  const tied = [score("ip", 1), score("pitch", 1), score("strategy", 1), score("funding", 0)];

  const chosen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const { weakest } = rankAreas(tied, areas, rng(`session-${i}`));
    // funding is genuinely weakest and must always appear.
    assert.ok(weakest.some((w) => w.area === "funding"), "clear weakest area was dropped");
    weakest.filter((w) => w.area !== "funding").forEach((w) => chosen.add(w.area));
  }
  assert.equal(chosen.size, 3, `tied areas did not all get a turn: ${[...chosen]}`);
});

test("a tie resolves the same way for the same founder", () => {
  const areas = [area("ip", ["Patents"]), area("pitch", ["Pitching"]), area("strategy", ["Strategy"])];
  const tied = [score("ip", 1), score("pitch", 1), score("strategy", 1)];
  const a = rankAreas(tied, areas, rng("founder-7")).weakest.map((w) => w.area);
  const b = rankAreas(tied, areas, rng("founder-7")).weakest.map((w) => w.area);
  assert.deepEqual(a, b);
});

test("a clear ranking is never disturbed by the tie-break", () => {
  const areas = [area("ip", ["Patents"]), area("pitch", ["Pitching"]), area("strategy", ["Strategy"])];
  const clear = [score("ip", 0), score("pitch", 2), score("strategy", 4)];
  for (let i = 0; i < 20; i++) {
    const order = rankAreas(clear, areas, rng(`s${i}`)).weakest.map((w) => w.area);
    assert.deepEqual(order, ["ip", "pitch", "strategy"]);
  }
});
