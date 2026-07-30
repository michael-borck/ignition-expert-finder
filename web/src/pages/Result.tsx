import { useEffect, useState } from "react";

import type { ExpertMatch, Recommendation } from "../../../shared/types.ts";
import { fetchQuestions, track } from "../api.ts";
import Feedback from "./Feedback.tsx";

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function Expert({
  match,
  role,
  areaLabel,
}: {
  match: ExpertMatch;
  role: "primary" | "alternate";
  areaLabel: string;
}) {
  const c = match.clinician;
  return (
    <article className={`expert expert-${role}`}>
      {c.headshot ? (
        <img className="avatar" src={`/${c.headshot}`} alt="" loading="lazy" width={56} height={56} />
      ) : (
        <div className="avatar" aria-hidden="true">
          {initials(c.name)}
        </div>
      )}
      <div className="expert-body">
        <div className="name">{c.name}</div>
        <div className="role">
          {c.title}
          {c.title && c.company ? " · " : ""}
          {c.company}
        </div>

        {/* The reason this person, not just the fact of them. */}
        {match.matchedTags.length > 0 && (
          <p className="why">
            Works on <strong>{match.matchedTags.slice(0, 3).join(", ")}</strong>
          </p>
        )}

        {role === "primary" && c.bio && (
          <details
            className="bio"
            onToggle={(e) =>
              e.currentTarget.open &&
              track("expert_expanded", "score", { clinicianId: c.id, areaLabel })
            }
          >
            <summary>More about {c.name.split(" ")[0]}</summary>
            <p>{c.bio}</p>
          </details>
        )}

        <div className="contact">
          {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
          {c.linkedin && (
            <a href={c.linkedin} target="_blank" rel="noreferrer">
              LinkedIn
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

export default function Result({
  recommendation,
  onRestart,
  onSwitch,
}: {
  recommendation: Recommendation;
  onRestart: () => void;
  onSwitch: () => void;
}) {
  const { strengths, areas } = recommendation;
  const [questions, setQuestions] = useState<Record<string, string[]>>({});
  const [asking, setAsking] = useState(true);

  useEffect(() => {
    // Deliberately after render. A clinic slot is short, and founders who do
    // not know what they do not know spend the first half of it working out
    // what to ask - but that is not worth making anyone wait for.
    let live = true;
    fetchQuestions(
      recommendation.pathway,
      areas.map((a) => ({
        areaId: a.area.id,
        clinicianId: a.primary.clinician.id,
        evidence: a.evidence,
      })),
    )
      .then((q) => live && setQuestions(q))
      .catch(() => {
        // Nothing to say to the founder: they already have the shortlist.
      })
      .finally(() => live && setAsking(false));
    return () => {
      live = false;
    };
  }, [recommendation]);

  return (
    <>
      {/* Printed pages get separated from their context immediately, so the
          paper has to say what it is and when it was produced. */}
      <div className="print-only print-header">
        <strong>Curtin Ignition — expert shortlist</strong>
        <span>
          {new Date().toLocaleDateString("en-AU", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </span>
      </div>

      <div className="eyebrow">Your clinic shortlist</div>

      {/* Open with what is working. These founders are already anxious; leading
          with a list of deficiencies gets the tool dismissed rather than used. */}
      {strengths.length > 0 ? (
        <>
          <h1>
            You are already solid on {strengths.slice(0, 2).map((s) => s.label.toLowerCase()).join(" and ")}
          </h1>
          <p className="sub">
            That is your foundation. Here are the three places where an hour with the right person
            will move you furthest this week.
          </p>
        </>
      ) : (
        <>
          <h1>Three places to start</h1>
          <p className="sub">
            You are early across the board, which is completely normal at this stage. These three
            will move you furthest this week.
          </p>
        </>
      )}

      {areas.map((rec, i) => (
        <section key={rec.area.id} className="rec">
          <div className="rec-head">
            <span className="rank">{i + 1}</span>
            <div>
              <h2>{rec.area.label}</h2>
              <p className="role">{rec.area.prompt}</p>
            </div>
          </div>

          {rec.evidence && <blockquote className="evidence">“{rec.evidence}”</blockquote>}

          <Expert match={rec.primary} role="primary" areaLabel={rec.area.label} />

          {(questions[rec.area.id] || asking) && (
            <section className="questions">
              <h3>
                What to ask {rec.primary.clinician.name.split(" ")[0]}
                {asking && !questions[rec.area.id] && (
                  <span className="role"> — working these out…</span>
                )}
              </h3>
              {questions[rec.area.id] && (
                <ol>
                  {questions[rec.area.id].map((q, qi) => (
                    <li key={qi}>{q}</li>
                  ))}
                </ol>
              )}
            </section>
          )}

          {rec.alternates.length > 0 && (
            <>
              {/* Shown, not hidden behind the primary: the founder is walking to
                  a paper sheet and needs to know who else fits before they get
                  there and find the first choice is fully booked. */}
              <p className="alt-label">
                Also good for this, if {rec.primary.clinician.name.split(" ")[0]} is booked
              </p>
              <div className="alts">
                {rec.alternates.map((m) => (
                  <Expert
                    key={m.clinician.id}
                    match={m}
                    role="alternate"
                    areaLabel={rec.area.label}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      ))}

      {/* Print only. The founder takes this to the paper booking sheet, so it
          has to work as a piece of paper: who to see, how to reach them, and
          somewhere to write the slot they claimed. */}
      <section className="print-only booking">
        <h2>Once you have booked</h2>
        <p className="role">Write in the time you claimed on the booking sheet.</p>
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Who you saw</th>
              <th>Day</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((rec) => (
              <tr key={rec.area.id}>
                <td>{rec.area.label}</td>
                <td />
                <td />
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="submit-bar no-print">
        <button
          className="primary-action"
          onClick={() => {
            track("pdf_saved", recommendation.pathway, {
              areas: areas.map((a) => a.area.id),
            });
            // The browser's own dialog offers "Save as PDF" on every platform
            // this will be opened on, which beats shipping a PDF library and a
            // second layout to keep in sync.
            window.print();
          }}
        >
          Save or print this
        </button>
        <div className="button-row">
          <button className="secondary-action" onClick={onSwitch}>
            Try a different starting point
          </button>
          <button className="secondary-action" onClick={onRestart}>
            Start again
          </button>
        </div>
      </div>

      <Feedback pathway={recommendation.pathway} />
    </>
  );
}
