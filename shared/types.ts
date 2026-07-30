/** Shared between the API and the browser so both sides agree on the shapes. */

export const AREA_IDS = [
  "validate",
  "strategy",
  "product",
  "market",
  "ip",
  "funding",
  "pitch",
  "founder",
] as const;

export type AreaId = (typeof AREA_IDS)[number];

/** The four front doors. Every logged event carries one so we can answer
 *  "which pathway did founders actually use". */
export const PATHWAYS = ["chat", "guided", "score", "directory"] as const;
export type Pathway = (typeof PATHWAYS)[number];

/** Where the founder says the venture is up to. Guided pathway only. */
export interface Stage {
  id: string;
  label: string;
  description: string;
  /** Areas that typically need work at this stage. Used to order the
   *  recommendation when the founder names fewer than three concerns. */
  likelyGaps: AreaId[];
}

export interface Area {
  id: AreaId;
  label: string;
  /** Shown to the founder when asking about this area. */
  prompt: string;
  /** Affirming phrasing used when they score well here. */
  strength: string;
  tags: string[];
}

export interface Clinician {
  id: string;
  active: boolean;
  name: string;
  company: string;
  title: string;
  tags: string[];
  linkedin: string;
  email: string | null;
  bio: string | null;
  headshot: string | null;
}

/**
 * How well evidenced an area is, 0 (nothing) to 5 (clearly strong). The score
 * pathway collects this directly from the founder; the chat pathway has the
 * model infer it. Deliberately the same scale either way, so one matching
 * engine serves both and they cannot disagree.
 */
export interface AreaScore {
  area: AreaId;
  confidence: number;
  /** Verbatim quote from the founder, when the chat pathway produced it. */
  evidence?: string;
}

export interface ExpertMatch {
  clinician: Clinician;
  /** The founder's tags that this clinician covers - shown as "why them". */
  matchedTags: string[];
}

export interface AreaRecommendation {
  area: Area;
  /** Why this area surfaced, in the founder's own words where available. */
  evidence?: string;
  primary: ExpertMatch;
  /** Shown alongside the primary, not hidden behind it: the founder is walking
   *  to a paper booking sheet and needs to know who else fits before they get
   *  there. */
  alternates: ExpertMatch[];
}

export interface Recommendation {
  sessionId: string;
  pathway: Pathway;
  /** Areas the founder is already strong in, so the result can open with what
   *  is working rather than only what is missing. */
  strengths: Area[];
  areas: AreaRecommendation[];
}
