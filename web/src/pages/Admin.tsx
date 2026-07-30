import { Fragment, useEffect, useState } from "react";

import type { Clinician } from "../../../shared/types.ts";
import ClinicianEditor, { type TagOption } from "./ClinicianEditor.tsx";

interface Summary {
  ready: boolean;
  unreachable: string[];
  founders: number;
  capacity: number;
  coverage: { areaId: string; area: string; experts: number; specialists: number }[];
  demand: { area_id: string; area: string; founders: number; primaries: number }[];
  funnel: { pathway: string; started: number; completed: number; saved: number }[];
  feedback: {
    helpful: number;
    unhelpful: number;
    comments: { ts: string; pathway: string; comment: string }[];
  };
  pathways: { pathway: string; sessions: number }[];
  load: { clinicianId: string; name: string; company: string; primaries: number }[];
}

const KEY = "expert-finder-admin";

interface Diff {
  document: "roster" | "directory";
  total: number;
  matched?: number;
  photos?: number;
  unmatchedBench?: string[];
  unmatchedDirectory?: string[];
  added: string[];
  removed: string[];
  renamed?: { from: string; to: string }[];
  changed: { name: string; before: string[]; after: string[] }[];
  unmatchedTags?: { tag: string; clinicians: string[] }[];
  untagged?: string[];
  withoutStableKey?: string[];
}

/**
 * Replacing the bench, and standing individuals down.
 *
 * Upload never applies straight away. A malformed sheet that quietly emptied
 * the bench mid-programme would be far worse than a refused upload, so the
 * organiser sees exactly what would change and confirms it.
 */
