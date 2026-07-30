import { useEffect, useState } from "react";

import type { Area, AreaScore, Clinician, Pathway, Recommendation, Stage } from "../../shared/types.ts";
import { getBench, getRecommendation, startSession, track } from "./api.ts";
import Chat from "./pages/Chat.tsx";
import Directory from "./pages/Directory.tsx";
import Guided from "./pages/Guided.tsx";
import Landing from "./pages/Landing.tsx";
import Result from "./pages/Result.tsx";
import Score from "./pages/Score.tsx";

type View = "landing" | Pathway;

export default function App() {
  const [view, setView] = useState<View>("landing");
  const [bench, setBench] = useState<{
    ready: boolean;
    areas: Area[];
    clinicians: Clinician[];
    stages: Stage[];
    disclaimer: string;
    chatAvailable: boolean;
  } | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A session id is minted before anything is tracked, so every event in a
    // founder's journey shares one id - including the pathway they abandoned.
    startSession()
      .then(getBench)
      .then(setBench)
      .catch((e: Error) => setError(e.message));
  }, []);

  const choose = (p: Pathway) => {
    track("pathway_chosen", p);
    setRecommendation(null);
    setView(p);
  };

  const goBack = () => {
    if (view !== "landing" && !recommendation) track("pathway_abandoned", view);
    setRecommendation(null);
    setView("landing");
  };

  const scored = async (pathway: Pathway, scores: AreaScore[]) => {
    setBusy(true);
    setError(null);
    try {
      setRecommendation(await getRecommendation(pathway, scores));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <main>
        <p className="empty">{error}</p>
      </main>
    );
  }

  if (!bench) {
    return (
      <main>
        <p className="count">Loading the expert bench…</p>
      </main>
    );
  }

  // A deployment starts with no bench and the organisers upload it. Say so
  // plainly rather than showing four doors that all lead nowhere.
  if (!bench.ready) {
    return (
      <main>
        <div className="eyebrow">Curtin Ignition</div>
        <h1>Almost ready</h1>
        <p className="sub">
          The expert bench has not been loaded yet. Check back shortly — and if you are one of
          the organisers, the two source documents are uploaded at <code>/admin</code>.
        </p>
      </main>
    );
  }

  return (
    <main>
      {view !== "landing" && (
        <button className="back" onClick={goBack}>
          ← Choose a different starting point
        </button>
      )}

      {view === "landing" && <Landing onChoose={choose} />}

      {view === "directory" && <Directory areas={bench.areas} clinicians={bench.clinicians} />}

      {(view === "score" || view === "guided") &&
        (busy ? (
          <p className="count">Matching you to the bench…</p>
        ) : recommendation ? (
          <Result
            recommendation={recommendation}
            onRestart={() => {
              track("restarted", view);
              setRecommendation(null);
            }}
            onSwitch={goBack}
          />
        ) : view === "score" ? (
          <Score areas={bench.areas} onDone={(s) => scored("score", s)} />
        ) : (
          <Guided
            areas={bench.areas}
            stages={bench.stages}
            onDone={(s) => scored("guided", s)}
          />
        ))}

      {view === "chat" &&
        (recommendation ? (
          <Result
            recommendation={recommendation}
            onRestart={() => {
              track("restarted", "chat");
              setRecommendation(null);
            }}
            onSwitch={goBack}
          />
        ) : bench.chatAvailable ? (
          <Chat disclaimer={bench.disclaimer} onRecommendation={setRecommendation} />
        ) : (
          <>
            <div className="eyebrow">Unavailable</div>
            <h1>The assistant is offline</h1>
            <p className="sub">
              This pathway needs the language model, which is not configured on this server. The
              other three pathways work without it.
            </p>
          </>
        ))}
    </main>
  );
}
