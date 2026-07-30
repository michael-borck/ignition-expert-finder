import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import { matchByName, parseDirectory } from "./directory.ts";

const DOCX = join(import.meta.dirname, "..", "5.Clinicians Contributors Directory 2026.docx");

const haveRealDocument = () => {
  try {
    readFileSync(DOCX);
    return true;
  } catch {
    return false;
  }
};

/** Minimal document in the shape Word produces: name and email in one
 *  paragraph, biography in the next. */
function docx(blocks: { name: string; email: string; bio: string }[]) {
  const body = blocks
    .map(
      (b) =>
        `<w:p><w:r><w:t>${b.name}</w:t></w:r><w:r><w:t>${b.email}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Clinician</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>${b.bio}</w:t></w:r></w:p>`,
    )
    .join("");
  return zipSync({
    "word/document.xml": strToU8(`<w:document><w:body>${body}</w:body></w:document>`),
  });
}

test("name, email and biography are read per person", async () => {
  const entries = await parseDirectory(
    docx([
      { name: "Ada Keen", email: "ada@example.com", bio: "Ada is a patent attorney." },
      { name: "Bo Vance", email: "bo@example.com", bio: "Bo runs growth." },
    ]),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "Ada Keen");
  assert.equal(entries[0].email, "ada@example.com");
  assert.match(entries[0].bio, /patent attorney/);
  assert.doesNotMatch(entries[0].bio, /Clinician/, "the section heading leaked into the bio");
});

test("a document with no body is rejected clearly", async () => {
  await assert.rejects(
    () => parseDirectory(zipSync({ "docProps/app.xml": strToU8("<x/>") })),
    /no document body/,
  );
});

test("names that disagree between the two files still match", async () => {
  // Each of these is a mismatch that occurs between the two source documents
  // in practice.
  const entries = await parseDirectory(
    docx([
      { name: "Dr Harriet Vane", email: "j@example.com", bio: "Ethics." },
      { name: "Marion Fossey GAICD", email: "jen@example.com", bio: "Leadership." },
      { name: "Nicholas Ashby", email: "nick@example.com", bio: "Ventures." },
      { name: "Renata Del Rossi", email: "megan@example.com", bio: "Marketing." },
    ]),
  );
  const bench = [
    { name: "Harriet Vane" }, // title prefix
    { name: "Marion Fossey" }, // post-nominals
    { name: "Nick Ashby" }, // shortened given name
    { name: "Renata Del Rosi" }, // misspelling in the middle
  ];
  const matched = matchByName(entries, bench);
  assert.equal(matched.size, 4, "expected all four awkward names to match");
  assert.equal(matched.get(bench[3])!.email, "megan@example.com");
});

test("two genuinely different people are not paired up", async () => {
  const entries = await parseDirectory([
    { name: "Sofia Marchetti", email: "bec@example.com", bio: "One." },
  ].reduce((_, b) => docx([b]), zipSync({})));
  const matched = matchByName(entries, [{ name: "Sofia Okonkwo" }]);
  assert.equal(matched.size, 0, "two people sharing a first name must not be merged");
});

test("one directory entry is never claimed by two clinicians", async () => {
  const entries = await parseDirectory(
    docx([{ name: "Anna Webb", email: "kate@example.com", bio: "Strategy." }]),
  );
  const bench = [{ name: "Anna Webb" }, { name: "Anna Webber" }];
  const matched = matchByName(entries, bench);
  assert.equal(matched.size, 1);
  assert.equal(matched.get(bench[0])?.email, "kate@example.com");
});

test("the real contributors directory parses", { skip: !haveRealDocument() }, async () => {
  const entries = await parseDirectory(readFileSync(DOCX));
  assert.equal(entries.length, 37, "expected 37 directory entries");
  assert.ok(
    entries.every((e) => e.email.includes("@")),
    "an entry came back without an email",
  );
  assert.ok(
    entries.filter((e) => e.photo).length >= 30,
    "expected at least 30 usable photographs",
  );
  // Photographs are downscaled on the way in; the originals reach 1231px.
  for (const e of entries) {
    if (e.photo) assert.ok(e.photo.byteLength < 200_000, `${e.name}'s photo was not downscaled`);
  }
});
