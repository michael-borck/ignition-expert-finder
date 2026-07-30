import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { Area, Clinician } from "../shared/types.ts";
import { strToU8, zipSync } from "fflate";

import { diffRoster, parseRoster, slug, splitTags } from "./roster.ts";

const SPREADSHEET = join(import.meta.dirname, "..", "Clinician Expertise .xlsx");

const area = (id: string, tags: string[]): Area => ({
  id: id as Area["id"],
  label: id,
  prompt: "",
  strength: "",
  tags,
});

const person = (name: string, tags: string[], extra: Partial<Clinician> = {}): Clinician => ({
  id: slug(name),
  active: true,
  name,
  company: "",
  title: "",
  tags,
  linkedin: "",
  email: `${slug(name)}@example.com`,
  bio: "A biography from the contributors directory.",
  headshot: `headshots/${slug(name)}.jpg`,
  ...extra,
});

test("tags split on slashes and on commas", () => {
  // Two rows in the real sheet used commas inside the slash-separated field,
  // producing compound tags that matched nothing.
  assert.deepEqual(splitTags("Marketing / Sales"), ["Marketing", "Sales"]);
  assert.deepEqual(splitTags("Personal Brand, Public Speaking, Pitching"), [
    "Personal Brand",
    "Public Speaking",
    "Pitching",
  ]);
});

test("the real Ignition spreadsheet parses", { skip: !existsSync() }, () => {
  const rows = parseRoster(new Uint8Array(readFileSync(SPREADSHEET)));
  assert.equal(rows.length, 35, "expected 35 clinicians");
  const adam = rows.find((r) => r.name === "Priya Raman");
  assert.ok(adam, "Priya Raman missing");
  assert.equal(adam!.company, "DeCODE Digital");
  assert.ok(adam!.tags.includes("Marketing"));
  assert.match(adam!.linkedin, /linkedin\.com/);
  assert.ok(
    rows.every((r) => r.name && !r.name.includes("<")),
    "XML leaked into a name",
  );
});

function existsSync() {
  try {
    readFileSync(SPREADSHEET);
    return true;
  } catch {
    return false;
  }
}

test("a rubbish file is refused rather than emptying the bench", () => {
  assert.throws(() => parseRoster(new TextEncoder().encode("not a workbook")));
});

const AREAS = [area("ip", ["Patents", "Trademarks"]), area("market", ["Marketing"])];

test("diff reports who joined, who left and whose tags moved", () => {
  const current = [person("Ada Keen", ["Patents"]), person("Departing Person", ["Marketing"])];
  const incoming = [
    { name: "Ada Keen", company: "Wrays", title: "Partner", tags: ["Patents", "Trademarks"], linkedin: "" },
    { name: "New Arrival", company: "Acme", title: "Founder", tags: ["Marketing"], linkedin: "" },
  ];
  const d = diffRoster(incoming, current, AREAS);
  assert.deepEqual(d.added, ["New Arrival"]);
  assert.deepEqual(d.removed, ["Departing Person"]);
  assert.deepEqual(d.changed, [
    { name: "Ada Keen", before: ["Patents"], after: ["Patents", "Trademarks"] },
  ]);
});

test("email, bio and headshot survive a re-upload", () => {
  // The spreadsheet has none of these - they come from the contributors
  // directory - so a naive replace would wipe every contact detail.
  const current = [person("Ada Keen", ["Patents"])];
  const incoming = [
    { name: "Ada Keen", company: "Wrays", title: "Partner", tags: ["Patents"], linkedin: "" },
  ];
  const merged = diffRoster(incoming, current, AREAS).merged[0];
  assert.equal(merged.email, "ada-keen@example.com");
  assert.ok(merged.bio);
  assert.equal(merged.headshot, "headshots/ada-keen.jpg");
  assert.equal(merged.company, "Wrays", "the sheet should still win on its own columns");
});

test("someone stood down stays stood down after a re-upload", () => {
  // Availability is an organiser decision on the day, not a spreadsheet
  // column. Re-uploading must not silently un-cancel them.
  const current = [person("Ada Keen", ["Patents"], { active: false })];
  const incoming = [
    { name: "Ada Keen", company: "", title: "", tags: ["Patents"], linkedin: "" },
  ];
  assert.equal(diffRoster(incoming, current, AREAS).merged[0].active, false);
});

test("tags matching no need area are reported with who they affect", () => {
  const incoming = [
    { name: "Ada Keen", company: "", title: "", tags: ["Patents", "Underwater Basketry"], linkedin: "" },
  ];
  const d = diffRoster(incoming, [], AREAS);
  assert.deepEqual(d.unmatchedTags, [
    { tag: "Underwater Basketry", clinicians: ["Ada Keen"] },
  ]);
});

test("known typos are corrected on the way in", () => {
  const incoming = [
    { name: "Ada Keen", company: "", title: "", tags: ["Patents and Trademarks"], linkedin: "" },
  ];
  const d = diffRoster(incoming, [], AREAS, { "Patents and Trademarks": "Patents" });
  assert.deepEqual(d.merged[0].tags, ["Patents"]);
  assert.deepEqual(d.unmatchedTags, []);
});

