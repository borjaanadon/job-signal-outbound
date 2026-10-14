/**
 * Daily job: TheirStack -> HubSpot -> CRM -> mail. Fully deterministic, zero model calls.
 *
 * Run by hand from the editor:
 *   setup()        once: creates the CRM and state spreadsheets and the triggers
 *   checkConfig()  checks keys, HubSpot pipelines and credits. 0 credits
 *   testRun()      real run capped at 5 credits that writes NOTHING: sends you the preview mail
 *   runDaily()     what the trigger runs (Mon-Fri)
 *   measurePool()  how big is the pool with the current filters (1 credit per count)
 */

function runDaily() { return run_({ mode: 'daily', write: true }); }
function testRun() { return run_({ mode: 'test', write: false, cap: 5 }); }

function run_(opts) {
  const weekday = Number(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'u')); // 1 = Monday
  if (opts.mode === 'daily' && weekday > 5) return; // weekend: no log, no mail
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // another run is in progress
  const res = { added: [], blocked: [], outOfIcp: [], closed: [], credits: 0, creditsMonth: null, fetched: 0,
    dropped: { alreadySeen: 0, perCompanyCap: 0, cooldown: 0 }, window: 0, warnings: [] };
  let state = null;
  try {
    const props = PropertiesService.getScriptProperties();
    const tsKey = props.getProperty('THEIRSTACK_KEY');
    const hsToken = props.getProperty('HUBSPOT_TOKEN');
    if (!tsKey || !hsToken) throw new Error('Missing THEIRSTACK_KEY or HUBSPOT_TOKEN in Script properties');

    // HubSpot first: if the deal config does not match, stop BEFORE spending credits.
    const hs = hsContext_(hsToken);

    if (CONFIG.budget.paused) {
      res.warnings.push('Paused (CONFIG.budget.paused = true). Nothing fetched today.');
      return;
    }

    // Monthly brake
    res.creditsMonth = tsCreditsThisMonth_(tsKey);
    if (res.creditsMonth != null && res.creditsMonth >= CONFIG.budget.max_credits_per_month) {
      res.warnings.push('Monthly brake: ' + res.creditsMonth + ' credits already spent this month (cap ' +
        CONFIG.budget.max_credits_per_month + '). Nothing fetched today.');
      return;
    }

    state = loadState_();
    const last = props.getProperty('LAST_RUN_DATE');
    res.window = !last ? CONFIG.freshness.first_run_days
      : Math.min(CONFIG.freshness.max_window_days,
        Math.max(CONFIG.freshness.min_window_days, Math.ceil((Date.now() - new Date(last).getTime()) / 864e5)));

    const crm = crmSheet_();
    crmCheckColumns_(crm);
    const inCrm = crmJobIds_(crm);
    const amKey = props.getProperty('AMPLEMARKET_KEY');
    if (!amKey) res.warnings.push('No AMPLEMARKET_KEY: headcount of companies unknown to TheirStack is not checked.');
    const exclude = domainsInCooldown_(state);
    const takenToday = {}; // company key -> true (1 posting per company per run)
    let budget = opts.cap || CONFIG.budget.max_credits_per_run;
    // Never above what is left in the month (with two runs per night the brake could be overshot)
    if (res.creditsMonth != null) budget = Math.min(budget, Math.max(0, CONFIG.budget.max_credits_per_month - res.creditsMonth));
    const crmRows = [], newSeen = [], newCompanies = [];
    const todayIso = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');

    const t0 = Date.now();
    let cut = false;
    // Per-ICP cap over this run's budget
    const icpCap = {}, icpSpent = {};
    Object.keys(CONFIG.budget.max_share_per_icp || {}).forEach(function (k) { icpCap[k] = Math.floor(budget * CONFIG.budget.max_share_per_icp[k]); });
    // Market first, then the ICP passes inside each market
    const plan = [];
    CONFIG.markets.forEach(function (m) { CONFIG.passes.forEach(function (ps) { plan.push({ market: m, pass: ps }); }); });
    const marketSpent = {};
    res.byMarket = marketSpent;
    for (let p = 0; p < plan.length && budget > 0 && !cut; p++) {
      const pass = plan[p].pass, market = plan[p].market;
      let available = budget;
      if (icpCap[pass.icp] != null) available = Math.min(available, icpCap[pass.icp] - (icpSpent[pass.icp] || 0));
      if (market.max_credits != null) available = Math.min(available, market.max_credits - (marketSpent[market.name] || 0));
      if (available <= 0) continue;
      const r = tsFetchPass_(pass.icp, pass.priority, res.window, exclude, available, tsKey, market);
      icpSpent[pass.icp] = (icpSpent[pass.icp] || 0) + r.credits;
      marketSpent[market.name] = (marketSpent[market.name] || 0) + r.credits;
      budget -= r.credits;
      res.credits += r.credits;
      res.fetched += r.postings.length;

      r.postings.forEach(function (o) {
        if (cut || Date.now() - t0 > CONFIG.max_runtime_ms) { cut = true; res.unprocessed = (res.unprocessed || 0) + 1; return; }
        const id = String(o.id);
        if (state.seen[id] || inCrm[id]) { res.dropped.alreadySeen++; return; }
        state.seen[id] = true;
        newSeen.push([id, todayIso]);

        const key = companyKey_(o);
        if (takenToday[key]) { res.dropped.perCompanyCap++; return; }
        if (inCooldown_(state, key)) { res.dropped.cooldown++; return; }

        const dom = domain_(o);
        const name = (o.company_object && o.company_object.name) || o.company || '';
        const now = new Date();
        const drop = function (reason) {
          takenToday[key] = true;
          res.outOfIcp.push({ company: name, icp: pass.icp, reason: reason });
          newCompanies.push([key, dom, 'HS', now, reason]);
          state.companies[key] = { domain: dom, icp: 'HS', date: now, reason: reason };
        };
        if (isExcludedCompany_(name)) return drop('not ICP by name');
        if (isMultinationalDomain_(dom)) return drop('multinational by domain (' + dom + ')');

        // Closed posting: drop the posting, not the company (it may have another one in this run)
        if (CONFIG.liveness.check && postingStatus_(o.url || o.final_url || '') === 'CLOSED') {
          res.closed.push({ company: name, icp: pass.icp, role: o.job_title });
          return;
        }
        takenToday[key] = true;

        const s = hsScreen_(hs, dom, name);
        if (s.blocked) {
          res.blocked.push({ company: name, icp: pass.icp, reason: s.reason });
          newCompanies.push([key, dom, 'HS', now, s.reason]);
          state.companies[key] = { domain: dom, icp: 'HS', date: now, reason: s.reason };
          return;
        }
        // Unknown headcount in TheirStack: ask Amplemarket (local subsidiaries of multinationals slip through here)
        const empl = o.company_object && o.company_object.employee_count;
        if (amKey && CONFIG.amplemarket.check_size_if_missing && (empl == null || empl === '') && dom) {
          const t = amHeadcount_(amKey, dom);
          const max = maxEmployees_(pass.icp, market);
          if (t != null && t > max) return drop(t + ' employees per Amplemarket (cap ' + pass.icp + ' = ' + max + ')');
          if (t != null && o.company_object) o.company_object.employee_count = t;
        }
        crmRows.push(crmRow_(o, pass.icp, s));
        res.added.push({ company: name, icp: pass.icp, role: o.job_title, url: o.url || o.final_url || '',
          contact: ((o.hiring_team || []).filter(validContact_)[0] || {}).full_name || '' });
        newCompanies.push([key, dom, pass.icp, now, 'queued']);
        state.companies[key] = { domain: dom, icp: pass.icp, date: now, reason: 'queued' };
        // Exclude the company in this run's later passes too
        if (dom) exclude.push(dom);
      });
    }

    if (cut) res.warnings.push('Run cut by time: ' + (res.unprocessed || 0) +
      ' fetched postings left unprocessed (not marked as seen). Run again to pick them up.');
    if (opts.write) {
      // CRM first, state after. If the CRM write fails nothing is marked as seen, so no posting
      // is lost (it would be paid again, but never skipped).
      crmAppend_(crm, crmRows);
      appendRows_(state.book, 'seen_postings', newSeen);
      appendRows_(state.book, 'companies', newCompanies);
      props.setProperty('LAST_RUN_DATE', new Date().toISOString());
    }
  } catch (e) {
    res.error = e && e.stack ? e.stack : String(e);
  } finally {
    try { writeLog_(state, opts, res); } catch (e2) { res.warnings.push('Could not write the log: ' + e2); }
    sendRunMail_(opts, res);
    lock.releaseLock();
  }
  if (res.error) throw new Error(res.error);
}

