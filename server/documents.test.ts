import assert from "node:assert/strict";
import test from "node:test";

import { zipSync, strToU8 } from "fflate";

import { extract, MAX_UPLOAD_BYTES } from "./documents.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** Roughly what a short business plan yields - comfortably over the
 *  "did this actually extract" threshold, unlike a deck of slide images. */
const PROSE =
  "We are building a corrosion sensor for mining conveyor belts. " +
  "A prototype is live at one Pilbara site and a second pilot is signed. " +
  "We have not filed anything for the sensor design and are unsure whether we should. " +
  "Neither founder has raised money before and we do not know what a data room is. " +
  "Revenue so far is limited to the pilot fee, and we need help with go to market. " +
  "Both founders are mechanical engineers with fifteen years in heavy industry between them. " +
  "We have spoken to about fifteen maintenance managers across four mine sites. " +
  "The sensor detects early stage corrosion before a belt failure causes an unplanned shutdown, " +
  "which the maintenance managers we spoke to costed at roughly forty thousand dollars an hour. ";

test("plain text is read as-is", async () => {
  const r = await extract("plan.txt", enc(PROSE));
  assert.equal(r.kind, "txt");
  assert.ok(r.usable);
  assert.match(r.text, /corrosion sensor/);
});

test("a nearly empty file is parsed but flagged unusable", async () => {
  // Analysing this as though it said something would produce a confident
  // recommendation built on nothing.
  const r = await extract("stub.txt", enc("Pitch deck"));
  assert.equal(r.usable, false);
});

test("docx paragraphs are extracted without their XML", async () => {
  const xml =
    `<?xml version="1.0"?><w:document><w:body>` +
    `<w:p><w:r><w:t>Corro-Sense pitch</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>${PROSE}</w:t></w:r></w:p>` +
    `</w:body></w:document>`;
  const zip = zipSync({ "word/document.xml": strToU8(xml) });
  const r = await extract("deck.docx", zip);
  assert.equal(r.kind, "docx");
  assert.ok(r.usable);
  assert.match(r.text, /Corro-Sense pitch/);
  assert.doesNotMatch(r.text, /<w:/, "XML tags leaked into the extracted text");
});

test("ampersands and angle brackets survive extraction", async () => {
  const xml =
    `<w:document><w:body><w:p><w:r><w:t>Patents &amp; Trademarks</w:t></w:r></w:p></w:body></w:document>`;
  const zip = zipSync({ "word/document.xml": strToU8(xml) });
  const r = await extract("tags.docx", zip);
  assert.match(r.text, /Patents & Trademarks/);
});

test("a docx with no document body is rejected clearly", async () => {
  const zip = zipSync({ "docProps/app.xml": strToU8("<x/>") });
  await assert.rejects(() => extract("broken.docx", zip), /no document body/);
});

test("unsupported types name what is accepted", async () => {
  await assert.rejects(
    () => extract("logo.png", enc("x")),
    /PDF, PowerPoint, Word or plain text/,
  );
});

test("oversized uploads are refused before parsing", async () => {
  const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  await assert.rejects(() => extract("huge.pdf", big), /larger than 20MB/);
});

test("a Node Buffer is accepted, not just a bare Uint8Array", async () => {
  // readFileSync and Fastify's file.toBuffer() both hand back a Buffer. It
  // satisfies the Uint8Array type but pdfjs rejects it at runtime, so this
  // would otherwise only fail on a real upload.
  const r = await extract("plan.txt", Buffer.from(PROSE, "utf8"));
  assert.ok(r.usable);
  assert.match(r.text, /corrosion sensor/);
});

test("pptx slide text is extracted in slide order", async () => {
  // Slides are numbered without padding, so sorting the file names as strings
  // puts slide10 before slide2 and scrambles the deck. The opening slides
  // carry the problem and the customer, which is most of what we want.
  const slide = (t: string) =>
    strToU8(`<p:sld><p:cSld><p:spTree><a:t>${t}</a:t></p:spTree></p:cSld></p:sld>`);
  const zip = zipSync({
    "ppt/slides/slide1.xml": slide("First slide. " + PROSE),
    "ppt/slides/slide2.xml": slide("Second slide."),
    "ppt/slides/slide10.xml": slide("Tenth slide."),
  });
  const r = await extract("deck.pptx", zip);
  assert.equal(r.kind, "pptx");
  assert.equal(r.pages, 3);
  assert.ok(r.usable);
  assert.ok(
    r.text.indexOf("Second slide") < r.text.indexOf("Tenth slide"),
    "slide 10 was ordered before slide 2",
  );
});

test("spreadsheets are refused with a useful suggestion", async () => {
  // They parse fine but are numbers without narrative - they cannot say
  // whether the customer is real or whether anything is protected.
  await assert.rejects(
    () => extract("model.xlsx", enc("x")),
    /pitch deck, business plan or a one-pager/,
  );
});
