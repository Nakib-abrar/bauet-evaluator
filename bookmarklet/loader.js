// BAUET Faculty Evaluator — Bookmarklet Loader
// =============================================
// Drop a tiny bookmarklet onto your bar; click it on any iems.bauet.ac.bd page.
// This loader opens a controlled popup to FacultyList and drives the entire
// flow — clicking Start, filling radios, writing comments, submitting,
// looping — from the parent window. No extension needed.

(() => {
  if (window.__bauetBookmarkletLoaded) {
    window.__bauetBookmarkletShow?.();
    return;
  }
  window.__bauetBookmarkletLoaded = true;

  // ============================================================
  // Settings — restored from / persisted to localStorage
  // ============================================================
  const LS_KEY = 'bauetBookmarkletSettings';
  const defaults = {
    rating: 'Random',
    comment: 'Good',
    fast: true,
  };

  function loadSettings() {
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
    } catch {
      return { ...defaults };
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch {}
  }

  let settings = loadSettings();
  let popup = null;
  let stopped = false;
  let current = 0;
  let total = 0;
  let lastUrl = '';

  // ============================================================
  // Constants & helpers
  // ============================================================
  const RATINGS = ['Outstanding', 'Very Good', 'Good', 'Poor', 'Very Poor'];
  const RANDOM_POOL = ['Very Good', 'Good', 'Poor'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () =>
    sleep(settings.fast ? 100 + Math.random() * 200 : 400 + Math.random() * 400);

  const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function ratingForQuestion(chosen) {
    if (chosen === 'Random') return RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
    return chosen;
  }

  function waitFor(predicate, timeout = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (stopped || !popup || popup.closed) return resolve(null);
        try {
          const r = predicate();
          if (r) return resolve(r);
        } catch {}
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(check, 100);
      };
      check();
    });
  }

  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const proto = el.constructor.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    fireInput(el);
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ============================================================
  // UI — Floating Panel
  // ============================================================
  function buildUI() {
    const root = document.createElement('div');
    root.id = 'bauet-bookmarklet-root';
    root.innerHTML = `
      <style>
        #bauet-bookmarklet-root {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 2147483647;
          width: 320px;
          background: #fafbf7;
          color: #0e0f0c;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.25), 0 0 0 1px rgba(14,15,12,0.12);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
          font-size: 13px;
          font-weight: 600;
          padding: 16px;
        }
        #bauet-bookmarklet-root * { box-sizing: border-box; }
        #bauet-bookmarklet-root .bb-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        #bauet-bookmarklet-root .bb-title {
          font-weight: 900;
          font-size: 18px;
          line-height: 0.95;
        }
        #bauet-bookmarklet-root .bb-close {
          background: none;
          border: 0;
          cursor: pointer;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          color: #454745;
          font-size: 18px;
          line-height: 1;
        }
        #bauet-bookmarklet-root .bb-close:hover { background: rgba(0,0,0,0.06); }
        #bauet-bookmarklet-root .bb-lede {
          font-size: 12px;
          font-weight: 500;
          color: #454745;
          margin-bottom: 12px;
          line-height: 1.4;
        }
        #bauet-bookmarklet-root .bb-label {
          font-weight: 700;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: #0e0f0c;
          margin-bottom: 4px;
          display: block;
        }
        #bauet-bookmarklet-root select,
        #bauet-bookmarklet-root textarea {
          width: 100%;
          padding: 8px 10px;
          border-radius: 8px;
          border: 0;
          background: #fff;
          box-shadow: 0 0 0 1px rgba(14,15,12,0.12);
          color: #0e0f0c;
          font-family: inherit;
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 10px;
          resize: vertical;
        }
        #bauet-bookmarklet-root textarea { min-height: 50px; }
        #bauet-bookmarklet-root .bb-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 10px;
        }
        #bauet-bookmarklet-root .bb-row input[type=checkbox] {
          accent-color: #9fe870;
        }
        #bauet-bookmarklet-root .bb-actions {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        #bauet-bookmarklet-root .bb-btn {
          flex: 1;
          padding: 10px 14px;
          border-radius: 9999px;
          border: 0;
          cursor: pointer;
          font-family: inherit;
          font-weight: 700;
          font-size: 13px;
          transition: transform .15s, opacity .15s;
        }
        #bauet-bookmarklet-root .bb-btn:hover { transform: scale(1.04); }
        #bauet-bookmarklet-root .bb-btn:active { transform: scale(0.96); }
        #bauet-bookmarklet-root .bb-btn-primary {
          background: #9fe870;
          color: #163300;
        }
        #bauet-bookmarklet-root .bb-btn-secondary {
          background: rgba(22,51,0,0.08);
          color: #454745;
        }
        #bauet-bookmarklet-root .bb-btn[disabled] {
          opacity: 0.4;
          cursor: not-allowed;
          transform: none !important;
        }
        #bauet-bookmarklet-root .bb-status {
          margin-top: 12px;
          padding: 10px 12px;
          background: rgba(159,232,112,0.12);
          border-radius: 10px;
          font-size: 12px;
          font-weight: 600;
          color: #0e0f0c;
          min-height: 36px;
        }
        #bauet-bookmarklet-root .bb-bar {
          height: 4px;
          background: rgba(14,15,12,0.08);
          border-radius: 2px;
          margin-top: 8px;
          overflow: hidden;
        }
        #bauet-bookmarklet-root .bb-bar-fill {
          height: 100%;
          background: #9fe870;
          width: 0;
          transition: width .3s;
        }
        #bauet-bookmarklet-root .bb-footer {
          margin-top: 12px;
          font-size: 11px;
          color: #868685;
          text-align: center;
          font-weight: 500;
        }
        #bauet-bookmarklet-root .bb-footer a {
          color: #163300;
          text-decoration: underline;
        }
      </style>
      <div class="bb-header">
        <div class="bb-title">Faculty<br>Evaluator</div>
        <button class="bb-close" id="bb-close" title="Close">×</button>
      </div>
      <p class="bb-lede">Auto-fill &amp; submit every pending evaluation. No install — opens a controlled window.</p>

      <label class="bb-label" for="bb-rating">Rating</label>
      <select id="bb-rating">
        <option value="Outstanding">Outstanding</option>
        <option value="Very Good">Very Good</option>
        <option value="Good">Good</option>
        <option value="Poor">Poor</option>
        <option value="Very Poor">Very Poor</option>
        <option value="Random">Random — Very Good / Good / Poor</option>
      </select>

      <label class="bb-label" for="bb-comment">Comment (required)</label>
      <textarea id="bb-comment" placeholder="Good"></textarea>

      <div class="bb-row">
        <input type="checkbox" id="bb-fast">
        <label for="bb-fast" style="font-size: 12px; font-weight: 600;">Fast mode</label>
      </div>

      <div class="bb-actions">
        <button class="bb-btn bb-btn-primary" id="bb-start">Start</button>
        <button class="bb-btn bb-btn-secondary" id="bb-stop" disabled>Stop</button>
      </div>

      <div class="bb-status" id="bb-status">Idle. Set rating + comment, then click Start.</div>
      <div class="bb-bar"><div class="bb-bar-fill" id="bb-bar"></div></div>

      <div class="bb-footer">
        BAUET Faculty Evaluator · <a href="https://github.com/Nakib-abrar/bauet-evaluator" target="_blank">View on GitHub</a>
      </div>
    `;

    document.body.appendChild(root);

    // Wire up UI
    const ratingSel = root.querySelector('#bb-rating');
    const commentTa = root.querySelector('#bb-comment');
    const fastCb = root.querySelector('#bb-fast');
    const startBtn = root.querySelector('#bb-start');
    const stopBtn = root.querySelector('#bb-stop');
    const closeBtn = root.querySelector('#bb-close');
    const statusEl = root.querySelector('#bb-status');
    const barEl = root.querySelector('#bb-bar');

    // Apply saved settings
    ratingSel.value = settings.rating;
    commentTa.value = settings.comment;
    fastCb.checked = settings.fast;

    // Persist on change
    [ratingSel, commentTa, fastCb].forEach((el) => {
      el.addEventListener('input', () => {
        settings = {
          rating: ratingSel.value,
          comment: commentTa.value,
          fast: fastCb.checked,
        };
        saveSettings(settings);
      });
    });

    startBtn.addEventListener('click', () => startRun(statusEl, barEl, startBtn, stopBtn));
    stopBtn.addEventListener('click', () => {
      stopped = true;
      statusEl.textContent = 'Stopping…';
    });
    closeBtn.addEventListener('click', () => {
      stopped = true;
      if (popup && !popup.closed) popup.close();
      root.remove();
      window.__bauetBookmarkletLoaded = false;
    });

    window.__bauetBookmarkletShow = () => {
      root.style.display = 'block';
    };

    return { root, statusEl, barEl, startBtn, stopBtn };
  }

  function setStatus(statusEl, msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function setProgress(barEl, current, total) {
    if (!barEl) return;
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    barEl.style.width = pct + '%';
  }

  // ============================================================
  // Popup-driven automation
  // ============================================================
  async function startRun(statusEl, barEl, startBtn, stopBtn) {
    if (!settings.comment.trim()) {
      setStatus(statusEl, '⚠ Please enter a comment.');
      return;
    }

    stopped = false;
    current = 0;
    total = 0;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus(statusEl, 'Opening FacultyList…');

    popup = window.open(
      'https://iems.bauet.ac.bd/Student/FacultyEvaluation/FacultyList',
      'bauet-bookmarklet',
      'width=1280,height=900',
    );

    if (!popup) {
      setStatus(statusEl, '⚠ Popup blocked. Allow popups for this site and try again.');
      startBtn.disabled = false;
      stopBtn.disabled = true;
      return;
    }

    // Drive loop
    try {
      while (!stopped) {
        // Wait for popup to be ready and on a page we know
        const pageType = await waitFor(() => {
          if (!popup || popup.closed) return 'closed';
          try {
            const url = popup.location.href;
            if (/FacultyList/i.test(url)) return 'list';
            if (/Submit/i.test(url)) return 'submit';
          } catch {
            return null; // cross-origin during navigation
          }
          return null;
        }, 30000);

        if (pageType === 'closed' || !pageType) {
          setStatus(statusEl, '✓ Done or window closed.');
          break;
        }

        if (pageType === 'list') {
          const result = await handleListPage(statusEl, barEl);
          if (result === 'done') {
            setStatus(statusEl, '✓ All pending evaluations completed!');
            break;
          }
          if (result === 'stopped') break;
        } else if (pageType === 'submit') {
          const result = await handleSubmitPage(statusEl, barEl);
          if (result === 'stopped') break;
        }
      }
    } catch (err) {
      setStatus(statusEl, '⚠ Error: ' + (err.message || err));
    } finally {
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  async function handleListPage(statusEl, barEl) {
    setStatus(statusEl, 'Looking for pending evaluations…');

    // Wait for table rows to render
    const ready = await waitFor(() => {
      const cell = popup.document.querySelector('table tbody tr td, table tr td');
      return cell ? true : null;
    }, 20000);

    if (!ready) {
      setStatus(statusEl, '⚠ FacultyList did not load.');
      return 'error';
    }

    await sleep(300);

    // Find pending row with enabled Start button
    const rows = Array.from(popup.document.querySelectorAll('table tr'));
    let pending = [];
    let completed = 0;
    for (const row of rows) {
      const text = row.textContent || '';
      const btn = row.querySelector('button, input[type=button], a[onclick]');
      if (!btn) continue;
      const btnText = normalize(btn.textContent || btn.value || '');
      const rowNorm = normalize(text);
      if (/complete|submitted|done|evaluated/i.test(rowNorm) && !/pending/i.test(rowNorm)) {
        completed++;
        continue;
      }
      if (/^start$/i.test(btnText) || /start/i.test(btnText)) {
        pending.push({ row, btn });
      }
    }

    total = pending.length + completed;
    setProgress(barEl, completed, total);

    if (pending.length === 0) {
      return 'done';
    }

    current = completed + 1;
    setStatus(statusEl, `Starting evaluation ${current} of ${total}…`);

    // Click the first pending Start button
    await jitter();
    if (stopped) return 'stopped';
    pending[0].btn.click();
    return 'next';
  }

  async function handleSubmitPage(statusEl, barEl) {
    setStatus(statusEl, `Filling evaluation ${current} of ${total}…`);

    // Wait for form to render
    const ready = await waitFor(() => {
      const radio = popup.document.querySelector('input[type=radio]');
      const submit = popup.document.querySelector('button[type=submit], input[type=submit], button');
      return radio && submit ? true : null;
    }, 20000);

    if (!ready) {
      setStatus(statusEl, '⚠ Form did not load.');
      return 'error';
    }

    await sleep(300);

    // Group radios by name
    const radios = Array.from(popup.document.querySelectorAll('input[type=radio]:not([disabled])'));
    const groups = {};
    for (const r of radios) {
      const name = r.name;
      if (!name) continue;
      if (!groups[name]) groups[name] = [];
      groups[name].push(r);
    }

    // Build longest-match-first rating lookup
    const ratingsByLength = [...RATINGS].sort((a, b) => b.length - a.length);

    let filled = 0;
    for (const name in groups) {
      if (stopped) return 'stopped';
      const group = groups[name];
      const chosen = ratingForQuestion(settings.rating);

      // For each radio, find its label, normalize, and bucket
      const buckets = {};
      for (const radio of group) {
        const label = labelFor(radio);
        const labelNorm = normalize(label);
        let matched = null;
        for (const r of ratingsByLength) {
          const rNorm = normalize(r);
          if (labelNorm === rNorm || labelNorm.includes(rNorm)) {
            matched = r;
            break;
          }
        }
        if (matched && !buckets[matched]) buckets[matched] = radio;
      }

      // Pick the one matching chosen rating, or fall through
      const fallback = [chosen, ...RATINGS.filter((r) => r !== chosen)];
      let picked = null;
      for (const r of fallback) {
        if (buckets[r]) {
          picked = buckets[r];
          break;
        }
      }
      if (!picked) picked = group[Math.min(RATINGS.indexOf(chosen), group.length - 1)] || group[0];

      picked.checked = true;
      fireInput(picked);
      picked.click();
      filled++;
      await jitter();
    }

    // Fill comment
    const ta = findCommentField();
    if (ta && settings.comment.trim()) {
      setNativeValue(ta, settings.comment.trim());
      await sleep(200);
    }

    // Submit
    const submitBtn = findSubmitButton();
    if (!submitBtn) {
      setStatus(statusEl, '⚠ No submit button found.');
      return 'error';
    }

    setStatus(statusEl, `Submitting evaluation ${current} of ${total}…`);
    await sleep(800);
    if (stopped) return 'stopped';
    submitBtn.click();

    setProgress(barEl, current, total);
    return 'next';
  }

  function labelFor(radio) {
    if (radio.id) {
      const lbl = popup.document.querySelector(`label[for="${radio.id}"]`);
      if (lbl) return lbl.textContent || '';
    }
    let p = radio.parentElement;
    while (p && p.tagName !== 'LABEL' && p.tagName !== 'TR' && p.tagName !== 'TD') p = p.parentElement;
    return p ? p.textContent || '' : '';
  }

  function findCommentField() {
    const candidates = Array.from(popup.document.querySelectorAll('textarea:not([disabled]):not([readonly])'));
    if (candidates.length === 0) return null;
    // Prefer textarea with name/id mentioning comment
    for (const t of candidates) {
      const id = (t.id || '').toLowerCase();
      const name = (t.name || '').toLowerCase();
      if (/comment|remark|feedback/i.test(id + ' ' + name)) return t;
    }
    return candidates[0];
  }

  function findSubmitButton() {
    const direct = popup.document.querySelector('button[type=submit], input[type=submit]');
    if (direct) return direct;
    const buttons = Array.from(popup.document.querySelectorAll('button, input[type=button]'));
    for (const b of buttons) {
      const t = normalize(b.textContent || b.value || '');
      if (/^submit$/i.test(t) || /save.*submit|submit.*evaluation/i.test(t)) return b;
    }
    return null;
  }

  // ============================================================
  // Boot
  // ============================================================
  buildUI();
})();
