/**
 * Step 4: contact and email through the Amplemarket API (docs.amplemarket.com).
 *
 *   - Email of a known person: a lead list of type "linkedin" with validate_email.
 *     ~85% came back deliverable in the first batch. It is ASYNCHRONOUS: create now, collect later.
 *   - Finding who to write to: /people/search with company_domains + person_titles.
 *     Never person_departments (too loose) and never a title+company lookup, which can
 *     glue one person's name to someone else's email.
 */

function amFetch_(key, method, path, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const opts = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + key } };
    if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
    const r = UrlFetchApp.fetch(CONFIG.amplemarket.url + path, opts);
    const code = r.getResponseCode();
    if (code === 429) { Utilities.sleep(5000 * attempt); continue; }
    if (code === 404) return null;
    if (code === 402) throw new Error('Amplemarket: out of credits (402)');
    if (code < 200 || code > 299) throw new Error('Amplemarket ' + method + ' ' + path + ' HTTP ' + code + ': ' + r.getContentText().slice(0, 300));
    return JSON.parse(r.getContentText());
  }
  throw new Error('Amplemarket: 429 after 3 attempts on ' + path);
}

/** Estimated headcount, or null if Amplemarket does not know the company. */
function amHeadcount_(key, domain) {
  if (!domain) return null;
  const c = amFetch_(key, 'get', '/companies/find?domain=' + encodeURIComponent(domain));
  return c && c.estimated_number_of_employees != null ? Number(c.estimated_number_of_employees) : null;
}

/** People on a domain with any of those titles, in Amplemarket's order. */
function amSearch_(key, domain, titles, n) {
  const j = amFetch_(key, 'post', '/people/search', {
    company_domains: [domain], person_titles: titles, page: 1, page_size: Math.max(n * 3, 5),
  });
  return ((j && j.results) || []).filter(function (p) {
    // A bare "Owner" matches Product Owner: filtered again on arrival just in case
    return p.linkedin_url && !/product owner/i.test(p.title || '') && isDecisionMaker_(p.title) !== false;
  });
}

function amCreateList_(key, urls) {
  return amFetch_(key, 'post', '/lead-lists', {
    name: 'Job signals ' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'),
    shared: false, visible: true, owner: CONFIG.amplemarket.owner || Session.getEffectiveUser().getEmail(), type: 'linkedin',
    leads: urls.map(function (u) { return { linkedin_url: u }; }),
    options: { validate_email: true, enrich: true, reveal_phone_numbers: false },
  });
}

/** Returns { status, leads } walking every page. */
function amReadList_(key, id) {
  let leads = [], after = null, status = null;
  for (let i = 0; i < 50; i++) {
    const j = amFetch_(key, 'get', '/lead-lists/' + id + '?page[size]=100' + (after ? '&page[after]=' + encodeURIComponent(after) : ''));
    if (!j) throw new Error('Amplemarket: lead list ' + id + ' does not exist');
    status = j.status;
    if (status !== 'completed') return { status: status, leads: [] };
    leads = leads.concat(j.leads || []);
    const next = j._links && j._links.next && j._links.next.href;
    const m = next && /page\[after\]=([^&]+)/.exec(decodeURIComponent(next));
    if (!m) break;
    after = m[1];
  }
  return { status: status, leads: leads };
}

/**
 * Comparison key for a LinkedIn profile. One provider returns the slug percent-encoded
 * and the other in plain text: without decoding and normalizing, about a third did not match.
 */
function linkedinKey_(url) {
  let s = String(url || '').trim().toLowerCase();
  try { s = decodeURIComponent(s); } catch (e) { /* already decoded */ }
  const m = /linkedin\.com\/in\/([^/?#]+)/.exec(s.normalize('NFC'));
  return m ? m[1].replace(/\/+$/, '') : '';
}

/**
 * Can this person decide? true = yes, false = no, null = unknown (empty title).
 * First what never decides (junior, interns), then words of authority, then execution roles.
 */
function isDecisionMaker_(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  if (/\b(junior|jr\.?|intern|internship|trainee|becari[oa]|pr[aá]cticas|tirocin\w*|stagiaire|student|estudiante)\b/i.test(t)) return false;
  if (/\b(head|director|directora|direttore|chief|c[ets]o|coo|cpo|chro|vp|vice ?president|founder|co-?founder|fundador\w*|fondatore|owner|propietari[oa]|titolare|managing partner|socio|socia|partner|amministratore|general manager|country manager|responsable|responsabile|jefe|jefa|manager|gerente|lead)\b/i.test(t) &&
      !/\b(talent|people|business|hr) partner\b/i.test(t)) return true;
  if (/\b(recruiter|reclutador\w*|sourc\w*|specialist|especialista|coordinat\w*|coordinador\w*|assistant|asistente|assistente|consultant|consultor\w*|generalist|t[eé]cnic[oa]|analyst|analista|administrativ\w*|partner|executive|scout|engineer|developer|ingenier\w*|desarrollador\w*)\b/i.test(t)) return false;
  return null;
}

/** A hiring_team contact is junk if its slug is not a person or its known title cannot decide. */
function validContact_(p) {
  if (!p) return false;
  const name = String(p.full_name || '').trim().toLowerCase();
  if (CONFIG.junk_contacts.names.indexOf(name) > -1) return false;
  const slug = linkedinKey_(p.linkedin_url);
  if (slug.length < CONFIG.junk_contacts.min_linkedin_slug) return false; // /in/en/, /in/es/...
  if (isDecisionMaker_(p.role || p.title) === false) return false;
  return true;
}
