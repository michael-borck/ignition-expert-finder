import { useMemo, useState } from "react";

import type { Area, Clinician } from "../../../shared/types.ts";
import { track } from "../api.ts";

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function ExpertCard({
  clinician,
  matched = [],
}: {
  clinician: Clinician;
  matched?: string[];
}) {
  const shown = [...clinician.tags]
    .sort((a, b) => Number(matched.includes(b)) - Number(matched.includes(a)))
    .slice(0, 4);

  return (
    <article className="expert">
      {clinician.headshot ? (
        <img
          className="avatar"
          src={`/${clinician.headshot}`}
          alt=""
          loading="lazy"
          width={56}
          height={56}
        />
      ) : (
        // Three clinicians have no photo in the directory document. An initials
        // avatar keeps the row rhythm rather than leaving a ragged gap.
        <div className="avatar" aria-hidden="true">
          {initials(clinician.name)}
        </div>
      )}
      <div>
        <div className="name">{clinician.name}</div>
        <div className="role">
          {clinician.title}
          {clinician.title && clinician.company ? " · " : ""}
          {clinician.company}
        </div>
        <div className="tags">
          {shown.map((t) => (
            <span key={t} className="tag" data-matched={matched.includes(t) ? "true" : "false"}>
              {t}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

export default function Directory({
  areas,
  clinicians,
}: {
  areas: Area[];
  clinicians: Clinician[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string[]>([]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const wanted = new Set(active.flatMap((id) => areas.find((a) => a.id === id)?.tags ?? []));
    return clinicians.filter((c) => {
      if (wanted.size && !c.tags.some((t) => wanted.has(t))) return false;
      if (!q) return true;
      return [c.name, c.company, c.title, ...c.tags].join(" ").toLowerCase().includes(q);
    });
  }, [query, active, areas, clinicians]);

  const toggle = (id: string) => {
    const next = active.includes(id) ? active.filter((a) => a !== id) : [...active, id];
    setActive(next);
    track("directory_searched", "directory", { filters: next, query });
  };

  return (
    <>
      <div className="eyebrow">Browse the bench</div>
      <h1>All {clinicians.length} experts</h1>
      <p className="sub">
        Search by name, company or topic, or filter by the kind of help you are after.
      </p>

      <input
        className="search"
        type="search"
        placeholder="Search a name, company or topic…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Logged on blur rather than per keystroke: the finished query is the
        // interesting signal, and per-keystroke would flood the event log.
        onBlur={() => query && track("directory_searched", "directory", { query })}
      />

      <div className="filters">
        {areas.map((a) => (
          <button
            key={a.id}
            className="filter"
            aria-pressed={active.includes(a.id)}
            onClick={() => toggle(a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>

      <p className="count">
        {results.length} {results.length === 1 ? "expert" : "experts"}
      </p>

      {results.length === 0 ? (
        <p className="empty">
          Nobody matches that. Try a broader search, or clear the filters to see everyone.
        </p>
      ) : (
        <div className="experts">
          {results.map((c) => (
            <ExpertCard key={c.id} clinician={c} />
          ))}
        </div>
      )}
    </>
  );
}
