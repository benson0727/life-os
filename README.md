# BENSON LIFE OS — Hyperbolic Life Map

**v1.0.0** · Static web app · No build step · No backend · No runtime dependencies

A personal **Life Digital Twin**: one interactive map of work, future, finance, family, mindset,
learning, research, health, network, growth, life management and inner development — with
**SELF** at the root.

The map is a **hyperbolic tree on a Poincaré disk** (focus + context). Click any node and it slides to
the center; everything else stays visible toward the edge, so you never lose the whole picture.

| Element | Meaning |
|---|---|
| Hierarchy | Structure |
| Focus | Attention |
| Dashed links | Relationships across branches |
| Timeline | Direction (a plan, not a prediction) |
| Status | Reality |
| Progress | Movement |
| Notes / prompts | Reflection |

---

## Features (v1.0)

- **Hyperbolic map** — click to focus (animated along the hyperbolic geodesic), drag to pan, wheel / pinch to zoom
- **Details panel** — description, why it matters, status, priority, progress, target, next action, importance / attention, notes, related nodes
- **Reflection prompts** on Mindset, Growth and Inner nodes
- **Cross-links** — shown for the selected node, on hover, or all (Settings)
- **Search** (`/`), **breadcrumb**, **Home** (`H`), **Back / Forward** (`Alt` + `←` / `→`)
- **Filters** by category, status, priority (non-matching nodes are dimmed, not removed)
- **Focus mode** (`F`) — dims everything outside the selected node's neighborhood
- **Views** — Timeline, Life Balance (importance vs attention), Decision Mode (trade-off matrix, no automatic answer)
- **Private Mode** (`P`) — private branch, private nodes, private notes and metrics; off by default on every page load
- **Dark / Light theme**, labels, progress rings — saved in `localStorage`
- Keyboard accessible: `Tab` moves through the focused node's neighborhood, `Enter` focuses, `Shift` + `Enter` opens details

---

## Project structure

```
/
├─ index.html                     App shell
├─ styles.css                     Theme + layout
├─ app.js                         All logic (plain JavaScript + SVG)
├─ README.md
├─ .gitignore                     Excludes data/private-data.json
├─ assets/
│  └─ favicon.svg
└─ data/
   ├─ public-data.json            Life architecture — safe to publish
   ├─ private-data.example.json   Template with fake values
   └─ private-data.json           YOUR real data — local only, git-ignored (you create it)
```

---

## Run locally

Browsers block `fetch()` for pages opened directly from disk (`file://`). Use a local server:

```bash
cd benson-life-os
python -m http.server 8000
```

Open <http://localhost:8000>.

If you do double-click `index.html`, the app shows a file picker: choose `data/public-data.json` and it works for that session.

---

## Edit the life map — `data/public-data.json`

### Node fields

```json
{
  "id": "digital-twin",
  "name": "Digital Twin",
  "parent": "research",
  "category": "research",
  "description": "What it is.",
  "why": "Why it matters.",
  "status": "active",
  "priority": "P1",
  "progress": 65,
  "importance": 5,
  "attention": 4,
  "target": "2027",
  "tags": ["data-center", "software"],
  "related": ["thesis", "journal", "overseas-career"],
  "nextAction": "Continue validation and strengthen software architecture.",
  "notes": "Free text.",
  "prompts": ["Optional node-specific reflection question?"],
  "private": false
}
```

Only `id`, `name` and `parent` are required. Everything else is optional.

| Field | Values |
|---|---|
| `status` | `idea` `exploring` `planning` `active` `waiting` `completed` `paused` `dropped` |
| `priority` | `P1` Critical · `P2` High · `P3` Medium · `P4` Low |
| `progress` | 0–100 |
| `importance`, `attention` | 1–5 (personal indicator, not a measurement). Used by Life Balance on first-level nodes |
| `private` | `true` = shown only in Private Mode |

### Add a node

1. Add an object to `nodes` with a unique `id`.
2. Set `parent` to an existing `id`.
3. Set `category` to one of the ids in `settings.categories` (same as its branch).
4. Reload the page.

A node whose parent is missing is attached to SELF and a warning is printed to the console.

### Add a related link

Add the other node's id to `related` on **either** node. Links are two-way automatically.

```json
"related": ["thesis", "patent"]
```

### Other sections

- `settings.categories` — branch colors and names
- `settings.reflectionPrompts` — default questions per category
- `settings.balanceCategories` — which branches appear in Life Balance
- `timeline` — periods and items (`node` links an item to the map)
- `decision` — options, criteria, starter scores. Edits made in the Decision view are stored in your browser only

