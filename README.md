# BAUET Faculty Evaluation Automator

A Chrome Extension (Manifest V3) that automates the BAUET IEMS *Faculty
Performance Evaluation* workflow at `iems.bauet.ac.bd`.

> **UI design:** the popup is built against a Wise-inspired design system —
> Wise Green (`#9fe870`) primary CTA with Dark Green (`#163300`) text on a
> warm off-white canvas, weight-900 display headings at 0.85 line-height,
> weight-600 body, pill buttons with `scale(1.05)` hover / `scale(0.95)`
> active, ring shadows only.

It walks the `FacultyList` page, opens each pending teacher's evaluation
form, fills every radio question with your chosen rating, writes a
mandatory comment, submits, and continues to the next pending teacher
until none remain.

## Features

- **Five-point rating selector** — Outstanding / Very Good / Good / Poor / Very Poor.
- **Mandatory comment** — required for every submission (default: `comment`).
- **Live status display** — `Evaluating 3 of 17 — Tanvir Anjom Siddique...`
- **Skips already-submitted evaluations** automatically.
- **Resumes across page navigations** — state is stored in
  `chrome.storage.local`, so the run survives every `FacultyList ↔ Submit`
  round-trip.
- **MutationObserver-based readiness checks** — never tries to fill a
  form that hasn't rendered yet.
- **Randomized 800–1200 ms delays** between actions to mimic human pacing.
- **Vanilla JS only** — no jQuery, no third-party runtime dependencies.

## Project structure

```
bauet-evaluator/
├── manifest.json     # MV3 manifest, permissions, content-script matches
├── popup.html        # Settings UI
├── popup.js          # Popup logic — saves settings, starts/stops the run
├── styles.css        # Popup styling
├── content.js        # Page driver — runs on FacultyList & Submit pages
├── background.js     # Service worker — bootstraps defaults, stops run on navigation away
└── README.md
```

## Installation (load unpacked)

1. Clone or download this repository.
   ```bash
   git clone https://github.com/<your-user>/bauet-evaluator.git
   ```
2. Open Chrome (or any Chromium browser) and visit `chrome://extensions`.
3. Toggle **Developer mode** on (top-right corner).
4. Click **Load unpacked** and select the `bauet-evaluator/` folder.
5. The extension icon should now appear in your toolbar. Pin it for easy access.

> ⚠️ The manifest references `icon.png` for the toolbar icon. Drop any
> 128×128 PNG named `icon.png` into the extension folder, or remove the
> `default_icon` block from `manifest.json` if you don't want one.

## Usage

1. Log into [iems.bauet.ac.bd](https://iems.bauet.ac.bd) and navigate to
   **Faculty Evaluation → FacultyList** (URL ends in
   `/Student/FacultyEvaluation/FacultyList`).
2. Click the extension icon in the toolbar — it opens the **Chrome Side
   Panel** (a vertical pane on the right of the browser window) and
   stays open while you work, instead of a popup that closes the
   moment you click somewhere else.
3. Choose a **rating** for every question (default: *Random*).
   Six options are available:
   - *Outstanding*, *Very Good*, *Good*, *Poor*, *Very Poor* — applied
     uniformly to every question.
   - *Random — Very Good / Good / Poor* — picks a fresh value from those
     three for **every individual question**, so no two questions are
     guaranteed to have the same rating. Useful when you want a more
     human-looking pattern of responses.
4. Type a single **comment** that will be used for every evaluation.
   The comment is mandatory and cannot be empty.
5. Click **Start Automation**.
6. Watch the live status — the side panel updates after every action.
   Because it's a side panel, **it stays open the whole time** so you
   can see real-time progress, the 3-second submit countdown, and the
   teacher name being processed. Click **Stop** at any point to halt
   the run.

When all pending teachers are evaluated, the status will show
`Done. Completed N of N evaluation(s).`

## How it works

| Page | What `content.js` does |
| --- | --- |
| `/FacultyEvaluation/FacultyList` | Scans the table, lists every row that still has an enabled **Start** button (skipping rows whose status is `Submitted`/`Completed`/`Done`), and clicks the first one. |
| `/FacultyEvaluation/Submit` | Waits for the form to fully render (radios + textarea + submit button), groups radio inputs by `name`, picks the radio whose label matches the chosen rating, fills the textarea, and clicks **Submit**. |

After each submit, the site navigates back to `FacultyList`. The content
script re-bootstraps automatically on every page load — if
`runState.running` is `true`, it picks up where it left off without any
help from the popup.

### Rating-label matching

Radio inputs are grouped by their HTML `name` attribute (one group =
one question). For each group the script looks for a radio whose
`<label>` text contains the chosen rating phrase ("Outstanding",
"Very Good", etc.). If that exact match isn't found it falls back
through the rest of the rating list, and as a last resort uses the
radio at the corresponding 5-point index — so no question is ever
left blank.

### State machine

```
Idle ──Start──▶ FacultyList: click next "Start"
                       │
                       ▼
                Submit page: fill radios + comment, click Submit
                       │
                       ▼
                FacultyList again ──▶ more pending? ──yes──▶ loop
                                          │
                                          no
                                          ▼
                                        Done
```

The run state (`running`, `current`, `total`, `message`) is persisted to
`chrome.storage.local` after every step, so a refresh, slow load, or
navigation never loses progress.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save user settings (`sync`) and run state (`local`). |
| `tabs` | Read the active tab's URL to confirm you're on FacultyList before starting. |
| `scripting` | Inject `content.js` on first use if Chrome hasn't auto-injected it yet. |
| `host_permissions: iems.bauet.ac.bd` | Limit content-script & messaging to the target site only. |

The extension never sends data anywhere — everything stays on your
machine.

## Development notes

- Pure vanilla JS, no build step.
- Edit any file then click the **Reload** icon for the extension at
  `chrome://extensions`.
- Console logs from `content.js` show in the page DevTools; logs from
  `background.js` show in the service-worker DevTools (link on the
  extension's card).

## Design tokens (Wise-inspired)

The full token table lives in [`styles.css`](styles.css). Highlights:

| Token | Value | Use |
| --- | --- | --- |
| `--color-accent` | `#9fe870` | Primary CTA background, progress bar, focus ring tint |
| `--color-accent-text` | `#163300` | Text on green CTA, select caret, toggle thumb when on |
| `--color-accent-soft` | `#e2f6d5` | "Required" badge background |
| `--color-text` | `#0e0f0c` | Near-black body text |
| `--color-bg` | `#fafbf7` | Warm off-white canvas |
| `--ring` | `rgba(14,15,12,0.12) 0 0 0 1px` | Standard 1px ring shadow on cards/inputs |
| `--r-pill` | `9999px` | Buttons, status dot pulse, badges |
| `--r-large` | `30px` | Status card |
| Display | weight 900, line-height 0.85 | "Faculty / Evaluator" headline |
| Body | weight 600 default | All UI text |
| Button hover | `scale(1.05)` | Wise's signature physical-growth interaction |

Fonts: pure system stack (`-apple-system`, `Segoe UI`, etc.) so the popup
loads instantly with no CSP changes — `Wise Sans` and `Inter` are listed
first and used automatically if installed.

## Disclaimer

This extension is provided for personal convenience. You remain
responsible for the content you submit. Use it only on accounts you
own.
