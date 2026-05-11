// Popup script: loads/saves settings and starts/stops the run.
// Live status comes from chrome.storage.local (written by content.js).

const els = {
  rating: document.getElementById('rating'),
  fast: document.getElementById('fast'),
  continuous: document.getElementById('continuous'),
  comment: document.getElementById('comment'),
  commentCount: document.getElementById('comment-count'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  status: document.getElementById('status'),
  statusDot: document.getElementById('status-dot'),
  bar: document.getElementById('bar-fill'),
  pageBanner: document.getElementById('page-banner'),
  bannerLink: document.getElementById('banner-link'),
  themeToggle: document.getElementById('theme-toggle'),
  logBody: document.getElementById('log-body'),
  logClear: document.getElementById('log-clear'),
  chips: Array.from(document.querySelectorAll('.chip[data-comment]')),
};

const MAX_LOG_ROWS = 80;
let lastLoggedMessage = null;

const FACULTY_LIST_URL = /\/Student\/FacultyEvaluation\/FacultyList/i;
const FACULTY_EVAL_AREA = /iems\.bauet\.ac\.bd\/Student\/FacultyEvaluation\//i;

let onCorrectPage = false;
let isRunning = false;
// Synchronous re-entry guard for handleStart — prevents a fast
// double-click from firing two BAUET_START messages while the first
// is still in the middle of its async setup.
let starting = false;

function setStatusDot(kind) {
  if (!els.statusDot) return;
  els.statusDot.classList.remove('dot-idle', 'dot-running', 'dot-done', 'dot-error');
  els.statusDot.classList.add('dot-' + kind);
}

// ---------- theme ----------

function applyTheme(theme) {
  // theme: 'dark' | 'light'
  document.documentElement.dataset.theme = theme;
  if (els.themeToggle) {
    const isDark = theme === 'dark';
    els.themeToggle.setAttribute(
      'aria-label',
      isDark ? 'Switch to light mode' : 'Switch to dark mode',
    );
    els.themeToggle.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  }
}

async function initTheme() {
  const { theme } = await chrome.storage.sync.get('theme');
  // Default to light unless the user has explicitly switched to dark.
  applyTheme(theme === 'dark' ? 'dark' : 'light');
}

async function toggleTheme() {
  const next =
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await chrome.storage.sync.set({ theme: next });
}

// ---------- activity log ----------

function classifyLogKind(text, running) {
  const t = (text || '').toLowerCase();
  if (/error|failed|could not|no \w+ found/.test(t)) return 'error';
  if (/^done\b/.test(t)) return 'done';
  if (/stopped|stop requested/.test(t)) return 'stopped';
  if (running) return 'running';
  return 'info';
}

function fmtTime(ms = Date.now()) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function appendLog(text, kind = 'info') {
  if (!els.logBody || !text) return;
  // Dedupe back-to-back identical messages.
  if (text === lastLoggedMessage) return;
  lastLoggedMessage = text;

  // Drop the empty placeholder on first real entry.
  const empty = els.logBody.querySelector('.log-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = `log-row log-${kind}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = fmtTime();

  const dot = document.createElement('span');
  dot.className = 'log-dot';
  dot.setAttribute('aria-hidden', 'true');

  const msg = document.createElement('span');
  msg.className = 'log-text';
  msg.textContent = text;

  li.append(time, dot, msg);
  els.logBody.appendChild(li);

  // Cap row count.
  while (els.logBody.children.length > MAX_LOG_ROWS) {
    els.logBody.firstElementChild.remove();
  }

  // Auto-scroll to newest.
  els.logBody.scrollTop = els.logBody.scrollHeight;
}

function clearLog() {
  if (!els.logBody) return;
  els.logBody.innerHTML = '';
  const empty = document.createElement('li');
  empty.className = 'log-empty';
  empty.textContent = 'No activity yet — click Start to begin.';
  els.logBody.appendChild(empty);
  lastLoggedMessage = null;
}

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) return;
  if (settings.rating) els.rating.value = settings.rating;
  if (typeof settings.comment === 'string') els.comment.value = settings.comment;
  els.fast.checked = settings.fast !== false;
  els.continuous.checked = settings.continuous !== false;
  updateCommentCount();
}

async function saveSettings() {
  const settings = {
    rating: els.rating.value,
    fast: els.fast.checked,
    continuous: els.continuous.checked,
    comment: els.comment.value.trim(),
  };
  await chrome.storage.sync.set({ settings });
  return settings;
}

function updateCommentCount() {
  if (!els.commentCount) return;
  els.commentCount.textContent = String(els.comment.value.length);
}

function setRunningUI(running) {
  isRunning = running;
  els.stop.disabled = !running;
  els.rating.disabled = running;
  els.fast.disabled = running;
  els.continuous.disabled = running;
  els.comment.disabled = running;
  els.chips.forEach((c) => (c.disabled = running));
  updateStartButton();
}

