# Expert Finder — Curtin Ignition

Helps founders on the Ignition programme work out where their venture needs
support, then points them at the clinicians best placed to help. The output is a
recommendation the founder takes to the paper booking sheet; this tool does not
do booking.

> **No personal data lives here.** The bench — names, emails, biographies,
> photographs — is uploaded by an organiser at `/admin` after deployment and
> never committed. `data/clinicians.sample.json` is invented, so the app runs
> for anyone who clones it.

## The four pathways

| Pathway | For a founder who… | Status |
|---|---|---|
| **Chat** | doesn't know where their gaps are; can upload a deck or plan | working |
| **Guided** | wants a couple of quick questions | working |
| **Score** | wants to rate themselves across all eight areas | working |
| **Directory** | already knows what they need | working |

Uploads accept **PDF, PowerPoint, Word and plain text** — pitch decks, business
plans, one-pagers. Spreadsheets are refused with a suggestion: a financial model
is numbers without narrative and cannot say whether the customer is real or
whether anything is protected.

**Decks exported as slide images** have no text layer. Rather than silently
analysing nothing, the founder is told what happened and offered a choice: read
the slides as images (a vision call per page, capped at
`MAX_RENDERED_PAGES` — about 4.5s each), or skip it and describe the venture
instead, which is usually quicker and often more informative. Saying yes
re-sends the file from the browser; nothing is held on the server between the
two calls.

The first three all produce the same thing — a 0–5 confidence per need area —
and share one matching engine, so two founders in the same position cannot be
told different things depending on which door they used.

Every recommendation carries **three questions to ask that expert**, generated
after the shortlist is already on screen so it never delays it. A clinic slot is
short, and founders who do not know what they do not know spend the first half
of it working out what to ask. Where a pathway captured the founder's own words,
the questions build on them. They print with the shortlist.

## Running it locally

```sh
npm install
npm run sample       # invented bench, so there is something to match against
npm run dev          # API on :3210, UI on :5173 with hot reload
npm test             # matching, parsing and event-log tests
```

Without `npm run sample` the app starts with an empty bench and shows the
first-run message, which is what a real deployment does.

The API deliberately avoids port 3000 - it is the default for much of the Node
ecosystem and collides with any other dev server on the same machine. If 3210 is
also taken, set `PORT` in `.env`; the Vite proxy reads the same variable, so
both halves move together.

## Deploying

The image is built and published by GitHub Actions on every push to `main`, so
the server needs three files and no checkout. Both the repository and the
package are private, so fetching them takes the same token as the registry
login — a classic PAT with `repo` and `read:packages`:

```sh
export GH_TOKEN=ghp_...
REPO=michael-borck/curtin-ignition-expert-finder

mkdir -p ~/expert-finder && cd ~/expert-finder
for f in docker-compose.yml Caddyfile .env.example; do
  curl -fsSL -H "Authorization: token $GH_TOKEN" \
       -H "Accept: application/vnd.github.raw" \
       "https://api.github.com/repos/$REPO/contents/$f" -o "$f"
done

cp .env.example .env && $EDITOR .env      # DOMAIN, ADMIN_PASSWORD, OLLAMA_*

echo "$GH_TOKEN" | docker login ghcr.io -u michael-borck --password-stdin
docker compose pull && docker compose up -d
```

Updating later is `docker compose pull && docker compose up -d`; re-fetch the
three files only if they change.

Point `DOMAIN`'s DNS at the host *before* first start, or Caddy cannot obtain a
certificate.

**The image contains no clinician data.** A fresh deployment starts with an
empty bench and shows founders a holding message; an organiser then uploads the
two source documents at `/admin` — the expertise spreadsheet first, then the
contributors directory, which matches its entries against people already on the
bench. This is deliberate: emails, biographies and photographs of 35 real people
have no business travelling into a container registry and its layer caches. CI
fails the build if any ever appear in the image.

To build the image yourself instead: `docker build -t expert-finder .` from a
checkout. The compose file deliberately has no `build:` stanza, so that a
failed pull fails clearly rather than falling back to building from a context
that is not there.

Everything that must survive a redeploy lives in the `event-log` named volume:
the event log, an uploaded bench, and uploaded headshots. Back it up by copying
its contents out. `docker compose down` leaves it alone; `down -v` destroys it.

### Where things are

| URL | Who | Notes |
|---|---|---|
| `/` | founders | the four pathways |
| `/admin` | organisers | `ADMIN_PASSWORD` from `.env` |

`/admin` is deliberately unlinked from the founder-facing app — organisers reach
it by typing the address. It is not a login, just a shared password, which is
proportionate for a week-long internal tool but does mean the URL and password
should be shared directly rather than posted anywhere public.

