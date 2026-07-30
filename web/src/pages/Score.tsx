import { useState } from "react";

import type { Area, AreaId, AreaScore } from "../../../shared/types.ts";
import { track } from "../api.ts";

/**
 * Self-assessment across all eight areas.
 *
 * The scale is labelled in terms of evidence rather than ability - "no idea
 * yet" to "sorted", not "weak" to "strong". A founder rating themselves badly
 * on a competence scale feels judged; rating how far along something is feels
 * like describing the venture, which is what we actually want to know.
 */
const SCALE = [
  { value: 1, label: "No idea yet" },
  { value: 2, label: "Early thoughts" },
  { value: 3, label: "Taking shape" },
  { value: 4, label: "Mostly there" },
  { value: 5, label: "Sorted" },
];

export default function Score({
  areas,
  onDone,
}: {
  areas: Area[];
  onDone: (scores: AreaScore[]) => void;
}) {
  const [scores, setScores] = useState<Partial<Record<AreaId, number>>>({});
  const rated = Object.keys(scores).length;
  const complete = rated === areas.length;

  const set = (area: AreaId, confidence: number) => {
    setScores((s) => ({ ...s, [area]: confidence }));
  };

  const submit = () => {
    const payload: AreaScore[] = areas.map((a) => ({
      area: a.id,
      confidence: scores[a.id]!,
    }));
    track("areas_scored", "score", { scores: payload });
    onDone(payload);
  };

  return (
    <>
      <div className="eyebrow">Rate yourself</div>
      <h1>Where is your venture up to?</h1>
      <p className="sub">
        Eight areas, one tap each. There are no wrong answers — an honest "no idea yet" is far
        more useful than an optimistic guess, because it is what gets you the right expert.
      </p>

      <ol className="scale-list">
        {areas.map((area) => (
          <li key={area.id} className="scale-row">
            <div>
              <div className="name">{area.label}</div>
              <div className="role">{area.prompt}</div>
            </div>
            <div
              className="scale"
              role="radiogroup"
              aria-label={`${area.label}: ${area.prompt}`}
            >
              {SCALE.map((s) => (
                <button
                  key={s.value}
                  role="radio"
                  aria-checked={scores[area.id] === s.value}
                  aria-label={s.label}
                  title={s.label}
                  className="dot"
                  onClick={() => set(area.id, s.value)}
                >
                  {s.value}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>

      <div className="submit-bar">
        <span className="count">
          {complete ? "All eight rated" : `${rated} of ${areas.length} rated`}
        </span>
        <button className="primary-action" disabled={!complete} onClick={submit}>
          Show me who can help
        </button>
      </div>
    </>
  );
}
