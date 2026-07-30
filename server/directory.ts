/**
 * Reads the contributors directory: email, biography and headshot.
 *
 * A Node port of the extraction in scripts/build_clinicians.py, so the Ignition
 * team can upload a revised directory themselves rather than asking a developer
 * to run a script. The Docker image has no Python.
 *
 * The two source documents are not interchangeable. The spreadsheet carries
 * expertise tags, which decide who gets recommended; this document carries the
 * contact details and photograph the founder actually sees. Both are needed,
 * and each is uploaded separately because that is how Ignition maintain them.
 */

import { unzipSync } from "fflate";

/** Headshots are rendered as small round avatars, so downscale hard - the
 *  source document holds images up to 1231px and 36MB in total. */
const AVATAR_PX = 400;

const EMAIL = /^[\w.+-]+@[\w.-]+\.\w{2,}$/;

export interface DirectoryEntry {
  name: string;
  email: string;
  bio: string;
  /** PNG bytes, already downscaled. Absent when the document had no usable
   *  photo - three clinicians have none, and one has a Word metafile
   *  placeholder rather than an image. */
  photo?: Uint8Array;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Parse the document into one entry per clinician.
 *
 * The layout is a block per person: a name, an email, biography paragraphs,
 * then the headshot. A name and its email are sometimes in the same paragraph
 * and sometimes not, so paragraph boundaries are unreliable for names - but
 * document order reliably tells us which person an image belongs to, because
 * an image always follows the email of its owner.
 */
export async function parseDirectory(bytes: Uint8Array): Promise<DirectoryEntry[]> {
  const files = unzipSync(bytes);
  const documentXml = files["word/document.xml"];
  if (!documentXml) throw new Error("that .docx has no document body");

  const relsXml = files["word/_rels/document.xml.rels"];
  const rels = new Map<string, string>();
  if (relsXml) {
    const text = new TextDecoder().decode(relsXml);
    for (const m of text.matchAll(/Id="(rId\d+)"[^>]*Target="media\/([^"]+)"/g)) {
      rels.set(m[1], m[2]);
    }
  }

  const xml = new TextDecoder().decode(documentXml);

  // Flatten to an ordered stream of text lines and image references.
  type Event = { kind: "line"; value: string } | { kind: "img"; value: string };
  const events: Event[] = [];
  for (const para of xml.split(/(?=<w:p[ >])/)) {
    const embed = /r:embed="(rId\d+)"/.exec(para);
    if (embed) {
      const target = rels.get(embed[1]);
      if (target) events.push({ kind: "img", value: target });
    }
    for (const raw of para.replace(/<[^>]+>/g, "\n").split("\n")) {
      const line = decode(raw).trim();
      if (line) events.push({ kind: "line", value: line });
    }
  }

  const entries: (DirectoryEntry & { image?: string; bioParts: string[] })[] = [];
  let current: (typeof entries)[number] | undefined;
  let previous = "";

  for (const e of events) {
    if (e.kind === "img") {
      if (current && !current.image) current.image = e.value;
      continue;
    }
    if (EMAIL.test(e.value)) {
      current = { name: previous, email: e.value, bio: "", bioParts: [] };
      entries.push(current);
    } else if (current) {
      // Skip section headings and the stray layout integers Word leaves
      // behind around anchored images.
      if (e.value !== "Clinician" && e.value !== "Clinicians" && !/^-?\d+$/.test(e.value)) {
        current.bioParts.push(e.value);
      }
    }
    previous = e.value;
  }

  const out: DirectoryEntry[] = [];
  for (const entry of entries) {
    const bio = entry.bioParts.join(" ").replace(/\s+/g, " ").trim();
    const photo = entry.image ? await toAvatar(files[`word/media/${entry.image}`]) : undefined;
    out.push({ name: entry.name, email: entry.email, bio, ...(photo ? { photo } : {}) });
  }
  return out;
}

/** Decode, downscale and re-encode. Returns undefined for anything that is not
 *  a real image - Word leaves metafile placeholders behind. */
export async function toAvatar(raw: Uint8Array | undefined): Promise<Uint8Array | undefined> {
  if (!raw?.byteLength) return undefined;
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(Buffer.from(raw));
    const scale = Math.min(1, AVATAR_PX / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(w, h);
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas.toBuffer("image/jpeg", 82);
  } catch {
    return undefined; // not a decodable image
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/**
 * The two documents disagree about names, so match leniently.
 *
 * Real cases from the 2026 files: "Dr Harriet Vane", "Marion Fossey
 * GAICD CRP", "Nicholas" against "Nick", a misspelling of Del Rossi, and one
 * entry where the given name is missing entirely. Exact matching found 30 of 35.
 */
export function matchByName<T extends { name: string }>(
  entries: DirectoryEntry[],
  people: T[],
): Map<T, DirectoryEntry> {
  const pool = new Map(entries.map((e) => [norm(e.name), e] as const));
  const found = new Map<T, DirectoryEntry>();

  for (const person of people) {
    const key = norm(person.name);
    let hit = pool.get(key);

    if (!hit) {
      // Titles, post-nominals and shortened given names all show up as one
      // string containing the other.
      for (const [candidate, entry] of pool) {
        if (candidate.includes(key) || key.includes(candidate)) {
          hit = entry;
          break;
        }
      }
    }
    if (!hit) {
      // Fall back to surname plus first initial, which survives Nick/Nicholas
      // and a mistyped vowel in the middle of a name.
      const surname = norm(person.name.split(/\s+/).at(-1) ?? "");
      const initial = key[0] ?? "";
      for (const [candidate, entry] of pool) {
        if (surname.length > 3 && candidate.includes(surname) && candidate.startsWith(initial)) {
          hit = entry;
          break;
        }
      }
    }

    if (!hit) {
      // Last resort: a misspelling in the middle of a name defeats both of the
      // above, because neither string contains the other. "Del Rosi" against
      // "Del Rossi" is one inserted letter and is a real case in these files.
      let best: DirectoryEntry | undefined;
      let bestDistance = Infinity;
      for (const [candidate, entry] of pool) {
        const d = editDistance(key, candidate);
        if (d < bestDistance) {
          bestDistance = d;
          best = entry;
        }
      }
      // Two edits over a full name is tight enough to avoid pairing two
      // genuinely different people.
      if (best && bestDistance <= 2) hit = best;
    }

    if (hit) {
      found.set(person, hit);
      pool.delete(norm(hit.name));
    }
  }
  return found;
}

/** Levenshtein distance, iterative single-row. Names are short; this is not a
 *  hot path and clarity matters more than cleverness here. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
    }
    previous = current;
  }
  return previous[b.length];
}
