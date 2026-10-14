/**
 * Is the posting still open? Free: LinkedIn through the public jobs-guest endpoint (no login),
 * anything else with a GET and a search for closing markers. Only 'CLOSED' drops a posting:
 * when in doubt, it goes in.
 */
const UA_ = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const CLOSED_ = /oferta.{0,40}(no est[aá] disponible|ha caducado|finalizad|cerrad)|expired|no longer available|ya no est[aá] disponible/i;

function postingStatus_(url) {
  if (!url) return 'UNKNOWN';
  try {
    if (url.indexOf('linkedin.com') > -1) {
      const id = (url.match(/(\d{8,})/g) || []).pop();
      if (!id) return 'UNKNOWN';
      let r;
      for (let i = 0; i < 3; i++) {
        r = UrlFetchApp.fetch('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + id,
          { headers: { 'User-Agent': UA_ }, muteHttpExceptions: true });
        if (r.getResponseCode() !== 429) break;
        Utilities.sleep(10000);
      }
      const code = r.getResponseCode();
      if (code === 404) return 'CLOSED';
      if (code !== 200) return 'UNKNOWN';
      return /No longer accepting applications/i.test(r.getContentText()) ? 'CLOSED' : 'OPEN';
    }
    const r = UrlFetchApp.fetch(url, { headers: { 'User-Agent': UA_ }, muteHttpExceptions: true, followRedirects: true });
    const code = r.getResponseCode();
    if (code === 404 || code === 410) return 'CLOSED';
    // Visible text only: some job boards ship the "no longer available" translation inside
    // their scripts even when the posting is open.
    const visible = r.getContentText().replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    if (code === 200) return CLOSED_.test(visible) ? 'CLOSED' : 'OPEN';
    return 'UNKNOWN';
  } catch (e) {
    return 'UNKNOWN';
  } finally {
    Utilities.sleep(CONFIG.liveness.wait_ms);
  }
}

/** Multinational by domain (the company's or a contact's email). */
function isMultinationalDomain_(dom) {
  dom = String(dom || '').toLowerCase().replace(/^www\./, '');
  if (!dom) return false;
  return CONFIG.multinational_domains.some(function (d) { return dom === d || dom.slice(-(d.length + 1)) === '.' + d; });
}

function isExcludedCompany_(name) {
  return CONFIG.companies_excluded.some(function (p) { return new RegExp(p, 'i').test(name || ''); });
}
