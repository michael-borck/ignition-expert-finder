/**
 * The conversational pathway.
 *
 * Two very different kinds of call, deliberately kept apart:
 *
 *   - Conversation turns are streamed with thinking off. The founder is
 *     waiting on these, and 3s with tokens appearing feels like a
 *     conversation where 17s on a spinner does not.
 *
 *   - One analysis at the end. Also thinking off: measured over ten runs and
 *     two inputs, gemma4:12b returns identical confidence vectors at
 *     temperature 0 with or without it, and off is 10.6s against 42s.
 */

import type { Area, AreaScore } from "../shared/types.ts";
import { complete, completeJSON, type Message } from "./ollama.ts";

/**
 * The interviewer.
 *
 * Told explicitly not to diagnose or name experts. The model is a 12B running
 * locally; it is good at drawing a founder out and unreliable at judging who
 * on a 35-person bench is the right match. That judgement belongs to the
 * matcher, which is deterministic and testable.
 */
export const INTERVIEW_PROMPT = `You are helping a founder at the Curtin Ignition programme work out where their venture needs expert support.

Ask ONE short question at a time and wait for the answer. Be warm, plain-spoken and brief - two or three sentences at most. Australian English.

Draw them out on the things founders most often gloss over: who the customer actually is and what evidence they have, how the business makes money, whether anything is protected, how they are funded, and how they are set up as a team.

Never diagnose, never rank their weaknesses, and never suggest a specific person or type of expert - a separate step does that. If they ask who they should see, say you are still building the picture and ask your next question.

If they have shared a document, use it: ask about what it does not cover rather than what it already says.`;

/** Built from the live area list so a change to data/areas.json cannot leave
 *  the extraction scoring an area the matcher no longer knows about. */
export function extractionSchema(areas: Area[]) {
  return {
    type: "object",
    properties: {
      sector: { type: "string" },
      ...Object.fromEntries(
        areas.map((a) => [
          a.id,
          {
            type: "object",
            properties: {
              confidence: { type: "integer", minimum: 0, maximum: 5 },
              evidence: { type: "string" },
            },
            required: ["confidence", "evidence"],
          },
        ]),
      ),
    },
    required: ["sector", ...areas.map((a) => a.id)],
  };
}

/**
 * Deliberately terse, and measured that way.
 *
 * An earlier version spelled out all eight areas with labels and descriptions,
 * plus a paragraph on not inferring. Against this endpoint that took 165s and
 * returned exactly the same three weakest areas as the short version, which
 * took 42s - the extra context gave the model more to deliberate over without
 * changing the answer. A middle version with a compact id-to-label list cost
 * 54s for the same result again.
 *
 * This relies on the area ids being self-descriptive (`ip`, `funding`,
 * `pitch`), since they are all the model gets. Keep them that way, or this
 * prompt has to grow again and the analysis slows down with it.
 *
 * `areas` is still the source of which ids exist - it drives the schema - so a
 * change to data/areas.json cannot leave this scoring something the matcher
 * does not know about.
 */
export function extractionPrompt(_areas: Area[]): string {
  return `Score how well evidenced each area of this founder's venture is, 0 to 5, where 0 is no evidence at all and 5 is clearly strong. Score every area. Evidence is a short verbatim quote from the founder, or empty if they said nothing about it. Reply with JSON only.`;
}

/**
 * Read slides that have no text layer.
 *
 * One vision call per page, in parallel: they are independent, and serially
 * they would add up to something the founder notices. Thinking stays off -
 * this is transcription, not judgement.
 */
export async function describeSlides(pages: string[]): Promise<string> {
  const transcripts = await Promise.all(
    pages.map((image, i) =>
      complete(
        [
          {
            role: "user",
            content:
              "Transcribe every word visible on this slide, including headings and bullet points. Output the text only.",
            images: [image],
          },
        ],
        { think: false, temperature: 0 },
      )
        .then((t) => `Slide ${i + 1}: ${t.replace(/\s+/g, " ").trim()}`)
        // One unreadable slide should not lose the whole deck.
        .catch(() => ""),
    ),
  );
  return transcripts.filter(Boolean).join("\n");
}