function updateStartButton() {
  // Start is disabled while running, OR when the active tab isn't on
  // the FacultyList page (proactive UX rather than failing on click).
  els.start.disabled = isRunning || !onCorrectPage;
}

function setPageBanner(visible) {
  els.pageBanner.hidden = !visible;
}

function renderState(state) {
  if (!state) {
    els.status.textContent = 'Idle.';
    els.bar.style.width = '0%';
    setStatusDot('idle');
    setRunningUI(false);
    return;
  }
  const { running, message, current, total } = state;
  const text = message || (running ? 'Working…' : 'Idle.');
  els.status.textContent = text;

  if (total > 0) {
    const pct = Math.min(100, Math.round((current / total) * 100));
    els.bar.style.width = pct + '%';
  } else {
    els.bar.style.width = running ? '5%' : '0%';
  }

  if (running) {
    setStatusDot('running');
  } else if (/^done\b/i.test(text) || (total > 0 && current >= total)) {
    setStatusDot('done');
  } else if (/error|failed|could not|no \w+ found/i.test(text)) {
    setStatusDot('error');
  } else {
    setStatusDot('idle');
  }

  // Append to the activity log (deduped by message inside appendLog).
  appendLog(text, classifyLogKind(text, running));

  setRunningUI(!!running);
}

async function refreshState() {
  const { runState } = await chrome.storage.local.get('runState');
  renderState(runState);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshActiveTabState() {
  const tab = await getActiveTab();
  const url = tab?.url || '';
  onCorrectPage = FACULTY_LIST_URL.test(url);
  setPageBanner(!onCorrectPage);
  updateStartButton();
}

async function handleStart() {
  if (starting || els.start.disabled) return;
  starting = true;
  // Lock the button immediately — don't wait for the storage round-trip
  // from background to disable it via setRunningUI.
  els.start.disabled = true;

  try {
    const settings = await saveSettings();
    if (!settings.comment) {
      els.status.textContent = 'Please enter a comment before starting.';
      setStatusDot('error');
      els.comment.focus();
      els.start.disabled = false; // re-enable on validation fail
      return;
    }

    const tab = await getActiveTab();
    if (!tab || !FACULTY_LIST_URL.test(tab.url || '')) {
      setPageBanner(true);
      onCorrectPage = false;
      updateStartButton();
      return;
    }

    // Auto-loop: content.js drives one teacher at a time, navigates
    // back to FacultyList after each submit, picks the next pending
    // row, and repeats until none remain.
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

    try {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'BAUET_START', settings });
      } catch {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        await chrome.tabs.sendMessage(tab.id, { type: 'BAUET_START', settings });
      }
    } catch (err) {
      // Both delivery attempts failed — roll back runState so the UI
      // doesn't stay stuck on "Starting…" with Stop as the only escape.
      console.warn('[bauet] could not deliver BAUET_START:', err);
      await chrome.storage.local.set({
        runState: {
          running: false,
          message:
            'Could not start — Chrome blocked the content script. ' +
            'Reload the FacultyList page and try again.',
          current: 0,
          total: 0,
        },
      });
    }
  } finally {
    starting = false;
  }
}

async function handleStop() {
  if (els.stop.disabled) return;
  const tab = await getActiveTab();
  const { runState } = await chrome.storage.local.get('runState');
  await chrome.storage.local.set({
    runState: {
      ...(runState || {}),
      running: false,
      message: 'Stopped by user.',
    },
  });
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'BAUET_STOP' });
    } catch {
      /* tab may have navigated; storage flag is enough */
    }
  }
}

els.start.addEventListener('click', handleStart);
els.stop.addEventListener('click', handleStop);
els.themeToggle?.addEventListener('click', toggleTheme);
els.logClear?.addEventListener('click', clearLog);
els.bannerLink?.addEventListener('click', () => {
  chrome.tabs.create({
    url: 'https://iems.bauet.ac.bd/Student/FacultyEvaluation/FacultyEvaluationManager',
  });
});

els.comment.addEventListener('input', updateCommentCount);

// Quick-fill chips: replace comment with the preset and persist.
els.chips.forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    els.comment.value = btn.dataset.comment || '';
    updateCommentCount();
    await saveSettings();
  });
});

// Keyboard shortcuts: Cmd/Ctrl+Enter to start, Esc to stop.
document.addEventListener('keydown', (e) => {
  const isMeta = e.metaKey || e.ctrlKey;
  if (isMeta && e.key === 'Enter') {
    e.preventDefault();
    handleStart();
  } else if (e.key === 'Escape' && isRunning) {
    e.preventDefault();
    handleStop();
  }
});

// React to storage changes (live progress from content.js).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.runState) {
    renderState(changes.runState.newValue);
  }
});

// Keep the start button + banner in sync with the active tab.
chrome.tabs.onActivated.addListener(refreshActiveTabState);
chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    refreshActiveTabState();
  }
});
chrome.windows?.onFocusChanged?.addListener(refreshActiveTabState);

(async function init() {
  await initTheme();
  await loadSettings();
  await refreshState();
  await refreshActiveTabState();
})();
