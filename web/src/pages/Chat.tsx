import { useEffect, useRef, useState } from "react";

import type { Recommendation } from "../../../shared/types.ts";
import { analyseConversation, streamChat, track, uploadDocument } from "../api.ts";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

const OPENER: Turn = {
  role: "assistant",
  content:
    "Tell me about your venture — what you are building and who it is for. " +
    "Or upload your pitch deck or business plan and I will read it first.",
};

/** Enough of a conversation to say something useful about. Below this the
 *  analysis is guessing, so the button stays out of reach. */
const MIN_ANSWERS = 2;

export default function Chat({
  onRecommendation,
  disclaimer,
}: {
  onRecommendation: (r: Recommendation) => void;
  disclaimer: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([OPENER]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<{ name: string; text: string; note: string } | null>(null);
  // Set when a PDF turns out to be slide images. Holds the file so the founder
  // can say yes and we can send the same bytes again - nothing is kept server
  // side between the two calls.
  const [offer, setOffer] = useState<{ file: File; pages: number } | null>(null);
  const [reading, setReading] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, streaming, analysing]);

  const answers = turns.filter((t) => t.role === "user").length;
  const ready = answers >= MIN_ANSWERS || (doc !== null && answers >= 1);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const next = [...turns, { role: "user" as const, content: text }];
    setTurns(next);
    setDraft("");
    setBusy(true);
    setError(null);
    setStreaming("");

    try {
      let acc = "";
      await streamChat(next, doc?.text, (chunk) => {
        acc += chunk;
        setStreaming(acc);
      });
      setTurns([...next, { role: "assistant", content: acc }]);
    } catch (e) {
      setError((e as Error).message);
      setTurns(next);
    } finally {
      setStreaming("");
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setOffer(null);
    try {
      const r = await uploadDocument(file);
      if (r.usable) {
        setDoc({
          name: file.name,
          text: r.text,
          note: `Read ${r.pages ? `${r.pages} page${r.pages === 1 ? "" : "s"}` : "the file"}.`,
        });
      } else if (r.renderable) {
        // Readable, but it costs a vision call per page. Ask rather than
        // making them wait without knowing why.
        setOffer({ file, pages: r.renderablePages ?? 0 });
      } else {
        setDoc({
          name: file.name,
          text: "",
          note:
            "I could not get much text out of that — it may be a scan. Tell me about it instead and I will work from that.",
        });
      }
      track("document_uploaded", "chat", { kind: r.kind, usable: r.usable, renderable: r.renderable });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const readSlides = async () => {
    if (!offer) return;
    setReading(true);
    setError(null);
    try {
      const r = await uploadDocument(offer.file, true);
      setDoc({
        name: offer.file.name,
        text: r.text,
        note: `Read ${r.pages} slide${r.pages === 1 ? "" : "s"} as images.`,
      });
      setOffer(null);
      track("document_uploaded", "chat", { kind: "pdf", rendered: r.pages });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const finish = async () => {
    setAnalysing(true);
    setError(null);
    try {
      onRecommendation(await analyseConversation(turns, doc?.text));
    } catch (e) {
      setError((e as Error).message);
      setAnalysing(false);
    }
  };

  if (analysing) {
    // The honest version of a progress bar. This call runs with thinking on and
    // takes the better part of a minute; a bare spinner reads as broken, and a
    // fake percentage reads as a lie.
    return (
      <>
        <div className="eyebrow">Working it out</div>
        <h1>Reading what you have told me</h1>
        <p className="sub">
          This takes about a minute. It is running on Curtin's own hardware rather than an
          outside service, which is slower but means nothing you shared leaves the university.
        </p>
        <p className="count">Matching you against all 35 experts…</p>
      </>
    );
  }

  return (
    <>
      <div className="eyebrow">Talk it through</div>
      <h1>Tell me where you are up to</h1>
      <p className="sub">
        A few questions, then I will point you at the people who can help most. There are no
        wrong answers, and "I don't know" is a genuinely useful one.
      </p>

      <div className="chat">
        {turns.map((t, i) => (
          <div key={i} className={`bubble bubble-${t.role}`}>
            {t.content}
          </div>
        ))}
        {streaming && <div className="bubble bubble-assistant">{streaming}</div>}
        {busy && !streaming && <div className="bubble bubble-assistant typing">…</div>}
        <div ref={endRef} />
      </div>

      {doc && (
        <p className="doc-note">
          <strong>{doc.name}</strong> — {doc.note}
        </p>
      )}

      {offer && (
        <div className="callout">
          <p>
            <strong>{offer.file.name}</strong> looks like a deck of images rather than text —
            that is completely normal for an exported slide deck.
          </p>
          <p className="role">
            I can read the slides themselves, which takes around{" "}
            {Math.max(10, Math.round(offer.pages * 4.5))} seconds for the first {offer.pages}{" "}
            slide{offer.pages === 1 ? "" : "s"}. Or skip it and just tell me about the venture —
            that is usually quicker and often tells me more.
          </p>
          <div className="button-row">
            <button className="primary-action" disabled={reading} onClick={readSlides}>
              {reading ? `Reading ${offer.pages} slides…` : "Read the slides"}
            </button>
            <button
              className="secondary-action"
              disabled={reading}
              onClick={() => {
                track("document_uploaded", "chat", { declinedRender: true });
                setOffer(null);
              }}
            >
              Skip — I will describe it
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-note">{error}</p>}

      <div className="composer">
        <textarea
          className="search"
          rows={2}
          placeholder="Type your answer…"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          <label className="secondary-action file-button">
            {doc ? "Replace document" : "Upload deck or plan"}
            <input
              type="file"
              accept=".pdf,.pptx,.docx,.txt,.md"
              hidden
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
          <button className="primary-action" disabled={busy || !draft.trim()} onClick={send}>
            Send
          </button>
        </div>
      </div>

      <p className="disclaimer">{disclaimer}</p>

      <div className="submit-bar">
        <span className="count">
          {ready
            ? "Ready when you are"
            : `Tell me a bit more first — ${MIN_ANSWERS - answers} more answer${
                MIN_ANSWERS - answers === 1 ? "" : "s"
              }`}
        </span>
        <button className="primary-action" disabled={!ready || busy} onClick={finish}>
          That's enough — show me who can help
        </button>
      </div>
    </>
  );
}
