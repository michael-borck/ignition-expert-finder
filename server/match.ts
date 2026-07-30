/**
 * Turns a founder's area scores into three recommended areas, each with a
 * primary expert and alternates.
 *
 * All four pathways funnel through here. The chat pathway has a model produce
 * the scores and the score pathway collects them from the founder directly,
 * but neither does any matching itself - otherwise two founders in the same
 * position could be told different things depending on which door they used.
 */

import type {
  Area,
  AreaId,
  AreaRecommendation,
  AreaScore,
  Clinician,
  ExpertMatch,
} from "../shared/types.ts";

/** How many areas to recommend, and how many alternates to offer per area. */
export const AREAS_RECOMMENDED = 3;
export const ALTERNATES_PER_AREA = 2;

/** A founder scoring at or above this is treated as already strong here. */
const STRENGTH_THRESHOLD = 4;

/**
 * Deterministic PRNG. Seeded from the session id so that re-running the same
 * pathway gives the same people - a founder who hits "try again" and sees a
 * different expert for the same answers learns the tool is arbitrary. Starting
 * a fresh session, or switching pathway, reshuffles.
 */
export function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clinicians who cover this area at all, best coverage first. */
export function candidatesFor(area: Area, bench: Clinician[]): ExpertMatch[] {
  const wanted = new Set(area.tags);
  return bench
    .filter((c) => c.active)
    .map((c) => ({ clinician: c, matchedTags: c.tags.filter((t) => wanted.has(t)) }))
    .filter((m) => m.matchedTags.length > 0)
    .sort(
      (a, b) =>
        b.matchedTags.length - a.matchedTags.length ||
        a.clinician.name.localeCompare(b.clinician.name),
    );
}

/**
 * How many times one clinician may be the primary recommendation before the
 * matcher routes to the next-best candidate instead.
 *
 * Without a cap, the single best-matching expert in an area takes every
 * founder. On the 2026 bench one clinician covers three of the five Pitch &
 * story tags while the other two cover one each, so a pure best-fit matcher
 * hands that one person the whole cohort. Nobody runs sixty clinics in a week.
 *
 * Set it to roughly the number of clinic slots a clinician actually has.
 */
export const DEFAULT_CAPACITY = 8;

/**
 * Pick the primary: best fit first, but not past the point where the best fit
 * has no clinic slots left.
 *
 * Candidates are grouped into bands by how many of the area's tags they cover.
 * We walk bands best-first and take the least-recommended person within a band,
 * dropping to the next band only once everyone in the current one is at
 * capacity. Fit is preserved right up until the recommendation would be
 * unbookable - which is the point where a slightly worse match the founder can
 * actually see beats a perfect match they cannot.
 */
export function pickPrimary(
  candidates: ExpertMatch[],
  counts: Map<string, number>,
  random: () => number,
  capacity = DEFAULT_CAPACITY,
): ExpertMatch {
  // A clinician added mid-programme has no history. Starting them at zero would
  // make them the least-recommended person on the bench and send them everyone
  // until they caught up, so treat them as average instead.
  const seen = [...counts.values()];
  const median = seen.length
    ? seen.slice().sort((a, b) => a - b)[Math.floor(seen.length / 2)]
    : 0;
  const load = (m: ExpertMatch) => counts.get(m.clinician.id) ?? median;

  const bands = new Map<number, ExpertMatch[]>();
  for (const c of candidates) {
    const n = c.matchedTags.length;
    bands.set(n, [...(bands.get(n) ?? []), c]);
  }

  const pick = (pool: ExpertMatch[]) => {
    const fewest = Math.min(...pool.map(load));
    const leastLoaded = pool.filter((m) => load(m) === fewest);
    return leastLoaded[Math.floor(random() * leastLoaded.length)];
  };

  for (const size of [...bands.keys()].sort((a, b) => b - a)) {
    const available = bands.get(size)!.filter((m) => load(m) < capacity);
    if (available.length) return pick(available);
  }

  // Everyone qualified is booked out. Still return the least-loaded best fit:
  // an oversubscribed suggestion beats none, and this is a staffing problem for
  // the organiser view to surface, not something to hide from the founder.
  return pick(candidates);
}

/**
 * The three areas the founder is weakest in, and the ones they are strong in.
 *
 * Ties are common and they matter. A founder who has said nothing about
 * strategy, IP or pitch scores 1 on all three, and only three of the eight
 * areas get recommended - so something has to choose. Sorting by area id made
 * that choice alphabetically, which meant `ip` beat `strategy` for every
 * founder who tied, forever.
 *
 * `random` is seeded from the session, so a given founder always gets the same
 * answer while the cohort spreads across tied areas instead of piling onto
 * whichever one sorts first.
 */
export function rankAreas(
  scores: AreaScore[],
  areas: Area[],
  random: () => number = Math.random,
): { weakest: AreaScore[]; strengths: Area[] } {
  const byId = new Map(areas.map((a) => [a.id, a]));
  const scored = scores.filter((s) => byId.has(s.area));

  // Assign each area a stable shuffle key up front rather than comparing
  // randomly inside the sort, which would be inconsistent and can throw.
  const jitter = new Map(scored.map((s) => [s.area, random()]));
  const weakest = scored
    .slice()
    .sort((a, b) => a.confidence - b.confidence || jitter.get(a.area)! - jitter.get(b.area)!)
    .slice(0, AREAS_RECOMMENDED);

  const strengths = scored
    .filter((s) => s.confidence >= STRENGTH_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
    .map((s) => byId.get(s.area)!);

  return { weakest, strengths };
}

/**
 * Build the full recommendation.
 *
 * `counts` maps clinician id to how many times they have already been
 * recommended, and drives the load balancing.
 */
export function recommend(
  scores: AreaScore[],
  areas: Area[],
  bench: Clinician[],
  counts: Map<string, number>,
  seed: string,
  capacity = DEFAULT_CAPACITY,
): { strengths: Area[]; areas: AreaRecommendation[] } {
  const byId = new Map(areas.map((a) => [a.id, a]));
  const random = rng(seed);
  const { weakest, strengths } = rankAreas(scores, areas, random);

  // Nobody should appear twice across the nine slots - seeing the same face
  // under two headings reads as a thin bench rather than a strong match.
  const used = new Set<string>();
  const out: AreaRecommendation[] = [];

  for (const score of weakest) {
    const area = byId.get(score.area)!;
    const all = candidatesFor(area, bench);
    if (all.length === 0) continue;

    // Pitch & story has only three clinicians covering it on the 2026 bench, so
    // exclusivity can genuinely exhaust an area. The two slots are not equally
    // important: an area with no primary is a hole in the recommendation, but a
    // missing alternate is barely noticeable. So a primary may repeat when
    // there is no fresh candidate left, while alternates are always fresh -
    // one alternate reads better than two, one of whom the founder has already
    // been sent to under a different heading.
    const fresh = all.filter((m) => !used.has(m.clinician.id));

    const primary = pickPrimary(fresh.length > 0 ? fresh : all, counts, random, capacity);
    used.add(primary.clinician.id);

    const alternates = fresh
      .filter((m) => m.clinician.id !== primary.clinician.id)
      .slice(0, ALTERNATES_PER_AREA);
    alternates.forEach((m) => used.add(m.clinician.id));

    out.push({ area, evidence: score.evidence, primary, alternates });
  }

  return { strengths, areas: out };
}
