import { useState } from "react";

import type { Pathway } from "../../../shared/types.ts";
import { sendFeedback } from "../api.ts";

/**
 * Was the recommendation any good?
 *
 * Deliberately last on the page, after the save button, so it is never standing
 * between a founder and the paper booking sheet. Nothing here is required.
 *
 * The thumb gives the Ignition team one number to judge the tool by. The
 * comment behind a thumbs-down is the part actually worth reading: with a
 * cohort of sixty, a few founders explaining what the tool misread tells you
 * far more than counting thumbs across eight areas and thirty-five clinicians
 * ever could.
 */
export default function Feedback({ pathway }: { pathway: Pathway }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);

  // Failures are swallowed throughout. A founder who has just been told their
  // shortlist is ready should never see an error about telemetry.
  const answer = (helpful: boolean) => {
    setChoice(helpful);
    void sendFeedback(pathway, helpful);
    if (helpful) setDone(true);
  };

  const addComment = () => {
    if (comment.trim()) void sendFeedback(pathway, false, comment);
    setDone(true);
  };

  if (done) {
    return (
      <section className="feedback no-print">
        <p className="count">Thanks — that helps.</p>
      </section>
    );
  }

  return (
    <section className="feedback no-print">
      {choice === null ? (
        <div className="feedback-ask">
          <span>Does this look right to you?</span>
          <div className="button-row">
            <button className="secondary-action" onClick={() => answer(true)}>
              Yes, that fits
            </button>
            <button className="secondary-action" onClick={() => answer(false)}>
              Not really
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p className="count">
            Thanks. What would have been more useful? One line is plenty, and you can skip it.
          </p>
          <textarea
            className="search"
            rows={2}
            autoFocus
            placeholder="e.g. it sent me to IP, but my real problem is I have no customers yet"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                addComment();
              }
            }}
          />
          <div className="composer-actions">
            <button className="secondary-action" onClick={() => setDone(true)}>
              Skip
            </button>
            <button className="primary-action" onClick={addComment}>
              Send
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
