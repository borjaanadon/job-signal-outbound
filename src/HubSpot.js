/**
 * Step 3: screen against HubSpot (read-only Private App token).
 *
 * A company is BLOCKED if:
 *   1. any company record (by domain or by name: duplicates exist) has a commercial
 *      lifecycle stage (customer / opportunity / SQL / MQL), or
 *   2. the company or any contact on its domain was contacted in the last
 *      CONFIG.hubspot.recent_contact_days days, or
 *   3. it has a deal in a blocking stage, through the associated company OR through
 *      a contact on its domain. The contact path matters: most deals have no company associated.
 *
 * "Exists in HubSpot" does NOT block. Most records are leads with no activity, and
 * blocking on presence excludes perfectly valid companies.
 */

const HS_API = 'https://api.hubapi.com';

function hsFetch_(ctx, method, path, body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    Utilities.sleep(CONFIG.hubspot.wait_ms);
    const opts = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ctx.token } };
    if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
    const r = UrlFetchApp.fetch(HS_API + path, opts);
    const code = r.getResponseCode();
    if (code === 429) { Utilities.sleep(1500 * attempt); continue; }
    if (code !== 200) throw new Error('HubSpot ' + method + ' ' + path + ' HTTP ' + code + ': ' + r.getContentText().slice(0, 300));
    return JSON.parse(r.getContentText());
  }
  throw new Error('HubSpot: 429 after 4 attempts on ' + path);
}

function hsSearch_(ctx, object, filterGroups, props, limit) {
  const j = hsFetch_(ctx, 'post', '/crm/v3/objects/' + object + '/search',
    { filterGroups: filterGroups, properties: props, limit: limit || 100 });
  return j.results || [];
}

/**
 * Resolves the blocking stages to IDs. Stage labels repeat across pipelines
 * ("Closed Won" is usually in several), so they are resolved INSIDE their pipeline.
 * Fail closed: a label that does not exist throws, because carrying on without it
 * would silently disable the deal filter.
 */
function hsContext_(token) {
  const ctx = { token: token, stages: {} };
  const pipes = hsFetch_(ctx, 'get', '/crm/v3/pipelines/deals').results || [];
  const norm = function (s) { return String(s || '').trim().toLowerCase(); };
  CONFIG.hubspot.deals_block.forEach(function (rule) {
    const p = pipes.filter(function (x) { return norm(x.label) === norm(rule.pipeline); })[0];
    if (!p) throw new Error('HubSpot config: pipeline "' + rule.pipeline + '" does not exist');
    const stages = p.stages || [];
    if (rule.stages === '*') {
      stages.forEach(function (s) { ctx.stages[s.id] = p.label.trim() + ' / ' + s.label.trim(); });
    } else {
      rule.stages.forEach(function (st) {
        const s = stages.filter(function (x) { return norm(x.label) === norm(st); })[0];
        if (!s) throw new Error('HubSpot config: stage "' + st + '" does not exist in "' + rule.pipeline + '"');
        ctx.stages[s.id] = p.label.trim() + ' / ' + s.label.trim();
      });
    }
  });
  return ctx;
}

function chunk_(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Returns { blocked, reason, lastTouch } for a company.
 * lastTouch = most recent contact date (yyyy-mm-dd), even if old: it goes to the CRM
 * so whoever sends knows there is history.
 */
function hsScreen_(ctx, domain, name) {
  const limit = Date.now() - CONFIG.hubspot.recent_contact_days * 864e5;
  let latest = 0;
  const seen = function (v) { const t = v ? new Date(v).getTime() : 0; if (t > latest) latest = t; return t; };
  const date = function () { return latest ? new Date(latest).toISOString().slice(0, 10) : ''; };

  // 1 and 2: company records by domain and by exact name
  const groups = [];
  if (domain) groups.push({ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] });
  if (name) groups.push({ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] });
  const companies = groups.length
    ? hsSearch_(ctx, 'companies', groups, ['name', 'domain', 'lifecyclestage', 'notes_last_contacted'], 20) : [];
  for (let i = 0; i < companies.length; i++) {
    const p = companies[i].properties || {};
    if (CONFIG.hubspot.lifecycle_blocks.indexOf(p.lifecyclestage) > -1) {
      return { blocked: true, reason: 'Lifecycle ' + p.lifecyclestage, lastTouch: date() };
    }
    if (seen(p.notes_last_contacted) > limit) {
      return { blocked: true, reason: 'Company contacted on ' + date(), lastTouch: date() };
    }
  }

  // 2: contacts on the domain (not for personal email domains)
  let contactsWithDeals = [];
  if (domain && CONFIG.hubspot.personal_domains.indexOf(domain) === -1) {
    const contacts = hsSearch_(ctx, 'contacts',
      [{ filters: [{ propertyName: 'hs_email_domain', operator: 'EQ', value: domain }] }],
      ['email', 'notes_last_contacted', 'num_associated_deals'], 100);
    for (let i = 0; i < contacts.length; i++) {
      const p = contacts[i].properties || {};
      if (seen(p.notes_last_contacted) > limit) {
        return { blocked: true, reason: 'Contact ' + (p.email || '') + ' contacted on ' + date(), lastTouch: date() };
      }
    }
    // Empty properties are omitted from the response: a missing num_associated_deals means 0
    contactsWithDeals = contacts.filter(function (c) { return Number((c.properties || {}).num_associated_deals || 0) > 0; });
  }

  // 3: deals by associated company and by associated contact, in batches of 5 filter groups
  const assocs = companies.map(function (e) { return { propertyName: 'associations.company', operator: 'EQ', value: e.id }; })
    .concat(contactsWithDeals.map(function (c) { return { propertyName: 'associations.contact', operator: 'EQ', value: c.id }; }));
  const batches = chunk_(assocs, 5);
  for (let i = 0; i < batches.length; i++) {
    const deals = hsSearch_(ctx, 'deals', batches[i].map(function (f) { return { filters: [f] }; }),
      ['dealname', 'pipeline', 'dealstage'], 100);
    for (let k = 0; k < deals.length; k++) {
      const st = (deals[k].properties || {}).dealstage;
      if (ctx.stages[st]) {
        return { blocked: true, reason: 'Deal "' + (deals[k].properties.dealname || '') + '" in ' + ctx.stages[st], lastTouch: date() };
      }
    }
  }
  return { blocked: false, reason: '', lastTouch: date() };
}