## Organiser tools

`/admin`, behind the shared `ADMIN_PASSWORD`:

- **Cohort heat-map** — how many founders were steered to each area, set
  against how many genuine specialists cover it
- **Funnel** — started, finished and saved, per pathway
- **Clinician demand**, with anyone at the capacity ceiling flagged
- **Update the bench** — upload either source document, see a diff, then apply
- **Edit any clinician directly** — including expertise, with autocomplete over
  the tags already in use. Matching is exact-string, so this is the mechanism
  that stops the next `Intellifgence` being created
- **Add someone** who is in neither document yet
- **Delete**, but only if they have never been recommended; after that,
  standing down is offered instead, because deleting orphans that history
- **Availability toggles** — for "Roy just cancelled" on the day
- **Export** the expertise spreadsheet in the format Ignition sent it (it
  re-uploads unchanged), and contacts plus biographies as CSV
- **What founders made of it** — one headline percentage, and the comments
  from those who said no
- **CSV export** of the whole event log
- **Start again** — clear rehearsal traffic before the programme, keeping the
  bench, or clear everything back to a fresh install. Confirmed by typing the
  scope word, since neither can be undone

## Updating the bench

Ignition maintain two documents, and `/admin` accepts either — it works out
which is which from the file:

| Document | Carries | Decides |
|---|---|---|
| `Clinician Expertise .xlsx` | name, company, title, expertise tags, LinkedIn | **who gets recommended** |
| `5.Clinicians ... Directory 2026.docx` | email, biography, headshot | **what the founder sees and how they make contact** |

Neither is sufficient alone, which is why both upload paths exist. Uploading
one leaves the other's fields untouched.

Names disagree between the two files — titles, post-nominals, `Nicholas`
against `Nick`, and a misspelling of Del Rossi. Matching is lenient enough
to reconcile all 35 (exact matching finds 30), and stops short of pairing two
genuinely different people.

Or regenerate locally:

```sh
npm run bench        # scripts/build_clinicians.py
```

The `/admin` route parses the spreadsheet in Node rather than shelling out to
the Python script, because the Docker image has no Python. It keeps email,
biography and headshot for anyone already on the bench — the spreadsheet does
not carry them — and preserves anyone stood down, so a re-upload cannot
silently un-cancel someone.

Set `BENCH_PATH` to a location on the mounted volume in production. The copy
baked into the image is read-only across redeploys, so an uploaded bench would
otherwise vanish on the next rebuild.

It rebuilds `data/clinicians.json` and the headshots, and **exits non-zero if
any expertise tag matches no need area** — that would silently cost a clinician
matches they should win, which is exactly the failure you want to hear about
before the programme rather than after.

Clinicians have a stable `id` and an `active` flag. To take someone off the
bench, set `active: false` rather than deleting the row: recommendations already
logged reference them, and deleting orphans that history.

## How matching works

1. The founder's scores are ranked; the three weakest areas are recommended.
2. Candidates for each area are grouped into bands by how many of that area's
   tags they cover.
3. Within the best available band, the least-recommended clinician wins.
4. If everyone in a band has hit `CLINIC_CAPACITY`, matching drops to the next
   band — fit is preserved right up to the point where the recommendation would
   be unbookable.

Selection is seeded from the session id, so re-running the same pathway gives
the same people. A founder who hits "try again" and sees different experts for
identical answers learns the tool is arbitrary.

Without the capacity rule, a 60-founder cohort sent all 60 pitch
recommendations to one clinician, because balancing only broke exact ties and
exact ties are rare in real data.

## Inference

A remote Ollama endpoint running `gemma4:12b`, which is multimodal and handles
both extracted text and rendered slide images — pitch decks are usually
exported slides with no text layer. Do not add a second model: the endpoint
preloads this one into VRAM and switching would evict it.

Thinking is set per call, not globally:

| Call | Thinking | Why |
|---|---|---|
| Chat turns | **off** | 3.0s instead of 17.4s; nothing depends on reproducibility |
| Final extraction | **on** | With it off, the weakest-three areas stopped agreeing across identical runs — and that ranking chooses the experts |

Verify the endpoint before relying on it:

```sh
npm run probe        # checks schema-valid JSON and slide reading
```

Uploaded documents are read and discarded, never written to disk. The disclaimer
shown to founders says so, including the brief hold during processing.

## Layout

```
shared/types.ts     shapes the API and browser agree on
server/match.ts     the matching engine (pure, tested)
server/bench.ts     loads clinicians + areas, reports coverage
server/db.ts        append-only event log
server/index.ts     API and static host
web/                React frontend
scripts/            bench build, endpoint probe, cohort simulation
data/               generated bench + hand-maintained areas.json
```
