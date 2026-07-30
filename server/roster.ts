/**
 * Reads an updated expertise spreadsheet and works out what it would change.
 *
 * Ignition send a revised bench close to the programme, and whoever applies it
 * will be an organiser on the day rather than a developer at a terminal. So
 * this runs in the server rather than in scripts/build_clinicians.py: the
 * Docker image is Node-only and has no Python.
 *
 * It deliberately never applies anything without producing a diff first. A
 * malformed sheet that silently emptied the bench mid-programme would be far
 * worse than a refused upload.
 */

import { unzipSync } from "fflate";

import type { Area, Clinician } from "../shared/types.ts";

const SHEET_NS = /<(?:\w+:)?t[ >]/;

export interface RosterRow {
  name: string;
  company: string;
  title: string;
  tags: string[];
  linkedin: string;
}

/** Excel stores repeated strings once and references them by index. */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.split(/<si[ >]/).slice(1)) {
    // A single cell can be split across several <t> runs by Excel's formatting.
    const parts = [...si.matchAll(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]);
    out.push(decode(parts.join("")));
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/** Expertise is slash-separated, except where whoever filled in the sheet used
 *  commas. Split on both, or compound values arrive as one unmatchable tag. */
export function splitTags(raw: string): string[] {
  return raw
    .split(/[/,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function parseRoster(bytes: Uint8Array): RosterRow[] {
  const files = unzipSync(bytes);
  const sheet = files["xl/worksheets/sheet1.xml"];
  if (!sheet) throw new Error("that file does not look like an .xlsx workbook");

  const strings = files["xl/sharedStrings.xml"]
    ? sharedStrings(new TextDecoder().decode(files["xl/sharedStrings.xml"]))
    : [];
  const xml = new TextDecoder().decode(sheet);

  const rows: string[][] = [];
  for (const row of xml.split(/<row[ >]/).slice(1)) {
    const cells: string[] = [];
    // Excel writes an empty cell as self-closing (`<c r="C12" s="6"/>`), which
    // matters more than it sounds: a pattern that only matches paired tags
    // starts at the empty cell and swallows the *next* cell's value, so one
    // blank title silently steals the expertise column beside it. The
    // alternation below closes on `/>` or on `</c>`, whichever comes first.
    for (const m of row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, col, attrs, inner = ""] = m;
      const idx = col.split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
      const value = /<(?:\w+:)?v[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1] ?? "";
      const text = attrs.includes('t="s"')
        ? (strings[Number(value)] ?? "")
        : attrs.includes('t="inlineStr"') && SHEET_NS.test(inner)
          ? decode(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/.exec(inner)?.[1] ?? "")
          : decode(value);
      cells[idx] = text;
    }
    rows.push(cells);
  }

  // Row 1 is the header: Name, Company, Title, Expertise, LinkedIn.
  return rows
    .slice(1)
    .filter((r) => (r[0] ?? "").trim())
    .map((r) => ({
      name: (r[0] ?? "").trim(),
      company: (r[1] ?? "").trim(),
      title: (r[2] ?? "").trim(),
      tags: splitTags(r[3] ?? ""),
      linkedin: (r[4] ?? "").trim(),
    }));
}

export const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Stable identity across spreadsheet edits.
 *
 * Matching on the name alone is fragile in exactly the way that matters. One
 * document misspells a surname; correcting it later would mint a new id and lose
 * that person's email, biography, photograph, availability and recommendation
 * history in one go. A typo fix should not cost anyone their contact details.
 *
 * The LinkedIn URL is the only stable identifier the spreadsheet carries, and
 * in practice every row has a unique one. Name is the fallback for anyone without.
 */
export function identityKey(row: { name: string; linkedin: string }): string {
  const url = row.linkedin
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .replace(/\?.*$/, "");
  return url ? `li:${url}` : `name:${slug(row.name)}`;
}

export interface RosterDiff {
  added: string[];
  /** Absent from the new sheet. Stood down rather than deleted - see below. */
  removed: string[];
  /** Same person, different spelling. Reported so the organiser can see that a
   *  typo fix was understood as a correction, not as a departure. */
  renamed: { from: string; to: string }[];
  changed: { name: string; before: string[]; after: string[] }[];
  /** Tags in the new sheet that match no need area. These cost a clinician
   *  every match they should have won, silently. */
  unmatchedTags: { tag: string; clinicians: string[] }[];
  /** Incoming rows carrying no tags at all. Nothing can ever recommend them,
   *  which is easy to create by accident and invisible without this. */
  untagged: string[];
  /**
   * Rows with no LinkedIn URL. These fall back to matching on name, so a later
   * spelling correction would read as a departure plus an arrival and lose
   * their email, photograph, availability and history. Rare in practice, but worth
   * surfacing before it bites.
   */
  withoutStableKey: string[];
  merged: Clinician[];
}

/**
 * Compare an uploaded roster against the current bench.
 *
 * Email, biography and headshot come from the contributors directory rather
 * than the spreadsheet, so they are carried across for anyone already known.
 * Somebody genuinely new arrives without them; the card falls back to initials
 * and the organisers can supply the rest later.
 */
export function diffRoster(
  incoming: RosterRow[],
  current: Clinician[],
  areas: Area[],
  aliases: Record<string, string> = {},
  knownTags = new Set<string>(),
): RosterDiff {
  const areaTags = new Set(areas.flatMap((a) => a.tags));
  const accepted = knownTags.size ? knownTags : areaTags;

  // Index the existing bench by both keys so a row matches whether or not the
  // sheet still carries the same LinkedIn URL.
  const byKey = new Map(current.map((c) => [identityKey(c), c]));
  const bySlug = new Map(current.map((c) => [c.id, c]));
  const find = (row: RosterRow) => byKey.get(identityKey(row)) ?? bySlug.get(slug(row.name));

  const matched = new Set<string>();
  const renamed: { from: string; to: string }[] = [];

  const merged: Clinician[] = incoming.map((row) => {
    const existing = find(row);
    if (existing) {
      matched.add(existing.id);
      if (existing.name !== row.name) renamed.push({ from: existing.name, to: row.name });
    }
    return {
      // Keep the original id on a match. Recommendations already logged point
      // at it, and re-slugging a corrected name would orphan that history.
      id: existing?.id ?? slug(row.name),
      // Availability is an organiser decision, not a spreadsheet column, so a
      // re-upload must not silently un-cancel somebody who pulled out.
      active: existing?.active ?? true,
      name: row.name,
      company: row.company,
      title: row.title,
      tags: row.tags.map((t) => aliases[t] ?? t),
      linkedin: row.linkedin || existing?.linkedin || "",
      // The spreadsheet carries none of these - they come from the
      // contributors directory - so they must be carried across or every
      // upload would wipe the contact details the PDF export depends on.
      email: existing?.email ?? null,
      bio: existing?.bio ?? null,
      headshot: existing?.headshot ?? null,
    };
  });

  // Anyone absent from the new sheet is stood down rather than dropped.
  // Deleting them would orphan the recommendations already logged against
  // them, and the organiser dashboard would show a slug where a name should
  // be. Standing down has exactly the effect intended - no new founder is
  // sent to them - while keeping the record intact.
  const departed = current.filter((c) => !matched.has(c.id));
  merged.push(...departed.map((c) => ({ ...c, active: false })));

  const unmatchedTags = new Map<string, string[]>();
  for (const c of merged.filter((x) => matched.has(x.id) || !departed.includes(x))) {
    for (const t of c.tags) {
      if (!accepted.has(t)) unmatchedTags.set(t, [...(unmatchedTags.get(t) ?? []), c.name]);
    }
  }

  const known = new Set(current.map((c) => c.id));
  return {
    added: merged.filter((c) => !known.has(c.id)).map((c) => c.name),
    removed: departed.filter((c) => c.active).map((c) => c.name),
    renamed,
    changed: merged
      .filter((c) => known.has(c.id) && !departed.includes(c))
      .map((c) => ({ name: c.name, before: bySlug.get(c.id)?.tags ?? [], after: c.tags }))
      .filter((d) => d.before.join("|") !== d.after.join("|")),
    unmatchedTags: [...unmatchedTags].map(([tag, clinicians]) => ({ tag, clinicians })),
    untagged: merged
      .filter((c) => c.active && c.tags.length === 0)
      .map((c) => c.name),
    withoutStableKey: incoming.filter((r) => !r.linkedin.trim()).map((r) => r.name),
    merged,
  };
}
