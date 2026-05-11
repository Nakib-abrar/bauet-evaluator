// content.js — runs on every FacultyEvaluation page load.
// The script is the actual driver: on each page it checks runState.running
// and, if true, performs the next step. After form submission the page
// navigates back to FacultyList and this same script wakes up and continues.

(() => {
  if (window.__bauetEvaluatorLoaded) return;
  window.__bauetEvaluatorLoaded = true;

  const RATINGS = ['Outstanding', 'Very Good', 'Good', 'Poor', 'Very Poor'];
  const RANDOM_POOL = ['Very Good', 'Good', 'Poor'];
  const RANDOM_KEY = 'Random';

  function ratingForQuestion(chosenRating) {
    if (chosenRating === RANDOM_KEY) {
      return RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
    }
    return chosenRating;
  }

  const PAGE = {
    LIST: /\/Student\/FacultyEvaluation\/FacultyList/i,
    SUBMIT: /\/Student\/FacultyEvaluation\/Submit/i,
  };

  // ---------- utilities ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min = 800, max = 1200) =>
    sleep(Math.floor(min + Math.random() * (max - min)));

  function normalize(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Wait for an element described by `predicate()` to exist, using
  // MutationObserver. Resolves with the element, or null on timeout.
  function waitForElement(predicate, { timeout = 15000, root = document } = {}) {
    const found = predicate();
    if (found) return Promise.resolve(found);

    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const el = predicate();
        if (el) finish(el);
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      const timer = setTimeout(() => finish(null), timeout);
    });
  }

  async function getRunState() {
    const { runState } = await chrome.storage.local.get('runState');
    return runState || { running: false };
  }
  async function setRunState(patch) {
    const cur = await getRunState();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ runState: next });
    return next;
  }
  async function getSettings() {
    const { settings } = await chrome.storage.sync.get('settings');
    return (
      settings || {
        rating: 'Random',
        fast: true,
        continuous: true,
        comment: 'Good',
      }
    );
  }

  function pickComment(settings) {
    return (settings.comment || '').trim();
  }

  // Fire a real "user-like" change so frameworks pick up the new value.
  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Walk up from a control to find the surrounding "question block" —
  // an ancestor whose text starts with a numbered prefix like "1." or
  // "12.". Falls back to the element itself if no such ancestor is
  // found (e.g. for the Comment textarea or Submit button).
  function scrollTarget(el) {
    let node = el.parentElement;
    for (let i = 0; i < 5 && node; i++) {
      const txt = (node.innerText || '').trim();
      // Match a line that starts with "<digits>.<anything>"
      if (/^\s*\d+\./m.test(txt)) return node;
      node = node.parentElement;
    }
    return el;
  }

  // Smoothly scroll an element into view. Centered vertically so the
  // question text above and the radio row stay visible together. All
  // scrollIntoView calls are wrapped — a detached element or a quirky
  // browser must NEVER throw here, or it would abort the radio-fill
  // loop mid-evaluation.
  function scrollIntoCenter(el) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const target = scrollTarget(el);
    try {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    } catch {
      try {
        target.scrollIntoView();
      } catch {
        /* element detached or scrolling not supported — silently skip */
      }
    }
  }

  // Set a textarea/input's value via the native setter — this bypasses
  // any framework that has overridden the property setter (React,
  // Knockout, etc.) and ensures the underlying DOM value actually
  // updates. Then fire the full sequence of events that validators
  // typically listen for: input, change, keyup, blur.
  function setControlValue(el, value) {
    try {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, value);
      } else {
        el.value = value;
      }
    } catch {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ---------- FacultyList page ----------

  // Returns array of "pending" rows. A row is pending if it contains a
  // visible, enabled "Start" button/link, and its status text isn't
  // already "Submitted" / "Completed" / "Done". The IEMS page uses a
  // "Pending" badge in the Submission Status column for actionable rows.
  function findPendingRows() {
    const rows = Array.from(document.querySelectorAll('table tr'));
    const pending = [];
    for (const row of rows) {
      // Skip header rows (no <td> cells).
      if (!row.querySelector('td')) continue;

      // Status check FIRST — the IEMS page uses a "Complete" (singular!)
      // badge for done rows. Skip those before we even look for buttons,
      // so any leftover hidden Start link in a done row can't be clicked.
      const text = normalize(row.innerText);
      const isDone =
        /\b(complete|completed|submitted|done|evaluated)\b/.test(text) &&
        !/\bpending\b/.test(text);
      if (isDone) continue;

      const startBtn = Array.from(
        row.querySelectorAll(
          'a, button, input[type="button"], input[type="submit"]',
        ),
      ).find((el) => {
        if (el.disabled) return false;
        if (el.offsetParent === null) return false; // hidden / display:none
        const t = normalize(el.innerText || el.value || '');
        return t === 'start' || t.startsWith('start');
      });
      if (!startBtn) continue;

      pending.push({ row, startBtn });
    }
    return pending;
  }

  // Try to extract the teacher's name from the row for nicer status text.
  // Real columns on the IEMS page: Ser | Course Name | Course Teacher |
  // Submission Status | Action. The teacher cell is a person's name —
  // 2+ words, alphabetic with optional dots ("Md."), no digits, no "[A]"
  // section markers, and not the action button.
  function teacherNameFromRow(row) {
    const cells = Array.from(row.querySelectorAll('td'));

    const looksLikeName = (t) => {
      if (!t) return false;
      if (/\d/.test(t)) return false;          // course codes have digits
      if (/\[[A-Za-z]\]/.test(t)) return false; // skip "[A]" section markers
      if (/^(start|pending|submitted|done|completed|evaluated)$/i.test(t))
        return false;
      if (!/[A-Za-z]/.test(t)) return false;
      // A real name has at least two whitespace-separated tokens.
      return t.split(/\s+/).filter(Boolean).length >= 2;
    };

    for (const td of cells) {
      if (
        td.querySelector(
          'a, button, input[type="button"], input[type="submit"]',
        )
      )
        continue;
      const t = (td.innerText || '').trim().replace(/\s+/g, ' ');
      if (looksLikeName(t)) return t;
    }
    // Fallback: any cell with letters that isn't the Start button.
    for (const td of cells) {
      const t = (td.innerText || '').trim().replace(/\s+/g, ' ');
      if (t && /[A-Za-z]/.test(t) && !/^start$/i.test(t)) return t;
    }
    return 'teacher';
  }

  async function handleListPage() {
    const state = await getRunState();
    if (!state.running) return;

    // Wait until the table actually has data rows. Resolving on the
    // bare <table> element fires too early — the page chrome includes
    // empty table shells while the body is still being rendered, and
    // findPendingRows() against an empty shell would falsely return 0
    // and make us declare the run finished after the very first submit.
    await waitForElement(() => {
      // Pending rows already detected? Done.
      if (findPendingRows().length) return true;
      // Otherwise wait for at least one data row (a <tr> with a <td>) —
      // once any row is rendered, the rest are too (server-rendered HTML).
      const dataRow = document.querySelector('table tbody tr td, table tr td');
      return dataRow ? true : null;
    });

    // Tiny extra settling pause — covers the case where the first <td>
    // has rendered but the action-cell <a>Start</a> for later rows is
    // still being painted by a deferred script.
    await sleep(150);

    const pending = findPendingRows();

    // Establish total once per run, then keep counting up as we finish each.
    let total = state.total || 0;
    let current = state.current || 0;
    if (!total || total < current + pending.length) {
      total = current + pending.length;
    }

    if (pending.length === 0) {
      await setRunState({
        running: false,
        message: `Done. Completed ${current} of ${total || current} evaluation(s).`,
        current,
        total: total || current,
      });
      return;
    }

    // "All at once" toggle. When OFF, the script does ONE evaluation per
    // Start press: after the first submit lands us back on this page,
    // current > 0 and we stop here so the user can click Start again
    // for the next teacher.
    const settings = await getSettings();
    if (settings.continuous === false && current > 0) {
      await setRunState({
        running: false,
        message:
          `Completed ${current} of ${total}. ` +
          `Click Start for the next pending evaluation.`,
        current,
        total,
      });
      return;
    }

    const next = pending[0];
    const name = teacherNameFromRow(next.row);
    const idx = current + 1;

    await setRunState({
      running: true,
      message: `Evaluating ${idx} of ${total} — ${name}…`,
      current,
      total,
      lastName: name,
      // Reset the per-teacher anti-loop key so it can't false-positive
      // on the next /Submit page from a stale value.
      lastSubmittedKey: null,
    });

    await jitter();

    // Honor a Stop pressed during the wait.
    if (!(await getRunState()).running) return;

    next.startBtn.click();
    // The site navigates to /Submit — content.js will re-bootstrap there.
  }

  // ---------- Submit (evaluation form) page ----------

  // Group radios by `name`. Each group is one question.
  function getRadioGroups() {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const groups = new Map();
    for (const r of radios) {
      if (r.disabled) continue;
      const key = r.name || r.getAttribute('data-name') || '';
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return Array.from(groups.values());
  }

  // Get the human-readable label for a radio: prefer <label for=id>, else
  // closest wrapping <label>, else nearest sibling text.
  function labelForRadio(radio) {
    if (radio.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (lab) return normalize(lab.innerText);
    }
    const wrap = radio.closest('label');
    if (wrap) return normalize(wrap.innerText);
    const parent = radio.parentElement;
    if (parent) return normalize(parent.innerText);
    return '';
  }

  // Pick the radio in a group whose label matches the desired rating.
  // We bucket each radio to its best-matching rating using LONGEST first
  // (so "very good" wins over "good" when checking the Very Good label,
  // and "good" cleanly maps to the Good label) — this prevents the
  // classic bug where picking "Good" would select the "Very Good" radio
  // because "very good".includes("good") is true.
  function pickRadio(group, rating) {
    const target = normalize(rating);
    const allRatings = RATINGS.map(normalize);
    // Longest first: "outstanding" (11), "very good"/"very poor" (9),
    // "good" (4), "poor" (4).
    const ratingsByLength = [...allRatings].sort((a, b) => b.length - a.length);

    const buckets = group.map((r) => {
      const lab = labelForRadio(r);
      const bucket =
        ratingsByLength.find((rt) => lab === rt) ||
        ratingsByLength.find((rt) => lab.includes(rt)) ||
        null;
      return { radio: r, bucket };
    });

    // 1) Exact bucket match for the user's chosen rating.
    const exact = buckets.find((b) => b.bucket === target);
    if (exact) return exact.radio;

    // 2) Fall back through the rating list (so we never leave a Q blank).
    const fallbackOrder = [target, ...allRatings.filter((r) => r !== target)];
    for (const candidate of fallbackOrder) {
      const hit = buckets.find((b) => b.bucket === candidate);
      if (hit) return hit.radio;
    }

    // 3) Last resort: pick by index for the chosen rating (5-point scale).
    const idx = RATINGS.findIndex((r) => normalize(r) === target);
    if (idx >= 0 && group[idx]) return group[idx];
    return group[0] || null;
  }

  function findCommentField() {
    const usable = (ta) =>
      ta && !ta.disabled && !ta.readOnly && ta.offsetParent !== null;

    // 1) Textarea whose name/id mentions comment/remark/feedback/review.
    const named = Array.from(
      document.querySelectorAll(
        'textarea[name*="comment" i], textarea[id*="comment" i], ' +
          'textarea[name*="remark" i], textarea[id*="remark" i], ' +
          'textarea[name*="feedback" i], textarea[id*="feedback" i], ' +
          'textarea[name*="review" i], textarea[id*="review" i]',
      ),
    ).find(usable);
    if (named) return named;

    // 2) Textarea anchored to a label whose text is "Comment".
    const labelEls = Array.from(
      document.querySelectorAll('label, span, div, b, strong, p'),
    ).filter((el) =>
      /^\s*comment\s*[:*]?\s*$/i.test((el.textContent || '').trim()),
    );
    for (const lbl of labelEls) {
      const forId = lbl.getAttribute && lbl.getAttribute('for');
      if (forId) {
        const ta = document.getElementById(forId);
        if (ta && ta.tagName === 'TEXTAREA' && usable(ta)) return ta;
      }
      // Walk up a few levels and look for a textarea inside the same block.
      let parent = lbl.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        const ta = parent.querySelector('textarea');
        if (ta && usable(ta)) return ta;
        parent = parent.parentElement;
      }
    }

    // 3) Any textarea inside the evaluation form.
    const inForm = Array.from(document.querySelectorAll('form textarea')).find(
      usable,
    );
    if (inForm) return inForm;

    // 4) Last resort: the first textarea on the page.
    return Array.from(document.querySelectorAll('textarea')).find(usable) || null;
  }

  function findSubmitButton() {
    const candidates = Array.from(
      document.querySelectorAll(
        'form button, form input[type="submit"], button, input[type="submit"]',
      ),
    );
    // Prefer explicit submit
    const explicit = candidates.find(
      (el) => (el.getAttribute('type') || '').toLowerCase() === 'submit',
    );
    if (explicit) return explicit;
    return candidates.find((el) => {
      const t = normalize(el.innerText || el.value || '');
      return t === 'submit' || t.includes('submit');
    });
  }

  async function handleSubmitPage() {
    const state = await getRunState();
    if (!state.running) return;

    // Anti-loop guard: if we already submitted this exact form URL but
    // the page didn't navigate away (slow redirect or server-side
    // validation error), bounce back to FacultyList instead of
    // resubmitting in a loop.
    //
    // Use history.back() so we land on whichever FacultyList URL the
    // user actually came from — including its semester (?semId=…) and
    // any other query params. Hardcoding `/FacultyList?semId=…` would
    // break the moment the school's URL schema changes (next semester,
    // a path rename, etc.).
    const submitKey = location.search;
    if (state.lastSubmittedKey && state.lastSubmittedKey === submitKey) {
      await setRunState({
        message: 'Submit acknowledged — returning to list…',
        lastSubmittedKey: null,
      });
      history.back();
      return;
    }

    const settings = await getSettings();

    // Wait until at least one radio + textarea exists (form fully rendered).
    await waitForElement(
      () =>
        document.querySelector('input[type="radio"]') &&
        findCommentField() &&
        findSubmitButton(),
      { timeout: 20000 },
    );

    const groups = getRadioGroups();
    if (!groups.length) {
      await setRunState({
        running: false,
        message: 'No questions found on the form. Stopping.',
      });
      return;
    }

    // Per-question pacing — Fast mode (default) snaps through quickly,
    // slow mode is visibly paced so you can see each radio click.
    const [perQMin, perQMax] = settings.fast !== false ? [120, 260] : [400, 700];

    let answered = 0;
    for (const group of groups) {
      // Honor a Stop pressed mid-fill.
      if (!(await getRunState()).running) return;
      // For "Random", roll fresh per question; otherwise constant.
      const ratingForThisQ = ratingForQuestion(settings.rating);
      const radio = pickRadio(group, ratingForThisQ);
      if (!radio || radio.disabled) continue;
      // Bring this question into view so the user can watch the script
      // work. Centered so the question text above stays visible.
      scrollIntoCenter(radio);
      if (!radio.checked) {
        radio.click();          // user-equivalent: sets checked + fires events
        if (!radio.checked) {   // some custom controls intercept click
          radio.checked = true;
          fireInput(radio);
        }
      }
      answered++;
      await jitter(perQMin, perQMax);
    }

    const commentEl = findCommentField();
    const comment = pickComment(settings);
    if (!commentEl) {
      await setRunState({
        running: false,
        message: 'No comment field found. Stopping.',
      });
      return;
    }
    if (!comment) {
      await setRunState({
        running: false,
        message: 'Comment is empty. Add one in the popup, then resume.',
      });
      return;
    }

    // Scroll the comment field into view before filling it so the user
    // can watch the text appear.
    scrollIntoCenter(commentEl);
    commentEl.focus();
    setControlValue(commentEl, comment);

    // Verify the value actually stuck. If a framework or validator
    // re-cleared it, retry once with a small delay, then bail with a
    // clear message rather than submitting an empty comment.
    if (commentEl.value !== comment) {
      await sleep(120);
      setControlValue(commentEl, comment);
    }
    if (!commentEl.value || !commentEl.value.trim()) {
      await setRunState({
        running: false,
        message:
          'Could not write into the comment field — the page may be blocking it. Stopping.',
      });
      return;
    }

    await setRunState({
      message: `Filled ${answered} question(s) + comment. Submitting${
        state.lastName ? ' for ' + state.lastName : ''
      }…`,
    });

    // 3-second visible countdown so the user can see what's about to
    // happen (and can hit Stop). Each tick re-checks the run flag.
    for (let i = 3; i > 0; i--) {
      const tick = await getRunState();
      if (!tick.running) return;
      await setRunState({
        message: `Submitting in ${i}s${
          state.lastName ? ' — ' + state.lastName : ''
        }…`,
      });
      await sleep(1000);
    }

    // Final stop check before the click.
    const fresh = await getRunState();
    if (!fresh.running) return;

    const submitBtn = findSubmitButton();
    if (!submitBtn) {
      await setRunState({
        running: false,
        message: 'Could not find Submit button. Stopping.',
      });
      return;
    }

    // Scroll the Submit button into view so the user sees the click happen.
    scrollIntoCenter(submitBtn);

    // Bump completed count BEFORE the click, since the page is about
    // to navigate and we want the resumed run on FacultyList to see
    // it. Use the freshly-read state so we don't stomp on writes
    // that happened during fill.
    await setRunState({
      current: (fresh.current || 0) + 1,
      lastSubmittedKey: submitKey,
    });

    submitBtn.click();
    // Page navigates back to FacultyList; the resumed content.js on
    // that page picks the next pending teacher and repeats.
  }

  // ---------- bootstrap & messaging ----------

  async function bootstrap() {
    const url = location.href;
    if (PAGE.SUBMIT.test(url)) {
      await handleSubmitPage();
    } else if (PAGE.LIST.test(url)) {
      await handleListPage();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'BAUET_START') {
      (async () => {
        await chrome.storage.local.set({
          runState: {
            running: true,
            message: 'Starting…',
            current: 0,
            total: 0,
            startedAt: Date.now(),
            lastSubmittedKey: null,
          },
        });
        sendResponse({ ok: true });
        // Don't await — let bootstrap run independently so the popup
        // gets its ack immediately rather than waiting on jitter+click.
        bootstrap();
      })();
      return true;
    }
    if (msg.type === 'BAUET_STOP') {
      (async () => {
        await setRunState({ running: false, message: 'Stopped by user.' });
        sendResponse({ ok: true });
      })();
      return true;
    }
  });

  // Auto-resume: if a run was already in progress before this page loaded
  // (e.g. after navigation between FacultyList <-> Submit), continue.
  (async () => {
    const state = await getRunState();
    if (state.running) {
      // Slight delay so the page's own scripts settle first.
      await sleep(300);
      bootstrap();
    }
  })();
})();