export interface QuestionRequest {
  areaId: string;
  areaLabel: string;
  areaPrompt: string;
  expertName: string;
  expertise: string[];
  /** The founder's own words, when a pathway captured them. */
  evidence?: string;
}

/**
 * Three questions to take into each clinic.
 *
 * This is the difference between handing a founder a name and handing them a
 * prepared twenty minutes. A clinic slot is short, and founders who do not know
 * what they do not know tend to spend the first half of it working out what to
 * ask.
 *
 * Runs after the recommendation is already on screen, so it costs the founder
 * no waiting - the shortlist renders immediately and these fill in.
 */
export async function suggestQuestions(
  requests: QuestionRequest[],
): Promise<Record<string, string[]>> {
  if (requests.length === 0) return {};

  const schema = {
    type: "object",
    properties: Object.fromEntries(
      requests.map((r) => [
        r.areaId,
        {
          type: "array",
          items: { type: "string" },
          minItems: 3,
          maxItems: 3,
        },
      ]),
    ),
    required: requests.map((r) => r.areaId),
  };

  const brief = requests
    .map((r) => {
      const said = r.evidence ? ` The founder said: "${r.evidence}".` : "";
      return `${r.areaId} — meeting ${r.expertName} about ${r.areaLabel} (${r.areaPrompt}). ${r.expertName} works on ${r.expertise.join(", ")}.${said}`;
    })
    .join("\n");

  return completeJSON<Record<string, string[]>>(
    [
      {
        role: "system",
        content:
          "A founder has short clinic sessions booked with these experts. For each one, write exactly three questions they should ask. " +
          "Make them specific and answerable in a twenty minute conversation - a question about this founder's actual situation, not a topic heading. " +
          "Where the founder's own words are given, build on them. " +
          "Write in the founder's voice, second person, plain Australian English, no jargon. Reply with JSON only.",
      },
      { role: "user", content: brief },
    ],
    schema,
    // Same reasoning as the extraction: measured identical at temperature 0
    // either way, and off is several times faster.
    { think: false, temperature: 0.2 },
  );
}

type Extracted = Record<string, { confidence: number; evidence: string }> & { sector: string };

/**
 * Turn a conversation (and any uploaded document) into the same AreaScore[]
 * the other pathways produce, so all four share one matcher.
 */
export async function analyse(
  areas: Area[],
  transcript: Message[],
  documentText?: string,
): Promise<{ scores: AreaScore[]; sector: string }> {
  const said = transcript
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "Founder" : "Interviewer"}: ${m.content}`)
    .join("\n");

  const content = documentText
    ? `Document the founder uploaded:\n"""\n${documentText.slice(0, 60_000)}\n"""\n\nConversation:\n${said}`
    : said;

  const result = await completeJSON<Extracted>(
    [
      { role: "system", content: extractionPrompt(areas) },
      { role: "user", content },
    ],
    extractionSchema(areas),
    // Thinking off. This was on originally, because three early runs appeared
    // to disagree - but re-measured properly across ten runs and two different
    // inputs, the confidence vectors came back byte-identical at temperature 0
    // either way. What actually varied was our own tie-breaking, which used to
    // be alphabetical and now uses the session-seeded shuffle in rankAreas.
    //
    // Off is 10.6s against 42s, on the one call the founder waits for.
    { think: false, temperature: 0 },
  );

  const scores: AreaScore[] = areas.map((a) => ({
    area: a.id,
    confidence: Math.max(0, Math.min(5, result[a.id]?.confidence ?? 0)),
    evidence: result[a.id]?.evidence || undefined,
  }));

  return { scores, sector: result.sector ?? "" };
}
