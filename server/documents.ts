/**
 * Pulls text out of what founders actually upload: pitch decks, business
 * plans, one-pagers.
 *
 * Nothing is written to disk. Bytes arrive, text comes out, the buffer is
 * dropped - which is what the disclaimer shown above the upload control
 * promises, so it has to stay true.
 */

import { unzipSync } from "fflate";

/** What a founder may upload. A pitch deck or plan well over this is almost
 *  certainly a mistake. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * What an organiser may upload at /admin.
 *
 * Higher on purpose: the 2026 contributors directory is 25MB, because it
 * carries 37 full-resolution photographs. Holding admin uploads to the
 * founder-facing limit would reject the real document.
 */
export const MAX_ADMIN_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * Below this many characters of extracted text we treat a document as
 * effectively unreadable. Pitch decks are routinely exported as slide images
 * with no text layer, and a deck that yields two hundred characters of page
 * furniture would otherwise be analysed as if it said something.
 */
const MIN_USEFUL_CHARS = 400;

export interface Extraction {
  text: string;
  /** False when the file parsed but yielded almost nothing worth reading. */
  usable: boolean;
  kind: "txt" | "docx" | "pdf" | "pptx";
  pages?: number;
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/ ([.,;:])/g, "$1").trim();
}

/** DOCX is a zip of XML. Strip tags, keep paragraph breaks as spaces. */
function fromDocx(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("that .docx has no document body");
  const xml = new TextDecoder().decode(doc);
  return tidy(
    xml
      .replace(/<w:p[ >]/g, "\n<w:p ") // keep paragraph boundaries
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"),
  );
}

/**
 * PPTX is a zip of one XML file per slide. Slide text lives in <a:t> runs.
 *
 * Slides are numbered without padding (slide2, slide10), so sorting the file
 * names as strings puts slide10 before slide2 and scrambles the deck. Order
 * matters: the opening slides carry the problem and the customer, which is
 * most of what we are trying to read.
 */
function fromPptx(bytes: Uint8Array): { text: string; pages: number } {
  const files = unzipSync(bytes);
  const slides = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  if (slides.length === 0) throw new Error("that .pptx has no slides");

  const decoder = new TextDecoder();
  const parts = slides.map((name) => {
    const xml = decoder.decode(files[name]);
    return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => m[1])
      .join(" ");
  });
  return {
    text: tidy(
      parts.join("\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    ),
    pages: slides.length,
  };
}

async function fromPdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs 5+ disables eval by default, so there is no isEvalSupported flag to
  // set. useSystemFonts stays off: we only want the characters, and there is no
  // reason to let a founder's deck reach for fonts on the host.
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: false });

  try {
    const doc = await task.promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map((it: any) => it.str ?? "").join(" "));
    }
    return { text: tidy(parts.join("\n")), pages: doc.numPages };
  } finally {
    // Always release the worker, including when a malformed PDF throws.
    await task.destroy();
  }
}

/**
 * How many pages of an image-only deck we are willing to read.
 *
 * Each page costs a vision call - roughly nine seconds against the current
 * endpoint - so an unbounded deck could take minutes. Decks front-load: the
 * problem, the customer and the traction are almost always in the opening
 * slides, and the later ones are team photos and financial projections that
 * say little about where the founder needs help.
 */
export const MAX_RENDERED_PAGES = 5;

/**
 * Rasterise the opening pages of a PDF that has no text layer.
 *
 * Only worth calling when `extract` came back unusable. Rendering is expensive
 * and pointless when the characters are already there for the taking.
 */
export async function renderPages(
  input: Uint8Array,
  limit = MAX_RENDERED_PAGES,
): Promise<string[]> {
  const bytes = normalise(input);
  const [{ createCanvas }, pdfjs] = await Promise.all([
    import("@napi-rs/canvas"),
    import("pdfjs-dist/legacy/build/pdf.mjs"),
  ]);

  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: false });
  try {
    const doc = await task.promise;
    const out: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, limit); i++) {
      const page = await doc.getPage(i);
      // Scale 1.6 keeps slide text legible to the model without ballooning the
      // base64 payload; a full-resolution render is mostly wasted tokens.
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await (page as any).render({ canvasContext: context, viewport, canvas }).promise;
      out.push(canvas.toBuffer("image/png").toString("base64"));
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}

/**
 * Every realistic caller hands us a Buffer - readFileSync, and Fastify's
 * file.toBuffer(). Buffer satisfies the Uint8Array type but pdfjs rejects it
 * at runtime, so normalise once rather than discovering it on a real upload.
 */
function normalise(input: Uint8Array): Uint8Array {
  return Buffer.isBuffer(input) || input.constructor !== Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : input;
}

export async function extract(filename: string, input: Uint8Array): Promise<Extraction> {
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("that file is larger than 20MB");
  }

  const bytes = normalise(input);

  const ext = filename.toLowerCase().split(".").pop() ?? "";

  if (ext === "txt" || ext === "md") {
    const text = tidy(new TextDecoder().decode(bytes));
    return { text, usable: text.length >= MIN_USEFUL_CHARS, kind: "txt" };
  }

  if (ext === "docx") {
    const text = fromDocx(bytes);
    return { text, usable: text.length >= MIN_USEFUL_CHARS, kind: "docx" };
  }

  if (ext === "pptx") {
    const { text, pages } = fromPptx(bytes);
    return { text, usable: text.length >= MIN_USEFUL_CHARS, kind: "pptx", pages };
  }

  if (ext === "pdf") {
    const { text, pages } = await fromPdf(bytes);
    return { text, usable: text.length >= MIN_USEFUL_CHARS, kind: "pdf", pages };
  }

  // Spreadsheets parse fine but say almost nothing useful. A financial model is
  // numbers without narrative: it cannot tell us whether the customer is real,
  // whether anything is protected, or how the team is set up. Rejecting it with
  // a suggestion is more honest than accepting it and producing a confident
  // recommendation from a column of figures.
  if (ext === "xlsx" || ext === "xls" || ext === "csv" || ext === "numbers") {
    throw new Error(
      "a spreadsheet does not tell us much about where you need help - " +
        "try your pitch deck, business plan or a one-pager instead",
    );
  }

  throw new Error(
    `we can read pitch decks and documents - PDF, PowerPoint, Word or plain text - not .${ext}`,
  );
}
