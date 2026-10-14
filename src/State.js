/**
 * Job state lives in its OWN spreadsheet, deliberately outside the CRM: the CRM is edited
 * by hand and closed postings get deleted, so it cannot be the memory of what was already seen.
 *
 *   seen_postings : job_id | date
 *   companies     : key | domain | icp | date | reason    (cooldown)
 *   log           : one row per run
 *   enriched      : job_id | date | result                 (one Amplemarket pass per posting)
 */

const TABS = {
  seen_postings: ['job_id', 'date'],
  companies: ['key', 'domain', 'icp', 'date', 'reason'],
  log: ['ts', 'mode', 'window_days', 'credits', 'credits_month', 'fetched', 'new', 'A', 'B', 'C',
    'blocked_hubspot', 'already_seen', 'per_company_cap', 'cooldown', 'error'],
  enriched: ['job_id', 'date', 'result'],
};

/** Creates any missing tab, and the header of any empty one. */
function ensureTabs_(book) {
  Object.keys(TABS).forEach(function (t) {
    const sh = book.getSheetByName(t) || book.insertSheet(t);
    if (sh.getRange(1, 1).getValue() !== '') return;
    sh.getRange(1, 1, 1, TABS[t].length).setValues([TABS[t]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
}

function stateBook_() {
  const id = PropertiesService.getScriptProperties().getProperty('STATE_SHEET_ID');
  if (!id) throw new Error('Missing STATE_SHEET_ID: run setup() first');
  return SpreadsheetApp.openById(id);
}

function readTab_(book, tab) {
  const sh = book.getSheetByName(tab);
  const n = sh.getLastRow();
  return n < 2 ? [] : sh.getRange(2, 1, n - 1, TABS[tab].length).getValues();
}

function appendRows_(book, tab, rows) {
  if (!rows.length) return;
  const sh = book.getSheetByName(tab);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function loadState_() {
  const book = stateBook_();
  const seen = {};
  readTab_(book, 'seen_postings').forEach(function (r) { seen[String(r[0])] = true; });
  // Latest date per company (the tab is append-only: the most recent row wins)
  const companies = {};
  readTab_(book, 'companies').forEach(function (r) {
    const d = r[3] instanceof Date ? r[3] : new Date(r[3]);
    const prev = companies[r[0]];
    if (!prev || d > prev.date) companies[r[0]] = { domain: r[1], icp: r[2], date: d, reason: r[4] };
  });
  return { book: book, seen: seen, companies: companies };
}

function cooldownDays_(icp) {
  return (CONFIG.icps[icp] && CONFIG.icps[icp].cooldown_days) || 30; // 'HS' (blocked by the CRM) = 30
}

function inCooldown_(state, key) {
  const e = state.companies[key];
  return !!e && (Date.now() - e.date.getTime()) < cooldownDays_(e.icp) * 864e5;
}

/** Domains in cooldown, to exclude them at the source (company_domain_not). */
function domainsInCooldown_(state) {
  const out = {};
  Object.keys(state.companies).forEach(function (k) {
    const e = state.companies[k];
    if (e.domain && inCooldown_(state, k)) out[e.domain] = true;
  });
  return Object.keys(out);
}
