import assert from "node:assert/strict";
import test from "node:test";

import { parseRoster } from "./roster.ts";
import { ROSTER_HEADER, rosterRows, toCsv, writeSheet } from "./xlsx.ts";

const PEOPLE = [
  {
    name: "Ada Keen",
    company: "Wrays",
    title: "Partner",
    tags: ["Patents", "Trademarks"],
    linkedin: "https://www.linkedin.com/in/ada/",
  },
  {
    name: "Bo Vance & Co",
    company: "Growth <Partners>",
    title: "",
    tags: ["Marketing"],
    linkedin: "",
  },
];

test("an exported roster can be re-uploaded unchanged", () => {
  // The team use the spreadsheet elsewhere, so an export has to survive a
  // round trip through the same parser that reads their original file.
  const book = writeSheet(ROSTER_HEADER, rosterRows(PEOPLE));
  const parsed = parseRoster(book);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Ada Keen");
  assert.equal(parsed[0].company, "Wrays");
  assert.equal(parsed[0].title, "Partner");
  assert.deepEqual(parsed[0].tags, ["Patents", "Trademarks"]);
  assert.equal(parsed[0].linkedin, "https://www.linkedin.com/in/ada/");
});

test("ampersands and angle brackets survive the round trip", () => {
  const parsed = parseRoster(writeSheet(ROSTER_HEADER, rosterRows(PEOPLE)));
  assert.equal(parsed[1].name, "Bo Vance & Co");
  assert.equal(parsed[1].company, "Growth <Partners>");
});

test("an empty cell does not shift the columns after it", () => {
  // Bo has no title and no LinkedIn. Blank cells are omitted entirely, so the
  // reader has to place cells by their column reference rather than by order.
  const parsed = parseRoster(writeSheet(ROSTER_HEADER, rosterRows(PEOPLE)));
  assert.equal(parsed[1].title, "");
  assert.deepEqual(parsed[1].tags, ["Marketing"], "expertise landed in the wrong column");
  assert.equal(parsed[1].linkedin, "");
});

test("csv quotes embedded quotes and commas", () => {
  const csv = toCsv(["Name", "Note"], [['Ada "Ace" Keen', "Patents, Trademarks"]]);
  assert.match(csv, /"Ada ""Ace"" Keen"/);
  assert.match(csv, /"Patents, Trademarks"/);
});
