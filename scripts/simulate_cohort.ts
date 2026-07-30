/**
 * Capacity planning: run a synthetic cohort through the matcher and see how
 * demand lands on the bench. Answers the question the Ignition team actually
 * care about - "if most founders need pitch help, do three clinicians cope?"
 *
 * Run: node --experimental-strip-types scripts/simulate_cohort.ts
 */

import { loadBench, coverage } from "../server/bench.ts";
import { recommend } from "../server/match.ts";
import type { AreaScore } from "../shared/types.ts";

const bench = loadBench();
console.log("coverage (thinnest first):");
console.log("  area                        any  specialists");
for (const c of coverage(bench))
  console.log(`  ${c.area.label.padEnd(26)} ${String(c.experts).padStart(3)}  ${String(c.specialists).padStart(11)}`);

// Simulate a cohort. Every founder is weak in pitch - the realistic worst case,
// and the one that stresses the three-expert area hardest.
const counts = new Map<string, number>();
const COHORT = 60;
for (let i = 0; i < COHORT; i++) {
  const scores: AreaScore[] = bench.areas.map((a) => ({
    area: a.id,
    confidence: a.id === "pitch" ? 0 : a.id === "funding" ? 1 : 2 + ((i + a.id.length) % 4),
  }));
  const r = recommend(scores, bench.areas, bench.clinicians, counts, `founder-${i}`);
  for (const a of r.areas) {
    for (const m of [a.primary, ...a.alternates]) {
      counts.set(m.clinician.id, (counts.get(m.clinician.id) ?? 0) + 1);
    }
  }
}
const load = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n${COHORT} founders, all weakest in pitch & story`);
console.log(`experts used: ${load.length}/${bench.clinicians.length}`);
console.log(`busiest: ${load.slice(0, 3).map(([id, n]) => `${id} ${n}`).join(", ")}`);
console.log(`quietest: ${load.slice(-3).map(([id, n]) => `${id} ${n}`).join(", ")}`);

// Without balancing, everyone would land on the same top-scoring name.
const pitchOnly = new Map<string, number>();
for (let i = 0; i < COHORT; i++) {
  const scores: AreaScore[] = [{ area: "pitch", confidence: 0 }];
  const r = recommend(scores, bench.areas, bench.clinicians, pitchOnly, `f-${i}`);
  const id = r.areas[0].primary.clinician.id;
  pitchOnly.set(id, (pitchOnly.get(id) ?? 0) + 1);
}
console.log(`\npitch primaries across ${COHORT} founders:`);
for (const [id, n] of [...pitchOnly.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id.padEnd(22)} ${n}`);
}
