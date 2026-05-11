// Background service worker.
// The actual automation lives in content.js so it can survive (re-run on)
// each full page navigation. The worker just bootstraps default settings,
// wires the side-panel behavior, and stops the run if the user navigates
// away from the FacultyEvaluation area.

// Make the toolbar icon open the Side Panel (Chrome 114+) instead of a
// transient popup. Wrapped in a try because the API isn't present on
// older Chrome versions; on those, the action click is a no-op and the
// user can still open the panel via the side-panel chooser.
try {
  chrome.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[bauet] sidePanel setup failed:', err));
} catch (err) {
  console.warn('[bauet] sidePanel API unavailable:', err);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get('settings');
  let next = settings;

  if (!next) {
    next = {
      rating: 'Random',
      fast: true,
      continuous: true,
      comment: 'Good',
    };
  } else {
    // Patch in any defaults that were missing (older installs).
    if (next.comment === 'comment') next = { ...next, comment: 'Good' };
    if (typeof next.continuous !== 'boolean')
      next = { ...next, continuous: true };
  }

  if (next !== settings) {
    await chrome.storage.sync.set({ settings: next });
  }

  // ---- One-time migrations (gated by flag so they don't keep firing) ----
  const { migrations } = await chrome.storage.local.get('migrations');
  const done = migrations || {};

  // v3.2.1 — Fast mode is the new default. Force it on once for any user
  // whose stored settings have it explicitly off, then mark the migration
  // as complete so a future toggle-off stays off.
  if (!done.fastOnDefault_v321) {
    const cur = (await chrome.storage.sync.get('settings')).settings;
    if (cur && cur.fast === false) {
      await chrome.storage.sync.set({
        settings: { ...cur, fast: true },
      });
    }
    done.fastOnDefault_v321 = true;
    await chrome.storage.local.set({ migrations: done });
  }

  await chrome.storage.local.set({
    runState: { running: false, message: 'Idle.', current: 0, total: 0 },
  });
});

// If the user navigates the active tab away from iems.bauet.ac.bd while
// a run is active, stop the run so we don't leave stale state on screen.
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' || !tab.url) return;
  const onSite = /iems\.bauet\.ac\.bd\/Student\/FacultyEvaluation\//i.test(
    tab.url,
  );
  if (onSite) return;
  const { runState } = await chrome.storage.local.get('runState');
  if (runState && runState.running) {
    await chrome.storage.local.set({
      runState: {
        running: false,
        message: 'Stopped: navigated away from FacultyEvaluation.',
        current: runState.current || 0,
        total: runState.total || 0,
      },
    });
  }
});