test("clinicians with no tags at all are flagged", () => {
  // Present on the bench, impossible to recommend - easy to create by accident
  // when a row arrives with an empty expertise column.
  const incoming = [{ name: "No Tags", company: "", title: "", tags: [], linkedin: "" }];
  assert.deepEqual(diffRoster(incoming, [], AREAS).untagged, ["No Tags"]);
});

test("an empty cell does not steal the next cell's value", () => {
  // Excel writes blanks as self-closing <c r="C2" s="6"/>. A pattern matching
  // only paired tags starts at the blank and consumes the following cell, so a
  // missing title silently ate the expertise column beside it - which is
  // exactly what happened on a real sheet: one blank title, one lost column.
  const sheet =
    `<worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
    `<row r="2">` +
    `<c r="A2" t="s"><v>1</v></c>` +
    `<c r="B2" t="s"><v>2</v></c>` +
    `<c r="C2" s="6"/>` +
    `<c r="D2" t="s"><v>3</v></c>` +
    `<c r="E2" t="s"><v>4</v></c>` +
    `</row></sheetData></worksheet>`;
  const shared =
    `<sst>` +
    ["Name", "Tomas Iversen", "DEED", "Innovation / Advanced Manufacturing", "https://example.com"]
      .map((v) => `<si><t>${v}</t></si>`)
      .join("") +
    `</sst>`;
  const zip = zipSync({
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/sharedStrings.xml": strToU8(shared),
  });

  const [row] = parseRoster(zip);
  assert.equal(row.name, "Tomas Iversen");
  assert.equal(row.company, "DEED");
  assert.equal(row.title, "", "blank title should stay blank");
  assert.deepEqual(row.tags, ["Innovation", "Advanced Manufacturing"]);
  assert.equal(row.linkedin, "https://example.com");
});

test("correcting a misspelled name keeps the same person", () => {
  // One source document misspells a surname and the other has it right. Fixing
  // that must not read as one person leaving and another arriving, or they lose
  // their email, photo, availability and recommendation history.
  const current = [
    person("Renata Del Rosi", ["Marketing"], {
      linkedin: "https://www.linkedin.com/in/megan-del-borrello/",
      active: false,
    }),
  ];
  const incoming = [
    {
      name: "Renata Del Rossi",
      company: "Emersyn Group",
      title: "Founder",
      tags: ["Marketing"],
      linkedin: "https://www.linkedin.com/in/megan-del-borrello/",
    },
  ];
  const d = diffRoster(incoming, current, AREAS);
  assert.deepEqual(d.added, [], "a rename should not look like an arrival");
  assert.deepEqual(d.removed, [], "a rename should not look like a departure");
  assert.deepEqual(d.renamed, [{ from: "Renata Del Rosi", to: "Renata Del Rossi" }]);

  const m = d.merged[0];
  assert.equal(m.id, "renata-del-rosi", "the original id must survive for logged history");
  assert.equal(m.name, "Renata Del Rossi", "the corrected spelling should be adopted");
  assert.equal(m.email, "renata-del-rosi@example.com", "contact details lost");
  assert.equal(m.active, false, "availability was reset by a rename");
});

test("a trailing slash or http/https difference still matches", () => {
  const current = [
    person("Ada Keen", ["Patents"], { linkedin: "https://www.linkedin.com/in/ada/" }),
  ];
  const incoming = [
    { name: "Ada Keen", company: "", title: "", tags: ["Patents"], linkedin: "http://linkedin.com/in/ada" },
  ];
  const d = diffRoster(incoming, current, AREAS);
  assert.deepEqual(d.added, []);
  assert.equal(d.merged[0].email, "ada-keen@example.com");
});

test("someone dropped from the sheet is stood down, not deleted", () => {
  // Deleting orphans every recommendation already logged against them, and the
  // organiser dashboard would show a slug where a name should be.
  const current = [person("Staying", ["Patents"]), person("Leaving", ["Marketing"])];
  const incoming = [
    { name: "Staying", company: "", title: "", tags: ["Patents"], linkedin: "" },
  ];
  const d = diffRoster(incoming, current, AREAS);
  assert.deepEqual(d.removed, ["Leaving"]);

  const leaving = d.merged.find((c) => c.name === "Leaving");
  assert.ok(leaving, "the departing clinician was deleted rather than stood down");
  assert.equal(leaving!.active, false);
  assert.equal(leaving!.email, "leaving@example.com", "their record should stay intact");
});

test("a clinician already stood down is not re-reported as removed", () => {
  const current = [person("Gone Last Week", ["Patents"], { active: false })];
  const d = diffRoster([], current, AREAS);
  assert.deepEqual(d.removed, [], "already-inactive people should not resurface as news");
});

test("rows with no LinkedIn URL are flagged as fragile", () => {
  // They fall back to name matching, so a later spelling correction would read
  // as a departure plus an arrival and lose their contact details.
  const incoming = [
    { name: "Has Profile", company: "", title: "", tags: ["Patents"], linkedin: "https://linkedin.com/in/x" },
    { name: "No Profile", company: "", title: "", tags: ["Patents"], linkedin: "  " },
  ];
  const d = diffRoster(incoming, [], AREAS);
  assert.deepEqual(d.withoutStableKey, ["No Profile"]);
});