function Bench({ password }: { password: string }) {
  const [clinicians, setClinicians] = useState<Clinician[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auth = { authorization: `Bearer ${password}` };

  const refresh = async () => {
    const [people, tags] = await Promise.all([
      fetch("/api/admin/bench", { headers: auth }).then((r) => r.json()),
      fetch("/api/admin/tags", { headers: auth }).then((r) => r.json()),
    ]);
    setClinicians(people);
    setTagOptions(tags);
  };

  const json = async (path: string, method: string, body?: unknown) => {
    const r = await fetch(path, {
      method,
      headers: body ? { ...auth, "content-type": "application/json" } : auth,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? `server returned ${r.status}`);
    return data;
  };

  const save = async (id: string | null, fields: Partial<Clinician>) => {
    await json(id ? `/api/admin/clinician/${id}` : "/api/admin/clinician", "POST", fields);
    setEditing(null);
    setAdding(false);
    await refresh();
  };

  const remove = async (id: string) => {
    await json(`/api/admin/clinician/${id}`, "DELETE");
    setEditing(null);
    await refresh();
  };

  const photo = async (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const r = await fetch(`/api/admin/clinician/${id}/photo`, {
      method: "POST",
      headers: auth,
      body: form,
    });
    if (!r.ok) throw new Error((await r.json()).error ?? "that image could not be read");
    await refresh();
  };

  useEffect(() => {
    void refresh();
  }, [password]);

  const send = async (path: string, f: File) => {
    const form = new FormData();
    form.append("file", f);
    const r = await fetch(path, { method: "POST", headers: auth, body: form });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "that sheet could not be read");
    return data;
  };

  const preview = async (f: File) => {
    setError(null);
    setNote(null);
    try {
      setFile(f);
      setDiff(await send("/api/admin/bench/preview", f));
    } catch (e) {
      setError((e as Error).message);
      setDiff(null);
    }
  };

  const apply = async () => {
    if (!file) return;
    try {
      const r = await send("/api/admin/bench/apply", file);
      setNote(
        r.document === "directory"
          ? `Directory applied — ${r.matched} clinicians updated, ${r.photos} photographs.`
          : `Bench replaced — ${r.total} clinicians now live.`,
      );
      setDiff(null);
      setFile(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = async (id: string, active: boolean) => {
    await fetch(`/api/admin/clinician/${id}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ active }),
    });
    await refresh();
  };

  const inactive = clinicians.filter((c) => !c.active).length;

  // A plain link cannot carry the bearer token, so fetch and hand the browser
  // a blob instead.
  const download = async (path: string, filename: string) => {
    const r = await fetch(path, { headers: auth });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <section className="panel">
        <h2>Update the bench</h2>
        <p className="role">
          Drop in either of the two documents Ignition maintain — the tool works out which is
          which. You always see what would change before anything is applied.
        </p>
        <ul className="role doc-kinds">
          <li>
            <strong>Clinician Expertise (.xlsx)</strong> — who is on the bench and what they
            work on. This decides who gets recommended.
          </li>
          <li>
            <strong>Contributors Directory (.docx)</strong> — email addresses, biographies and
            photographs. This is what the founder sees and how they make contact.
          </li>
        </ul>

        {error && <p className="error-note">{error}</p>}
        {note && <p className="doc-note">{note}</p>}

        <label className="secondary-action file-button">
          Choose a file…
          <input
            type="file"
            accept=".xlsx,.docx"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void preview(f);
              e.target.value = "";
            }}
          />
        </label>

        {diff?.document === "directory" && (
          <div className="callout diff">
            <p>
              <strong>Contributors directory</strong> — {diff.total} entries, matching{" "}
              {diff.matched} of the {clinicians.length} people on the bench, with {diff.photos}{" "}
              photographs.
            </p>
            {diff.unmatchedBench && diff.unmatchedBench.length > 0 && (
              <p className="warn">
                <strong>No entry for</strong> {diff.unmatchedBench.join(", ")} — they keep their
                current details.
              </p>
            )}
            {diff.unmatchedDirectory && diff.unmatchedDirectory.length > 0 && (
              <p className="warn">
                <strong>In the directory but not on the bench:</strong>{" "}
                {diff.unmatchedDirectory.join(", ")}. They need a row in the expertise
                spreadsheet before they can be recommended.
              </p>
            )}
            <div className="button-row">
              <button className="primary-action" onClick={apply}>
                Apply this
              </button>
              <button className="secondary-action" onClick={() => setDiff(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {diff?.document === "roster" && (
          <div className="callout diff">
            <p>
              <strong>{diff.total} clinicians</strong> in that sheet.
            </p>
            <ul>
              <li>
                {diff.added?.length ?? 0} added{diff.added?.length ? `: ${diff.added.join(", ")}` : ""}
              </li>
              <li>
                {diff.removed?.length ?? 0} no longer on the sheet — they will be stood down,
                not deleted, so anything already recommended still resolves
                {diff.removed?.length ? `: ${diff.removed.join(", ")}` : ""}
              </li>
              <li>{diff.changed?.length ?? 0} with changed expertise</li>
              {(diff.renamed?.length ?? 0) > 0 && (
                <li>
                  {diff.renamed!.length} renamed (recognised as the same person, so their
                  contact details and history are kept):{" "}
                  {diff.renamed!.map((r) => `${r.from} → ${r.to}`).join(", ")}
                </li>
              )}
            </ul>

            {(diff.unmatchedTags?.length ?? 0) > 0 && (
              <p className="warn">
                <strong>Warning —</strong> these tags match no need area, so the people carrying
                them will lose matches they should win:{" "}
                {diff.unmatchedTags!.map((t) => `“${t.tag}” (${t.clinicians.join(", ")})`).join("; ")}
              </p>
            )}
            {(diff.withoutStableKey?.length ?? 0) > 0 && (
              <p className="warn">
                <strong>Note —</strong> {diff.withoutStableKey!.join(", ")} have no LinkedIn
                address, so they are matched on name alone. If their name is later corrected
                they will look like a new person and lose their email, photo and availability.
                Adding a LinkedIn URL to the spreadsheet avoids that.
              </p>
            )}
            {(diff.untagged?.length ?? 0) > 0 && (
              <p className="warn">
                <strong>Warning —</strong> {diff.untagged!.join(", ")} have no expertise at all and
                can never be recommended.
              </p>
            )}

            <div className="button-row">
              <button className="primary-action" onClick={apply}>
                Apply this
              </button>
              <button className="secondary-action" onClick={() => setDiff(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>The bench</h2>
        <p className="role">
          Standing someone down removes them from new recommendations immediately; nothing already
          suggested to a founder is rewritten.
          {inactive > 0 ? ` ${inactive} currently stood down.` : ""}
        </p>

        {adding ? (
          <ClinicianEditor
            options={tagOptions}
            onSave={(fields) => save(null, fields)}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button className="secondary-action" onClick={() => setAdding(true)}>
            Add someone
          </button>
        )}

        <table className="data bench-table">
          <tbody>
            {clinicians.map((c) => (
              // The key belongs on the fragment, not the rows inside it: React
              // matches list children by the key of what map returns, and an
              // unkeyed fragment makes it fall back to index - which
              // mis-associates open editors when someone is added or removed.
              <Fragment key={c.id}>
                <tr className={c.active ? "" : "stood-down"}>
                  <th>
                    {c.name}
                    <span className="role"> {c.company}</span>
                    {c.tags.length === 0 && <span className="warn-inline"> no expertise</span>}
                  </th>
                  <td className="num">
                    <button
                      className="filter"
                      aria-pressed={c.active}
                      onClick={() => void toggle(c.id, !c.active)}
                    >
                      {c.active ? "Available" : "Stood down"}
                    </button>{" "}
                    <button
                      className="filter"
                      onClick={() => setEditing(editing === c.id ? null : c.id)}
                    >
                      {editing === c.id ? "Close" : "Edit"}
                    </button>
                  </td>
                </tr>
                {editing === c.id && (
                  <tr>
                    <td colSpan={2}>
                      <ClinicianEditor
                        clinician={c}
                        options={tagOptions}
                        onSave={(fields) => save(c.id, fields)}
                        onDelete={() => remove(c.id)}
                        onPhoto={(f) => photo(c.id, f)}
                        onCancel={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>

      <Reset password={password} onDone={() => window.location.reload()} />

      <section className="panel">
        <h2>Take the data elsewhere</h2>
        <p className="role">
          The spreadsheet comes back in exactly the format Ignition sent it, so it can be
          re-uploaded unchanged or used wherever else you need it. Contacts and biographies come
          as CSV — the contributors directory is a laid-out document with photography in it, and
          a machine-made replacement would be worse than the one you have.
        </p>
        <div className="button-row">
          <button
            className="secondary-action"
            onClick={() => void download("/api/admin/export/roster.xlsx", "Clinician Expertise.xlsx")}
          >
            Expertise spreadsheet (.xlsx)
          </button>
          <button
            className="secondary-action"
            onClick={() => void download("/api/admin/export/contacts.csv", "clinician-contacts.csv")}
          >
            Contacts and biographies (.csv)
          </button>
        </div>
      </section>
    </>
  );
}

/**
 * Clearing rehearsal data before the programme.
 *
 * The realistic use is not a mistake but a dress rehearsal: the team try the
 * deployed app, then want the numbers they report afterwards to start at zero.
 * Confirmation is by typing the scope word - this deletes with no undo, and a
 * dialog nobody reads is not a confirmation.
 */
function Reset({ password, onDone }: { password: string; onDone: () => void }) {
  const [counts, setCounts] = useState<{
    sessions: number;
    events: number;
    recommendations: number;
    clinicians: number;
  } | null>(null);
  const [scope, setScope] = useState<"founders" | "everything" | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const auth = { authorization: `Bearer ${password}` };

  useEffect(() => {
    fetch("/api/admin/reset", { headers: auth })
      .then((r) => r.json())
      .then(setCounts)
      .catch(() => {});
  }, [password]);

  const run = async () => {
    setError(null);
    const r = await fetch("/api/admin/reset", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ scope, confirm: typed }),
    });
    const data = await r.json();
    if (!r.ok) return setError(data.error ?? "that did not work");
    onDone();
  };

  if (!counts) return null;

  return (
    <section className="panel">
      <h2>Start again</h2>
      <p className="role">
        There are {counts.sessions} founder sessions and {counts.recommendations} recorded
        recommendations, against {counts.clinicians} clinicians. Clearing cannot be undone.
      </p>

      {scope === null ? (
        <div className="button-row">
          <button className="secondary-action danger" onClick={() => setScope("founders")}>
            Clear founder data, keep the bench
          </button>
          <button className="secondary-action danger" onClick={() => setScope("everything")}>
            Clear everything, including the bench
          </button>
        </div>
      ) : (
        <div className="editor">
          <p className="warn">
            {scope === "founders"
              ? `This deletes ${counts.sessions} sessions and ${counts.recommendations} recommendations. The bench is untouched.`
              : `This deletes ${counts.sessions} sessions, ${counts.recommendations} recommendations and all ${counts.clinicians} clinicians. You will need to upload the two documents again.`}
          </p>
          <label className="field">
            <span>Type “{scope}” to confirm</span>
            <input
              className="search"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          {error && <p className="error-note">{error}</p>}
          <div className="button-row">
            <button
              className="secondary-action danger"
              disabled={typed !== scope}
              onClick={run}
            >
              Clear it
            </button>
            <button
              className="secondary-action"
              onClick={() => {
                setScope(null);
                setTyped("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Proportional bar. Deliberately not a chart library - there are eight rows. */
function Bar({ value, max }: { value: number; max: number }) {
  return (
    <div className="bar-track">
      <div className="bar-fill" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
    </div>
  );
}

export default function Admin() {
  const [password, setPassword] = useState(() => sessionStorage.getItem(KEY) ?? "");
  const [draft, setDraft] = useState("");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!password) return;
    fetch("/api/admin/summary", { headers: { authorization: `Bearer ${password}` } })
      .then(async (r) => {
        if (r.status === 401) throw new Error("That password was not accepted.");
        if (!r.ok) throw new Error((await r.json()).error ?? `Server returned ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e: Error) => {
        setError(e.message);
        sessionStorage.removeItem(KEY);
        setPassword("");
      });
  }, [password]);

  if (!password) {
    return (
      <main>
        <div className="eyebrow">Organisers</div>
        <h1>Ignition dashboard</h1>
        <p className="sub">Enter the shared password to see how the cohort is tracking.</p>
        {error && <p className="error-note">{error}</p>}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            sessionStorage.setItem(KEY, draft);
            setPassword(draft);
          }}
        >
          <input
            className="search"
            type="password"
            autoFocus
            placeholder="Password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="composer-actions">
            <button className="primary-action" type="submit">
              Show me
            </button>
          </div>
        </form>
      </main>
    );
  }

  if (!data) {
    return (
      <main>
        <p className="count">Loading…</p>
      </main>
    );
  }

  const maxDemand = Math.max(1, ...data.demand.map((d) => d.founders));
  const maxLoad = Math.max(1, ...data.load.map((l) => l.primaries));
  const thin = data.coverage.filter((c) => c.specialists <= 1);

  return (
    <main>
      <div className="eyebrow">Organisers</div>
      <h1>{data.ready ? `${data.founders} founders so far` : "Finish setting this up"}</h1>
      <p className="sub">
        Live, from the event log. Nothing here identifies an individual founder — sessions are
        anonymous.
      </p>

      {!data.ready && (
        <section className="callout">
          <p>
            <strong>No expert bench loaded yet.</strong> Founders see a holding message until
            there is one. Upload the two documents below — the expertise spreadsheet first,
            since the directory matches its entries against people already on the bench.
          </p>
        </section>
      )}

      {data.ready && data.unreachable.length > 0 && (
        <section className="callout">
          <strong>Nobody covers {data.unreachable.join(" or ")}.</strong> A founder whose
          weakest area is one of those gets nothing back for it. Check the expertise tags.
        </section>
      )}

      {thin.length > 0 && (
        <section className="callout">
          <strong>Thin bench coverage.</strong> {thin.map((c) => c.area).join(" and ")}{" "}
          {thin.length === 1 ? "has" : "have"} one genuine specialist. Counting anyone who matches
          a single tag overstates it — these are the areas where demand will pile onto one person.
        </section>
      )}

      <section className="panel">
        <h2>Where the room is struggling</h2>
        <p className="role">
          How many founders were pointed at each area. This is the cohort heat-map.
        </p>
        {data.demand.length === 0 ? (
          <p className="count">No recommendations yet.</p>
        ) : (
          <table className="data">
            <tbody>
              {data.demand.map((d) => {
                const cov = data.coverage.find((c) => c.areaId === d.area_id);
                return (
                  <tr key={d.area_id}>
                    <th>{d.area}</th>
                    <td className="bar-cell">
                      <Bar value={d.founders} max={maxDemand} />
                    </td>
                    <td className="num">{d.founders}</td>
                    <td className="role">
                      {cov ? `${cov.specialists} specialist${cov.specialists === 1 ? "" : "s"}` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Which door founders used</h2>
        <p className="role">Started, reached a recommendation, and saved or printed it.</p>
        {data.funnel.length === 0 ? (
          <p className="count">Nothing yet.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Pathway</th>
                <th className="num">Started</th>
                <th className="num">Finished</th>
                <th className="num">Saved</th>
              </tr>
            </thead>
            <tbody>
              {data.funnel.map((f) => (
                <tr key={f.pathway}>
                  <th>{f.pathway}</th>
                  <td className="num">{f.started}</td>
                  <td className="num">{f.completed}</td>
                  <td className="num">{f.saved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>What founders made of it</h2>
        {data.feedback.helpful + data.feedback.unhelpful === 0 ? (
          <p className="count">No responses yet.</p>
        ) : (
          <>
            <p className="role">
              <strong>
                {Math.round(
                  (data.feedback.helpful /
                    (data.feedback.helpful + data.feedback.unhelpful)) *
                    100,
                )}
                %
              </strong>{" "}
              said the recommendation looked right ({data.feedback.helpful} of{" "}
              {data.feedback.helpful + data.feedback.unhelpful} who answered).
            </p>
            {data.feedback.comments.length > 0 && (
              <>
                {/* The counts are a headline; these are the part worth reading.
                    At this cohort size a handful of founders explaining what
                    the tool misread beats any amount of thumb-counting. */}
                <p className="role">What the ones who said no told us:</p>
                <ul className="comments">
                  {data.feedback.comments.map((c, i) => (
                    <li key={i}>
                      “{c.comment}”<span className="role"> — {c.pathway}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Demand on each clinician</h2>
        <p className="role">
          Times recommended as first choice. The matcher routes elsewhere once someone reaches{" "}
          {data.capacity}, so anyone at or above that is being actively protected.
        </p>
        {data.load.length === 0 ? (
          <p className="count">Nobody recommended yet.</p>
        ) : (
          <table className="data">
            <tbody>
              {data.load.map((l) => (
                <tr key={l.clinicianId}>
                  <th>
                    {l.name}
                    <span className="role"> {l.company}</span>
                  </th>
                  <td className="bar-cell">
                    <Bar value={l.primaries} max={maxLoad} />
                  </td>
                  <td className="num">
                    {l.primaries}
                    {l.primaries >= data.capacity ? " ⚠" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Bench password={password} />

      <div className="submit-bar">
        <span className="count">
          The full event log is available as CSV — analyse it however you like.
        </span>
        <a
          className="primary-action"
          href={`/api/admin/export.csv`}
          onClick={(e) => {
            // The download needs the same bearer token the fetches use, which a
            // plain link cannot send. Fetch it, then hand the browser a blob.
            e.preventDefault();
            void fetch("/api/admin/export.csv", {
              headers: { authorization: `Bearer ${password}` },
            })
              .then((r) => r.blob())
              .then((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "expert-finder-events.csv";
                a.click();
                URL.revokeObjectURL(url);
              });
          }}
        >
          Download CSV
        </a>
      </div>
    </main>
  );
}
