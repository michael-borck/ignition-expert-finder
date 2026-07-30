import { useState } from "react";

import type { Area, AreaId, AreaScore, Stage } from "../../../shared/types.ts";
import { track } from "../api.ts";

/**
 * Two questions: what stage, and what is worrying you.
 *
 * The scoring is blunt on purpose. Anything the founder names is a 0, anything
 * they do not is a 3, and if they name fewer than three we fall back to the
 * stage's likely gaps at 2 so the third recommendation is an informed guess
 * rather than whichever area sorts first alphabetically.
 *
 * What the founder actually says always outranks the stage heuristic.
 */
function toScores(areas: Area[], stage: Stage, picked: AreaId[]): AreaScore[] {
  return areas.map((a) => {
    if (picked.includes(a.id)) return { area: a.id, confidence: 0 };
    if (stage.likelyGaps.includes(a.id)) return { area: a.id, confidence: 2 };
    return { area: a.id, confidence: 3 };
  });
}

const MAX_PICKS = 3;

export default function Guided({
  areas,
  stages,
  onDone,
}: {
  areas: Area[];
  stages: Stage[];
  onDone: (scores: AreaScore[]) => void;
}) {
  const [stage, setStage] = useState<Stage | null>(null);
  const [picked, setPicked] = useState<AreaId[]>([]);

  const chooseStage = (s: Stage) => {
    track("guided_stage", "guided", { stage: s.id });
    setStage(s);
  };

  const toggle = (id: AreaId) => {
    setPicked((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_PICKS ? [...p, id] : p,
    );
  };

  const submit = () => {
    const scores = toScores(areas, stage!, picked);
    track("areas_scored", "guided", { stage: stage!.id, picked, scores });
    onDone(scores);
  };

  if (!stage) {
    return (
      <>
        <div className="eyebrow">Answer a few questions · 1 of 2</div>
        <h1>Where is the venture up to?</h1>
        <p className="sub">Pick whichever is closest. Nothing here is binding.</p>

        <div className="pathways">
          {stages.map((s) => (
            <button key={s.id} className="pathway" onClick={() => chooseStage(s)}>
              <h2>{s.label}</h2>
              <span className="blurb">{s.description}</span>
            </button>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="eyebrow">Answer a few questions · 2 of 2</div>
      <h1>What is on your mind right now?</h1>
      <p className="sub">
        Pick up to three. If nothing jumps out, skip it — we will suggest a starting point based
        on the stage you chose.
      </p>

      <div className="filters">
        {areas.map((a) => (
          <button
            key={a.id}
            className="filter chip-large"
            aria-pressed={picked.includes(a.id)}
            disabled={!picked.includes(a.id) && picked.length >= MAX_PICKS}
            onClick={() => toggle(a.id)}
            title={a.prompt}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="submit-bar">
        <span className="count">
          {picked.length === 0
            ? `Nothing selected — we will use your stage`
            : `${picked.length} of ${MAX_PICKS} selected`}
        </span>
        <div className="button-row">
          <button className="secondary-action" onClick={() => setStage(null)}>
            Back
          </button>
          <button className="primary-action" onClick={submit}>
            Show me who can help
          </button>
        </div>
      </div>
    </>
  );
}