---

## Private data — `data/private-data.json`

**Rule: `public-data.json` holds the structure. `private-data.json` holds anything personal.**

Never put these in `public-data.json`: account numbers, exact loan balances, salary figures, address,
phone numbers, ID numbers, medical information, family names / birthdays / schools, named customers,
confidential company or customer project information, job-search intentions you would not show your employer.

### Create it

```bash
cp data/private-data.example.json data/private-data.json
```

Edit the copy. It is listed in `.gitignore` and is never committed.

### Format

```json
{
  "overrides": {
    "debt-reduction": {
      "progress": 30,
      "privateNotes": "Only visible in Private Mode.",
      "metrics": [
        { "label": "Total debt", "value": "NT$ …", "progress": 30 }
      ]
    }
  },
  "nodes": [
    { "id": "acct-a", "name": "Account A", "parent": "key-accounts", "category": "career" }
  ],
  "timeline": [
    { "period": "2027", "items": [ { "title": "Private milestone", "node": "y2027" } ] }
  ],
  "decision": {
    "scores": { "current": { "compensation": 3 } },
    "notes": { "compensation": "Target package and current gap." }
  }
}
```

- `overrides` — fields merged into existing public nodes (any field, plus `privateNotes` and `metrics`)
- `nodes` — extra nodes, always treated as private
- `timeline` — extra timeline items, merged by `period`
- `decision` — private scores and per-criterion notes

### Load it

Private data is **never loaded automatically on page load**. Two options:

1. **Settings › Load private-data.json…** — works anywhere, including the live GitHub Pages site.
   The file is read into memory only. Nothing is uploaded. Reloading the page forgets it.
2. **Auto-load on localhost (opt-in)** — in `public-data.json` set
   `"settings": { "privateData": { "autoLoad": true } }`. Then, when running on `localhost`,
   turning on Private Mode fetches `data/private-data.json` once.
   Leave it `false` if the file does not exist, to avoid a 404 in the console.

Private Mode always starts **off** after a reload, so the page is safe to screen-share by default.

---

## Deploy to GitHub Pages

> **Important:** on GitHub Free, Pages only works from a **public** repository.
> Anything in `public-data.json` is then public. Keep it neutral. Private repos with Pages need a paid plan.

### First deployment

1. Create a new repository on GitHub, e.g. `life-os` (no README, no .gitignore — the project has them).
2. In the project folder:

   ```bash
   git init
   git add .
   git status                      # check: data/private-data.json must NOT be listed
   git commit -m "BENSON LIFE OS v1.0"
   git branch -M main
   git remote add origin https://github.com/<your-user>/life-os.git
   git push -u origin main
   ```

3. On GitHub: **Settings › Pages › Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **main** · Folder: **/ (root)** → **Save**
4. Wait 1–2 minutes. The site is at `https://<your-user>.github.io/life-os/`.

All paths in the project are relative, so it works under the `/life-os/` sub-path without changes.

### Update later

```bash
git add .
git status          # confirm no private file is staged
git commit -m "Update life map"
git push
```

Pages redeploys automatically. Hard-refresh the browser (`Ctrl` + `Shift` + `R`) if you still see the old version.

### If private data was committed by mistake

Removing the file in a new commit is **not enough** — it stays in git history. Rewrite history
(e.g. `git filter-repo --path data/private-data.json --invert-paths`), force-push, and treat
the data as exposed.

---

## How the hyperbolic map works

1. **Layout** — node depth *d* is placed at hyperbolic radius *d* × 1.15; each subtree gets an angular
   wedge proportional to its size (compressed by a power of 0.7). The hyperbolic radius ρ maps to the
   Poincaré disk radius `tanh(ρ / 2)`.
2. **Focus** — the view applies the Möbius translation `T_c(z) = (z − c) / (1 − c̄ z)`, which moves
   point *c* to the center while preserving the hyperbolic geometry.
3. **Animation** — on click, *c* moves along the hyperbolic geodesic toward the target node at
   uniform hyperbolic speed (eased).
4. **Edges** — drawn as geodesics (arcs orthogonal to the disk boundary).
5. **Labels** — placed greedily by importance; overlapping labels are hidden.

Written from scratch in plain JavaScript and SVG, inspired by the hyperbolic tree / Poincaré disk interaction style.

---

## Browser support

Current Chrome, Edge, Safari and Firefox (desktop and mobile). Fonts load from Google Fonts with system-font fallback.

## License

Personal project. Add a license file before inviting reuse.