function writeLog_(state, opts, res) {
  const book = state ? state.book : stateBook_();
  const byIcp = function (k) { return res.added.filter(function (x) { return x.icp === k; }).length; };
  appendRows_(book, 'log', [[new Date(), opts.mode, res.window, res.credits, res.creditsMonth == null ? '' : res.creditsMonth,
    res.fetched, res.added.length, byIcp('A'), byIcp('B'), byIcp('C'), res.blocked.length,
    res.dropped.alreadySeen, res.dropped.perCompanyCap, res.dropped.cooldown, (res.error || res.warnings.join(' | ')).slice(0, 500)]]);
}

// ---------------------------------------------------------------- setup

function setup() {
  const props = PropertiesService.getScriptProperties();

  let stateId = props.getProperty('STATE_SHEET_ID');
  const state = stateId ? SpreadsheetApp.openById(stateId) : SpreadsheetApp.create('Job signals - State');
  if (!stateId) {
    props.setProperty('STATE_SHEET_ID', state.getId());
    state.getSheets()[0].setName('seen_postings');
  }
  ensureTabs_(state);

  let crmId = props.getProperty('CRM_SHEET_ID');
  const crm = crmId ? SpreadsheetApp.openById(crmId) : SpreadsheetApp.create('Job signals - CRM');
  if (!crmId) {
    props.setProperty('CRM_SHEET_ID', crm.getId());
    crm.getSheets()[0].setName(CONFIG.CRM_TAB);
  }
  ensureCrm_(crm);

  // Idempotent: deletes and recreates the project's triggers
  const handlers = ['runDaily', 'enrichDaily', 'collectEnrichment'];
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return handlers.indexOf(t.getHandlerFunction()) > -1; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  CONFIG.RUN_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(h).nearMinute(0).inTimezone(CONFIG.TIMEZONE).create();
  });
  CONFIG.amplemarket.enrich_hours.forEach(function (h) {
    ScriptApp.newTrigger('enrichDaily').timeBased().everyDays(1).atHour(h).nearMinute(0).inTimezone(CONFIG.TIMEZONE).create();
  });
  ScriptApp.newTrigger('collectEnrichment').timeBased().everyMinutes(15).create();

  Logger.log('State: ' + state.getUrl());
  Logger.log('CRM: ' + crm.getUrl());
  Logger.log('Triggers: runDaily at ' + CONFIG.RUN_HOURS.join(', ') + 'h, enrichDaily at ' + CONFIG.amplemarket.enrich_hours.join(', ') +
    'h (Mon-Fri, weekends skip themselves) and collectEnrichment every 15 min (only acts if a list is pending)');
}

function checkConfig() {
  const props = PropertiesService.getScriptProperties();
  const tsKey = props.getProperty('THEIRSTACK_KEY'), hsToken = props.getProperty('HUBSPOT_TOKEN');
  Logger.log('THEIRSTACK_KEY: ' + (tsKey ? 'OK' : 'MISSING') + ' · HUBSPOT_TOKEN: ' + (hsToken ? 'OK' : 'MISSING') +
    ' · AMPLEMARKET_KEY: ' + (props.getProperty('AMPLEMARKET_KEY') ? 'OK' : 'missing (step 4 off)'));
  if (tsKey) Logger.log('API credits spent this month: ' + tsCreditsThisMonth_(tsKey));
  if (hsToken) {
    const ctx = hsContext_(hsToken);
    Logger.log('Blocking deal stages (' + Object.keys(ctx.stages).length + '):');
    Object.keys(ctx.stages).forEach(function (k) { Logger.log('  ' + ctx.stages[k]); });
  }
  Logger.log('CRM: ' + crmSheet_().getLastRow() + ' rows in "' + CONFIG.CRM_TAB + '"');
}
