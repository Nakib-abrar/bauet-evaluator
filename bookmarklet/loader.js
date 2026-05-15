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
  let overlayEl = null;
  let iframeEl = null;
  let stopped = false;
  let current = 0;
  let total = 0;
  // URL we last finished processing — used to wait for navigation after a
  // click before re-entering the page handler, otherwise the loop would
  // see the stale URL and (e.g.) resubmit the same form or re-click the
  // same Start button.
  let lastProcessedUrl = '';
  // Anti-loop guard: form URL we last submitted. If we land back on the
  // same Submit URL (slow redirect, server-side validation), we know not
  // to fire submit again.
  let lastSubmittedUrl = '';

  const VERSION = '3.7.2';
  const BAUET_HOST = 'iems.bauet.ac.bd';
  const FACULTY_LIST_PATH = '/Student/FacultyEvaluation/FacultyList';
  const LOGIN_URL_RX = /\/(Account\/)?Login/i;

  function createIframeOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'bauet-bookmarklet-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;background:rgba(14,15,12,0.55);backdrop-filter:blur(2px);';

    const iframe = document.createElement('iframe');
    iframe.style.cssText =
      'position:absolute;top:20px;left:20px;right:380px;bottom:20px;width:calc(100% - 400px);height:calc(100% - 40px);border:0;border-radius:14px;background:#fff;box-shadow:0 24px 60px rgba(0,0,0,0.45);';
    iframe.src = FACULTY_LIST_PATH;
    overlay.appendChild(iframe);
    document.body.appendChild(overlay);

    overlayEl = overlay;
    iframeEl = iframe;

    // Wrap iframe so the rest of the automation can keep using
    // popup.document / popup.location / popup.closed semantics. Reads
    // are guarded — accessing a navigating iframe can throw transient
    // SecurityError or expose null contentDocument.
    return {
      get document() {
        try {
          return iframe.contentDocument;
        } catch {
          return null;
        }
      },
      get location() {
        try {
          return iframe.contentWindow ? iframe.contentWindow.location : null;
        } catch {
          return null;
        }
      },
      get href() {
        try {
          return iframe.contentWindow ? iframe.contentWindow.location.href : '';
        } catch {
          return '';
        }
      },
      get closed() {
        return !iframe.isConnected;
      },
      close() {
        teardownIframeOverlay();
      },
    };
  }

  // Probe whether the iframe is reachable from the parent. Returns:
  //   'ok'        — same-origin doc is accessible
  //   'blocked'   — load fired but doc unreadable (X-Frame-Options /
  //                 frame-ancestors / cross-origin redirect)
  //   'login'     — iframe redirected to a login page
  //   'pending'   — still loading; try again later
  async function probeIframe(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (stopped || !popup || popup.closed) return 'blocked';
      const doc = popup.document;
      const href = popup.href;
      // about:blank means the iframe element exists but the BAUET page
      // hasn't started rendering yet. Keep waiting.
      if (href && href !== 'about:blank') {
        if (LOGIN_URL_RX.test(href)) return 'login';
        if (doc && doc.body && doc.body.childElementCount > 0) return 'ok';
      }
      await sleep(150);
    }
    // Final classification on timeout.
    const doc = popup ? popup.document : null;
    if (!doc) return 'blocked';
    if (LOGIN_URL_RX.test(popup.href)) return 'login';
    return 'pending';
  }

  function teardownIframeOverlay() {
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    iframeEl = null;
  }

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

  // Wait until the iframe's URL stops matching `fromUrl` (i.e. navigation
  // has actually happened). Returns the new URL, or null on timeout. We
  // strip the query string when comparing so search-param-only changes
  // (e.g. anti-cache tokens) don't fool us, but a true page change does.
  function waitForUrlChange(fromUrl, timeout = 20000) {
    const stripped = (u) => (u || '').split('#')[0];
    const baseFrom = stripped(fromUrl);
    return waitFor(() => {
      const cur = stripped(popup ? popup.href : '');
      if (!cur || cur === 'about:blank') return null;
      // Navigation finished AND we're on a sensibly different URL.
      if (cur !== baseFrom) return cur;
      return null;
    }, timeout);
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
      <p class="bb-lede">Auto-fill &amp; submit every pending evaluation. Runs inside this page — no popups.</p>

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
        BAUET Faculty Evaluator v${VERSION} · <a href="https://github.com/Nakib-abrar/bauet-evaluator" target="_blank">View on GitHub</a>
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
      teardownIframeOverlay();
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

    if (location.hostname !== BAUET_HOST) {
      setStatus(
        statusEl,
        '⚠ Open this on https://iems.bauet.ac.bd first, then click the bookmark.',
      );
      return;
    }

    stopped = false;
    current = 0;
    total = 0;
    lastProcessedUrl = '';
    lastSubmittedUrl = '';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus(statusEl, 'Loading FacultyList…');

    popup = createIframeOverlay();

    try {
      // First load — make sure the iframe actually rendered something we
      // can drive (not a login redirect, not blocked by X-Frame-Options).
      const probe = await probeIframe();
      if (probe === 'login') {
        setStatus(
          statusEl,
          '⚠ You are not logged in to BAUET. Log in in this tab, then click Start again.',
        );
        return;
      }
      if (probe === 'blocked') {
        setStatus(
          statusEl,
          '⚠ Could not load the FacultyList in-page. The site may be blocking iframes — try the Chrome extension version.',
        );
        return;
      }
      if (probe === 'pending') {
        setStatus(statusEl, '⚠ FacultyList took too long to load. Try Start again.');
        return;
      }

      while (!stopped) {
        // Identify which page the iframe is currently on. Wait long
        // enough for any in-flight navigation to settle.
        const pageType = await waitFor(() => {
          if (!popup || popup.closed) return 'closed';
          const url = popup.href;
          if (!url || url === 'about:blank') return null;
          if (LOGIN_URL_RX.test(url)) return 'login';
          if (/\/FacultyEvaluation\/Submit/i.test(url)) return 'submit';
          if (/\/FacultyEvaluation\/FacultyList/i.test(url)) return 'list';
          return null;
        }, 30000);

        if (!pageType || pageType === 'closed') {
          setStatus(statusEl, '⚠ Iframe closed or navigation timed out.');
          break;
        }
        if (pageType === 'login') {
          setStatus(statusEl, '⚠ Session expired. Log in again, then restart.');
          break;
        }

        // Race guard: the page handler we're about to run was the same
        // one we ran last iteration. The click hasn't navigated yet —
        // wait for the URL to change before re-entering, or we'll
        // re-click Start / re-submit the same form.
        if (lastProcessedUrl && popup.href === lastProcessedUrl) {
          const moved = await waitForUrlChange(lastProcessedUrl, 25000);
          if (!moved) {
            setStatus(
              statusEl,
              '⚠ The page did not navigate after the last action. Stopping.',
            );
            break;
          }
          continue; // re-classify the new URL
        }

        const here = popup.href;
        let result;
        if (pageType === 'list') {
          result = await handleListPage(statusEl, barEl);
        } else {
          result = await handleSubmitPage(statusEl, barEl);
        }
        lastProcessedUrl = here;

        if (result === 'done') {
          setStatus(statusEl, `✓ All pending evaluations completed (${current}/${total}).`);
          setProgress(barEl, total, total);
          break;
        }
        if (result === 'stopped') {
          setStatus(statusEl, 'Stopped.');
          break;
        }
        if (result === 'error') break; // status already set by handler
      }
    } catch (err) {
      setStatus(statusEl, '⚠ Error: ' + (err && err.message ? err.message : err));
    } finally {
      startBtn.disabled = false;
      stopBtn.disabled = true;
      // Leave the iframe up for a moment so the user sees the final
      // state, then tear it down. Don't auto-tear if a login error is
      // showing — let the user finish reading.
      setTimeout(() => teardownIframeOverlay(), 2000);
    }
  }

  async function handleListPage(statusEl, barEl) {
    setStatus(statusEl, 'Looking for pending evaluations…');

    // Wait for at least one data row in any table to render. Resolving
    // on an empty table shell would make us declare "done" before the
    // rows finish painting.
    const ready = await waitFor(() => {
      const doc = popup.document;
      if (!doc) return null;
      const cell = doc.querySelector('table tbody tr td, table tr td');
      return cell ? true : null;
    }, 20000);

    if (!ready) {
      setStatus(statusEl, '⚠ FacultyList did not load.');
      return 'error';
    }

    // Tiny settling pause so deferred row scripts (e.g. action-cell
    // anchor injection) can finish.
    await sleep(200);

    const doc = popup.document;
    const rows = Array.from(doc.querySelectorAll('table tr'));
    const pending = [];
    let completed = 0;

    for (const row of rows) {
      // Header rows have no <td>.
      if (!row.querySelector('td')) continue;

      const rowText = normalize(row.innerText || row.textContent || '');

      // Word-boundary completion check — keeps a teacher named
      // "Mr. Done" or a course like "Composite Materials" from being
      // mis-flagged.
      const looksDone =
        /\b(complete|completed|submitted|done|evaluated)\b/.test(rowText) &&
        !/\bpending\b/.test(rowText);

      // Find the action element. Plain <a href> works too — earlier we
      // required `[onclick]` and missed link-style Start buttons.
      const actionEl = Array.from(
        row.querySelectorAll(
          'a, button, input[type=button], input[type=submit]',
        ),
      ).find((el) => {
        if (el.disabled) return false;
        // offsetParent === null catches display:none / detached.
        if (el.offsetParent === null && el.tagName !== 'A') return false;
        const t = normalize(el.innerText || el.value || el.textContent || '');
        return t === 'start' || t.startsWith('start');
      });

      if (looksDone) {
        completed++;
        continue;
      }
      if (actionEl) pending.push({ row, btn: actionEl });
    }

    total = pending.length + completed;
    // Show progress as completed-so-far (not in-flight).
    setProgress(barEl, completed, total);

    if (pending.length === 0) {
      current = completed;
      return 'done';
    }

    current = completed + 1;
    setStatus(statusEl, `Starting evaluation ${current} of ${total}…`);

    await jitter();
    if (stopped) return 'stopped';

    // Snapshot URL before the click so the outer loop can detect that
    // navigation has actually happened.
    pending[0].btn.click();
    return 'next';
  }

  async function handleSubmitPage(statusEl, barEl) {
    // Anti-resubmit guard. If we already fired Submit on this exact
    // form URL but got bounced back here (slow redirect, server-side
    // validation), don't refill + resubmit — that's how you accidentally
    // submit the same evaluation twice.
    const submitKey = popup.href;
    if (lastSubmittedUrl && lastSubmittedUrl === submitKey) {
      setStatus(statusEl, 'Submit acknowledged — returning to FacultyList…');
      try {
        popup.location.replace(FACULTY_LIST_PATH);
      } catch {
        if (iframeEl) iframeEl.src = FACULTY_LIST_PATH;
      }
      lastSubmittedUrl = '';
      return 'next';
    }

    setStatus(statusEl, `Filling evaluation ${current} of ${total}…`);

    // Wait for the form to fully render — radios + textarea + submit
    // button all present.
    const ready = await waitFor(() => {
      const doc = popup.document;
      if (!doc) return null;
      const radio = doc.querySelector('input[type=radio]');
      const ta = findCommentField();
      const submit = findSubmitButton();
      return radio && ta && submit ? true : null;
    }, 20000);

    if (!ready) {
      setStatus(statusEl, '⚠ Form did not load.');
      return 'error';
    }

    await sleep(200);

    const doc = popup.document;
    // Group radios by name.
    const radios = Array.from(doc.querySelectorAll('input[type=radio]:not([disabled])'));
    const groups = {};
    for (const r of radios) {
      const name = r.name || r.getAttribute('data-name') || '';
      if (!name) continue;
      if (!groups[name]) groups[name] = [];
      groups[name].push(r);
    }
    const groupNames = Object.keys(groups);
    if (groupNames.length === 0) {
      setStatus(statusEl, '⚠ No radio questions found.');
      return 'error';
    }

    // Longest-rating-first match: prevents "Good" from accidentally
    // matching the "Very Good" label via .includes().
    const ratingsByLength = [...RATINGS].sort((a, b) => b.length - a.length);

    let filled = 0;
    for (const name of groupNames) {
      if (stopped) return 'stopped';
      const group = groups[name];
      const chosen = ratingForQuestion(settings.rating);

      const buckets = {};
      for (const radio of group) {
        const labelNorm = normalize(labelFor(radio));
        let matched = null;
        // Prefer exact label match, then includes (longest first).
        for (const r of ratingsByLength) {
          if (labelNorm === normalize(r)) { matched = r; break; }
        }
        if (!matched) {
          for (const r of ratingsByLength) {
            if (labelNorm.includes(normalize(r))) { matched = r; break; }
          }
        }
        if (matched && !buckets[matched]) buckets[matched] = radio;
      }

      // Try chosen rating first, then fall through the rating list.
      const fallback = [chosen, ...RATINGS.filter((r) => r !== chosen)];
      let picked = null;
      for (const r of fallback) {
        if (buckets[r]) { picked = buckets[r]; break; }
      }
      // Last resort: 5-point index alignment so we never leave a Q blank.
      if (!picked) {
        const idx = RATINGS.indexOf(chosen);
        picked = group[idx] || group[0];
      }

      // Click first (user-equivalent), then force checked if the click
      // was intercepted by a custom control. Avoids the inverse case
      // where setting .checked = true synthetically fails to fire the
      // framework's change handler.
      picked.click();
      if (!picked.checked) {
        picked.checked = true;
        fireInput(picked);
      }
      filled++;
      await jitter();
    }

    if (stopped) return 'stopped';

    // Fill the comment.
    const ta = findCommentField();
    const comment = (settings.comment || '').trim();
    if (!ta) {
      setStatus(statusEl, '⚠ Comment field not found.');
      return 'error';
    }
    if (!comment) {
      setStatus(statusEl, '⚠ Comment is empty.');
      return 'error';
    }
    ta.focus();
    setNativeValue(ta, comment);
    // Verify it stuck — if a framework re-cleared it, retry once.
    if (ta.value !== comment) {
      await sleep(150);
      setNativeValue(ta, comment);
    }
    if (!ta.value || !ta.value.trim()) {
      setStatus(statusEl, '⚠ Could not write into the comment field.');
      return 'error';
    }
    await sleep(200);

    // Submit.
    const submitBtn = findSubmitButton();
    if (!submitBtn) {
      setStatus(statusEl, '⚠ No submit button found.');
      return 'error';
    }

    setStatus(statusEl, `Submitting evaluation ${current} of ${total}…`);
    await sleep(settings.fast ? 400 : 800);
    if (stopped) return 'stopped';

    // Record what we're about to submit BEFORE the click, so the guard
    // at the top of this function fires correctly if the page bounces
    // us back.
    lastSubmittedUrl = submitKey;
    submitBtn.click();
    return 'next';
  }

  function labelFor(radio) {
    const doc = popup ? popup.document : null;
    if (radio.id && doc) {
      // Use CSS.escape so IDs containing dots/colons (common in
      // server-generated names) don't break the selector.
      const safeId = (window.CSS && CSS.escape) ? CSS.escape(radio.id) : radio.id;
      try {
        const lbl = doc.querySelector(`label[for="${safeId}"]`);
        if (lbl) return lbl.textContent || '';
      } catch {}
    }
    // Wrapping <label> next.
    if (radio.closest) {
      const wrap = radio.closest('label');
      if (wrap) return wrap.textContent || '';
    }
    // Fall back to the nearest meaningful container.
    let p = radio.parentElement;
    while (p && p.tagName !== 'LABEL' && p.tagName !== 'TR' && p.tagName !== 'TD') {
      p = p.parentElement;
    }
    return p ? p.textContent || '' : '';
  }

  function findCommentField() {
    const doc = popup ? popup.document : null;
    if (!doc) return null;
    const usable = (ta) =>
      ta && !ta.disabled && !ta.readOnly && ta.offsetParent !== null;

    // 1) name/id hints.
    const named = Array.from(
      doc.querySelectorAll(
        'textarea[name*="comment" i], textarea[id*="comment" i],' +
          'textarea[name*="remark" i], textarea[id*="remark" i],' +
          'textarea[name*="feedback" i], textarea[id*="feedback" i],' +
          'textarea[name*="review" i], textarea[id*="review" i]',
      ),
    ).find(usable);
    if (named) return named;

    // 2) anchored to a "Comment" label.
    const labelEls = Array.from(doc.querySelectorAll('label, span, div, b, strong, p')).filter((el) =>
      /^\s*comment\s*[:*]?\s*$/i.test((el.textContent || '').trim()),
    );
    for (const lbl of labelEls) {
      const forId = lbl.getAttribute && lbl.getAttribute('for');
      if (forId) {
        const ta = doc.getElementById(forId);
        if (ta && ta.tagName === 'TEXTAREA' && usable(ta)) return ta;
      }
      let parent = lbl.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        const ta = parent.querySelector('textarea');
        if (ta && usable(ta)) return ta;
        parent = parent.parentElement;
      }
    }

    // 3) any textarea inside the form.
    const inForm = Array.from(doc.querySelectorAll('form textarea')).find(usable);
    if (inForm) return inForm;

    // 4) last resort.
    return Array.from(doc.querySelectorAll('textarea')).find(usable) || null;
  }

  function findSubmitButton() {
    const doc = popup ? popup.document : null;
    if (!doc) return null;
    // Prefer explicit submit controls.
    const direct = doc.querySelector('button[type=submit], input[type=submit]');
    if (direct && !direct.disabled) return direct;
    // Otherwise look for a button whose label says "Submit".
    const candidates = Array.from(
      doc.querySelectorAll('form button, button, input[type=button]'),
    );
    for (const b of candidates) {
      if (b.disabled) continue;
      const t = normalize(b.textContent || b.value || '');
      if (t === 'submit' || /\bsubmit\b/.test(t)) return b;
    }
    return null;
  }

  // ============================================================
  // Boot
  // ============================================================
  buildUI();
})();
