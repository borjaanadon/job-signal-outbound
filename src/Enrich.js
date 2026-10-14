/**
 * Step 4, automated: contacts and emails for the rows the job created.
 *
 *   enrichDaily()        Mon-Fri, after detection. For each new row not yet enriched:
 *                        1. fills missing contacts with /people/search (titles per ICP)
 *                        2. puts every LinkedIn without email into ONE validated lead list
 *   collectEnrichment()  every 15 min. If a list is pending and complete, writes the
 *                        deliverable emails into the CRM and sends the summary.
 *
 * Only touches job rows still in "Not Contacted", and only empty contact cells:
 * it never overwrites what you wrote by hand. Matching is by LinkedIn, not by row
 * number, so deleting rows in between breaks nothing.
 */

function enrichDaily() {
  const weekday = Number(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'u'));
  if (weekday > 5) return;
  return enrich_();
}

function enrich_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  const res = { rows: 0, searched: 0, found: 0, nobody: [], urls: 0, warnings: [] };
  try {
    const props = PropertiesService.getScriptProperties();
    const key = props.getProperty('AMPLEMARKET_KEY');
    if (!key) return; // step 4 is optional
    if (props.getProperty('AM_PENDING')) {
      res.warnings.push('A list was still pending: collecting it before creating another.');
      collect_(key, true);
      // Never create a new list on top of a pending one (its emails would be lost)
      for (let i = 0; i < 3 && props.getProperty('AM_PENDING'); i++) { Utilities.sleep(20000); collect_(key, true); }
      if (props.getProperty('AM_PENDING')) {
        res.warnings.push('The previous list is still processing: this pass creates none. Pending rows go into the next one.');
        sendEnrichMail_(res, null);
        return;
      }
    }
    const sh = crmSheet_();
    crmCheckColumns_(sh);
    const book = stateBook_();
    ensureTabs_(book);
    const retry = JSON.parse(props.getProperty('AM_RETRY') || '{}');
    const done = {};
    readTab_(book, 'enriched').forEach(function (r) { done[String(r[0])] = true; });

    const urls = {}, mark = [];
    const t0 = Date.now();
    let cut = 0;
    autoRows_(sh).forEach(function (r) {
      const v = r.v, jobId = String(v[COL.jobId]);
      if ((done[jobId] && !retry[jobId]) || v[COL.outreachStatus] !== 'Not Contacted' || !v[COL.domain]) return;
      // Time brake: whatever does not fit stays unmarked and the next pass picks it up
      if (Date.now() - t0 > CONFIG.amplemarket.max_runtime_ms) { cut++; return; }
      delete retry[jobId];
      res.rows++;
      const icp = v[COL.icp], empl = Number(v[COL.employees]) || null;
      const n = contactsNeeded_(icp, empl);
      const has = CONTACTS.filter(function (b) { return v[b + 3]; }).length;

      if (has < n) {
        res.searched++;
        const seen = CONTACTS.map(function (b) { return linkedinKey_(v[b + 3]); }).filter(String);
        const fresh = [];
        titlesFor_(icp, empl).some(function (titles) {
          amSearch_(key, v[COL.domain], titles, n).forEach(function (p) {
            const kl = linkedinKey_(p.linkedin_url);
            if (!kl || seen.indexOf(kl) > -1 || has + fresh.length >= n) return;
            seen.push(kl);
            fresh.push(p);
          });
          return has + fresh.length >= n; // next title family only if still short
        });
        let i = 0;
        CONTACTS.forEach(function (b) {
          if (v[b + 3] || i >= fresh.length) return;
          const p = fresh[i++];
          // The search email is not validated: leave it empty and let the lead list bring it
          v[b] = p.name || ''; v[b + 1] = p.title || ''; v[b + 3] = p.linkedin_url;
          res.found++;
        });
        if (!fresh.length && !has) res.nobody.push(v[COL.company]);
        sh.getRange(r.row, CONTACTS[0] + 1, 1, CRM_COLS - CONTACTS[0]).setValues([v.slice(CONTACTS[0])]);
      }
      CONTACTS.forEach(function (b) { if (v[b + 3] && !v[b + 2]) urls[linkedinKey_(v[b + 3])] = v[b + 3]; });
      mark.push([jobId, new Date(), 'searched']);
    });

    if (cut) res.warnings.push('Cut by time: ' + cut + ' rows left for the next pass.');
    const list = Object.keys(urls).map(function (k) { return urls[k]; });
    res.urls = list.length;
    if (list.length) {
      const l = amCreateList_(key, list);
      props.setProperty('AM_PENDING', JSON.stringify({ id: l.id, ts: Date.now(), urls: list.length }));
    }
    appendRows_(book, 'enriched', mark);
    props.setProperty('AM_RETRY', JSON.stringify(retry));
    // It usually takes a couple of minutes: try to collect now, otherwise collectEnrichment does it
    for (let i = 0; i < 3 && props.getProperty('AM_PENDING'); i++) {
      Utilities.sleep(20000);
      collect_(key, false, res);
    }
    if (props.getProperty('AM_PENDING')) sendEnrichMail_(res, null);
  } catch (e) {
    res.error = e && e.stack ? e.stack : String(e);
    sendEnrichMail_(res, null);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** How many contacts per company: tiny agency = 1 · agency = 2 · B and C from 30 employees = 3 · rest = 2. */
function contactsNeeded_(icp, empl) {
  const am = CONFIG.amplemarket;
  if (icp === 'A') return empl != null && empl < am.single_contact_threshold ? 1 : 2;
  if (empl != null && empl >= am.three_contacts_threshold) return 3;
  return 2;
}

/** Title families in order: move to the next one only if contacts are still missing. */
function titlesFor_(icp, empl) {
  const am = CONFIG.amplemarket;
  if (icp === 'A') return [am.founders.concat(am.partners)];
  if (icp === 'B' && (empl == null || empl < am.founder_threshold)) return [am.founders, am.talent];
  if (icp === 'B') return [am.technical, am.talent, am.founders]; // mid-size tech: hiring manager first
  return [am.talent, am.founders, am.technical]; // C
}

function collectEnrichment() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('AM_PENDING')) return; // the usual case: nothing to do
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try { collect_(props.getProperty('AMPLEMARKET_KEY'), true); } finally { lock.releaseLock(); }
}

