import { useState } from "react";

import type { Clinician } from "../../../shared/types.ts";

export interface TagOption {
  tag: string;
  used: number;
  /** False when the tag matches no need area, so carrying it wins no matches. */
  reachesArea: boolean;
}

/**
 * Tag entry with autocomplete.
 *
 * This is the reason the editor exists. Matching is exact-string, and the 2026
 * spreadsheet arrived carrying "Artificial Intellifgence", "Inovation" and
 * "Trade Marks" — each one silently costing that clinician every match they
 * should have won. Offering the existing spelling stops the next one being
 * created, and anything genuinely new is flagged before it is accepted.
 */
function TagField({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: TagOption[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const query = draft.trim().toLowerCase();

  const suggestions = query
    ? options
        .filter((o) => o.tag.toLowerCase().includes(query) && !value.includes(o.tag))
        .slice(0, 6)
    : [];
  const exact = options.find((o) => o.tag.toLowerCase() === query);

  const add = (tag: string) => {
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  };

  return (
    <div className="tag-field">
      <div className="tags">
        {value.map((t) => {
          const known = options.find((o) => o.tag === t);
          return (
            <span key={t} className="tag" data-unknown={known?.reachesArea ? "false" : "true"}>
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                onClick={() => onChange(value.filter((x) => x !== t))}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>

      <input
        className="search"
        placeholder="Add expertise — start typing"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(suggestions[0]?.tag ?? draft.trim());
          }
        }}
      />

      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((o) => (
            <button key={o.tag} type="button" className="filter" onClick={() => add(o.tag)}>
              {o.tag} <span className="role">{o.used}</span>
            </button>
          ))}
        </div>
      )}

      {query && !exact && (
        <p className="warn">
          “{draft.trim()}” is not an existing tag. Adding it is fine, but check the spelling —
          matching is exact, so a typo means this person never matches on it.{" "}
          <button type="button" className="filter" onClick={() => add(draft.trim())}>
            Add anyway
          </button>
        </p>
      )}
    </div>
  );
}

const BLANK: Partial<Clinician> = { name: "", company: "", title: "", tags: [] };

export default function ClinicianEditor({
  clinician,
  options,
  onSave,
  onDelete,
  onPhoto,
  onCancel,
}: {
  /** Undefined when adding someone who is in neither document yet. */
  clinician?: Clinician;
  options: TagOption[];
  onSave: (fields: Partial<Clinician>) => Promise<void>;
  onDelete?: () => Promise<void>;
  onPhoto?: (file: File) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Partial<Clinician>>({ ...BLANK, ...clinician });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (field: keyof Clinician, v: unknown) => setDraft((d) => ({ ...d, [field]: v }));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, key: keyof Clinician, placeholder = "") => (
    <label className="field">
      <span>{label}</span>
      <input
        className="search"
        value={(draft[key] as string) ?? ""}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );

  return (
    <div className="editor">
      {error && <p className="error-note">{error}</p>}

      <div className="field-grid">
        {field("Name", "name")}
        {field("Company", "company")}
        {field("Title", "title")}
        {field("Email", "email", "name@example.com")}
        {field("LinkedIn", "linkedin", "https://www.linkedin.com/in/…")}
      </div>

      {!draft.linkedin?.trim() && (
        <p className="warn">
          Without a LinkedIn address this person is matched by name, so a later spelling
          correction would read as them leaving and someone new arriving.
        </p>
      )}

      <label className="field">
        <span>Expertise</span>
        <TagField
          value={draft.tags ?? []}
          options={options}
          onChange={(tags) => set("tags", tags)}
        />
      </label>

      {(draft.tags?.length ?? 0) === 0 && (
        <p className="warn">
          With no expertise, no pathway can ever recommend this person.
        </p>
      )}

      <label className="field">
        <span>Biography</span>
        <textarea
          className="search"
          rows={4}
          value={draft.bio ?? ""}
          onChange={(e) => set("bio", e.target.value)}
        />
      </label>

      <div className="submit-bar">
        <div className="button-row">
          {onPhoto && (
            <label className="secondary-action file-button">
              Replace photo
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void run(() => onPhoto(f));
                  e.target.value = "";
                }}
              />
            </label>
          )}
          {onDelete && (
            <button
              className="secondary-action danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (
                    !confirm(
                      `Remove ${draft.name} from the bench entirely? If they have already been recommended to a founder this will be refused — stand them down instead.`,
                    )
                  )
                    return;
                  await onDelete();
                })
              }
            >
              Delete
            </button>
          )}
        </div>
        <div className="button-row">
          <button className="secondary-action" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-action"
            disabled={busy || !draft.name?.trim()}
            onClick={() => run(() => onSave(draft))}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
