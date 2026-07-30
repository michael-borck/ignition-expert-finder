import type { Pathway } from "../../../shared/types.ts";

/**
 * The four front doors.
 *
 * Ordered by how much the founder already knows about their own gap rather
 * than by how much work each takes. Someone who knows they need a patent
 * attorney should reach the directory immediately; someone who does not know
 * what they do not know is the person this whole tool exists for, and they get
 * the first and most prominent option.
 *
 * Each door states its time cost up front. Founders are choosing between these
 * in a busy week, and an unlabelled choice invites paralysis.
 */
const DOORS: {
  id: Pathway;
  title: string;
  cost: string;
  blurb: string;
  suggested?: boolean;
}[] = [
  {
    id: "chat",
    title: "Talk it through",
    cost: "About 5 minutes",
    blurb:
      "Describe your venture, or upload your pitch deck or business plan. Best if you are not sure where your gaps are.",
    suggested: true,
  },
  {
    id: "guided",
    title: "Answer a few questions",
    cost: "About 1 minute",
    blurb:
      "Two quick questions: where the venture is up to, and what is worrying you most.",
  },
  {
    id: "score",
    title: "Rate yourself",
    cost: "About 3 minutes",
    blurb:
      "Score your confidence across eight areas of the business and see the whole picture at once.",
  },
  {
    id: "directory",
    title: "Browse the bench",
    cost: "Under a minute",
    blurb: "See all the experts and search by name, company or topic. Best if you already know what you need.",
  },
];

export default function Landing({ onChoose }: { onChoose: (p: Pathway) => void }) {
  return (
    <>
      <div className="eyebrow">Curtin Ignition</div>
      <h1>Find the right expert for where you are now</h1>
      <p className="sub">
        Ignition brings a bench of experienced clinicians to the programme. This helps you work
        out which of them will move your venture furthest this week — then you take the
        recommendation to the booking sheet. Pick whichever starting point suits you; you can
        try another afterwards.
      </p>

      <div className="pathways">
        {DOORS.map((d) => (
          <button
            key={d.id}
            className="pathway"
            data-suggested={d.suggested ? "true" : "false"}
            onClick={() => onChoose(d.id)}
          >
            <span className="cost">{d.cost}</span>
            <h2>{d.title}</h2>
            <span className="blurb">{d.blurb}</span>
          </button>
        ))}
      </div>
    </>
  );
}