/** If the pending list is complete, writes the emails. Returns true if it collected it. */
function collect_(key, sendMail, prevRes) {
  const props = PropertiesService.getScriptProperties();
  const pending = JSON.parse(props.getProperty('AM_PENDING') || 'null');
  if (!pending) return false;
  const list = amReadList_(key, pending.id);
  if (list.status !== 'completed') {
    if (Date.now() - pending.ts > 6 * 3600e3) {
      props.deleteProperty('AM_PENDING');
      sendEnrichMail_({ error: 'Lead list ' + pending.id + ' has not completed in 6 hours. Abandoned; check it in Amplemarket.' }, null);
    }
    return false;
  }
  const r = applyEmails_(list.leads);
  props.deleteProperty('AM_PENDING');
  if (sendMail || prevRes) sendEnrichMail_(prevRes || {}, r);
  return true;
}

function applyEmails_(leads) {
  const props = PropertiesService.getScriptProperties();
  const byLi = {};
  leads.forEach(function (l) { const k = linkedinKey_(l.linkedin_url || l.linkedin); if (k) byLi[k] = l; });
  const r = { deliverable: 0, other: {}, noEmail: 0, notDecider: 0, otherDomain: [], rows: 0 };
  const sh = crmSheet_();
  crmCheckColumns_(sh);
  const retry = JSON.parse(props.getProperty('AM_RETRY') || '{}');
  autoRows_(sh).forEach(function (row) {
    const v = row.v;
    let changed = false;
    const notes = [];
    CONTACTS.forEach(function (b) {
      const l = byLi[linkedinKey_(v[b + 3])];
      if (!l || v[b + 2]) return;
      const realTitle = l.title || v[b + 1];
      if (isDecisionMaker_(realTitle) === false) {
        notes.push('dropped, title cannot decide: ' + (v[b] || '') + ' (' + realTitle + ')');
        for (let i = 0; i < 4; i++) v[b + i] = '';
        r.notDecider++;
        retry[String(v[COL.jobId])] = true;
        changed = true;
        return;
      }
      const verdict = l.email_validation_result && l.email_validation_result.result;
      if (!l.email) { r.noEmail++; return; }
      if (verdict !== 'deliverable') { r.other[verdict || 'unvalidated'] = (r.other[verdict || 'unvalidated'] || 0) + 1; notes.push('email ' + (verdict || 'unvalidated') + ' dropped'); return; }
      const dom = l.email.split('@')[1].toLowerCase();
      // Multinational email on a "local" company: the row is not ICP, the email is not written
      if (isMultinationalDomain_(dom)) { notes.push('multinational email (' + dom + '): out of ICP, review'); r.otherDomain.push(v[COL.company] + ' (' + dom + ', multinational)'); return; }
      v[b + 2] = l.email;
      if (!v[b]) v[b] = [l.first_name, l.last_name].filter(String).join(' ');
      if (!v[b + 1]) v[b + 1] = l.title || '';
      if (v[COL.domain] && dom !== v[COL.domain] && dom.indexOf(v[COL.domain]) === -1) {
        notes.push('email on domain ' + dom + ', review');
        r.otherDomain.push(v[COL.company] + ' (' + dom + ')');
      }
      r.deliverable++;
      changed = true;
    });
    if (!changed && !notes.length) return;
    // The contact with an email always goes first
    const c1 = CONTACTS[0];
    CONTACTS.slice(1).forEach(function (b) {
      if (!v[c1 + 2] && v[b + 2]) {
        const a = v.slice(c1, c1 + 4), x = v.slice(b, b + 4);
        for (let i = 0; i < 4; i++) { v[c1 + i] = x[i]; v[b + i] = a[i]; }
      }
    });
    const hasEmail = CONTACTS.some(function (b) { return v[b + 2]; });
    v[COL.priority] = priority_(v[COL.icp], CONTACTS.some(function (b) { return v[b]; }));
    const STEP4 = /\s·\s(Missing email|No contact)[^·]*\(step 4\)/g;
    let note = String(v[COL.notes]);
    if (hasEmail) note = note.replace(STEP4, '') + ' · email Amplemarket';
    else if (v[c1]) note = note.replace(STEP4, '') + ' · Missing email (step 4)';
    notes.forEach(function (x) { if (note.indexOf(x) === -1) note += ' · ' + x; });
    v[COL.notes] = note;
    sh.getRange(row.row, COL.priority + 1).setValue(v[COL.priority]);
    sh.getRange(row.row, COL.notes + 1).setValue(v[COL.notes]);
    sh.getRange(row.row, c1 + 1, 1, CRM_COLS - c1).setValues([v.slice(c1)]);
    r.rows++;
  });
  props.setProperty('AM_RETRY', JSON.stringify(retry));
  return r;
}
