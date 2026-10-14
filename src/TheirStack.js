/**
 * Step 2: detect ICP job postings in TheirStack.
 *
 *   - 1 credit per posting RETURNED. The cap is per run, summed across pages.
 *   - 429 -> read ratelimit-reset and sleep; 3 attempts and stop.
 *   - Companies in cooldown are excluded AT THE SOURCE with company_domain_not,
 *     so you never pay for them.
 *   - job_id_not and discovered_at_gte return 500: do not use them.
 */

/** Headcount cap of an ICP in a market (extended markets use the wider cap). */
function maxEmployees_(icpKey, market) {
  const cfg = CONFIG.icps[icpKey];
  return (market && market.extended && cfg.max_employees_extended) || cfg.max_employees;
}

function tsQuery_(icpKey, priority, days, excludeDomains, limit, page, market) {
  const cfg = CONFIG.icps[icpKey];
  const extended = !!(market && market.extended);
  const q = {
    company_type: cfg.company_type,
    job_country_code_or: market ? market.countries : allCountries_(),
    posted_at_max_age_days: days,
    job_title_pattern_or: extended ? CONFIG.titles.concat(CONFIG.titles_extended) : CONFIG.titles,
    job_title_pattern_not: CONFIG.titles_excluded,
    // The _or_null suffix keeps companies with no headcount on file. Without it you lose
    // about a quarter of the volume, and precisely the smallest companies.
    max_employee_count_or_null: maxEmployees_(icpKey, market),
    limit: limit,
    page: page,
  };
  if (cfg.min_employees != null) q.min_employee_count_or_null = cfg.min_employees;
  // Industry is filtered by EXCLUSION: a positive filter drops every company with no industry on file.
  const industry = (extended && cfg.industry_extended) || cfg.industry;
  if (industry === 'exclude_non_tech_and_consulting') {
    q.industry_not = CONFIG.industries_excluded.concat(CONFIG.industries_consulting);
  } else if (industry === 'exclude_consulting') {
    q.industry_not = CONFIG.industries_consulting;
  } else if (industry === 'only_consulting') {
    q.industry_or = CONFIG.industries_consulting;
  }
  // property_exists_or is an OR, not an AND: priority mode passes hiring_team ALONE.
  q.property_exists_or = priority ? ['hiring_team'] : ['company_object.domain', 'company_object.linkedin_url'];
  if (excludeDomains.length) q.company_domain_not = excludeDomains;
  return q;
}

function allCountries_() {
  return CONFIG.markets.reduce(function (a, m) { return a.concat(m.countries); }, []);
}

function tsPost_(body, key) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = UrlFetchApp.fetch(CONFIG.theirstack.url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify(body),
    });
    const code = r.getResponseCode();
    if (code === 429) {
      const reset = Number(r.getHeaders()['ratelimit-reset'] || r.getHeaders()['Ratelimit-Reset'] || 60);
      Utilities.sleep(Math.min(reset + 3, 120) * 1000);
      continue;
    }
    if (code !== 200) throw new Error('TheirStack HTTP ' + code + ': ' + r.getContentText().slice(0, 400));
    return JSON.parse(r.getContentText());
  }
  throw new Error('TheirStack: 429 after 3 attempts');
}

/** Fetches postings for one pass until the budget or the pool runs out. Returns { postings, credits }. */
function tsFetchPass_(icpKey, priority, days, excludeDomains, budget, key, market) {
  const postings = [];
  let credits = 0;
  for (let page = 0; credits < budget; page++) {
    const limit = Math.min(CONFIG.theirstack.page_size, budget - credits);
    Utilities.sleep(CONFIG.theirstack.wait_between_calls_ms);
    const j = tsPost_(tsQuery_(icpKey, priority, days, excludeDomains, limit, page, market), key);
    const batch = j.data || [];
    credits += batch.length;
    batch.forEach(function (o) { postings.push(o); });
    if (batch.length < limit) break;
  }
  return { postings: postings, credits: credits };
}

/** API credits consumed in the current month (free endpoint). */
function tsCreditsThisMonth_(key) {
  const r = UrlFetchApp.fetch(CONFIG.theirstack.credits_url, {
    muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + key },
  });
  if (r.getResponseCode() !== 200) return null;
  const month = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM');
  return JSON.parse(r.getContentText())
    .filter(function (d) { return String(d.period_start || '').slice(0, 7) === month; })
    .reduce(function (s, d) { return s + (d.api_credits_consumed || 0); }, 0);
}

/**
 * Stable company key: LinkedIn URL > domain > name. The LinkedIn URL is the reliable
 * identifier; matching by name gives false positives across countries.
 */
function companyKey_(o) {
  const li = ((o.company_object && o.company_object.linkedin_url) || o.company_linkedin_url || '').replace(/\/+$/, '').toLowerCase();
  return li || domain_(o) || String(o.company || '').trim().toLowerCase();
}

function domain_(o) {
  return String((o.company_object && o.company_object.domain) || o.company_domain || '').toLowerCase().replace(/^www\./, '');
}

/**
 * Measures the pool per country and ICP with the current filters, before spending.
 * 1 credit per count (limit 1 + include_total_results). Excludes companies in cooldown, like a real run.
 * Count first, decide later.
 */
function measurePool(days) {
  days = days || CONFIG.freshness.min_window_days;
  const key = PropertiesService.getScriptProperties().getProperty('THEIRSTACK_KEY');
  const exclude = domainsInCooldown_(loadState_());
  const out = [];
  allCountries_().forEach(function (country) {
    const row = [country];
    Object.keys(CONFIG.icps).forEach(function (icp) {
      const q = tsQuery_(icp, false, days, exclude, 1, 0);
      q.job_country_code_or = [country];
      q.include_total_results = true;
      Utilities.sleep(CONFIG.theirstack.wait_between_calls_ms);
      const j = tsPost_(q, key);
      row.push(icp + '=' + ((j.metadata && (j.metadata.total_results != null ? j.metadata.total_results : j.metadata.total)) || 0));
    });
    out.push(row.join(' '));
  });
  return 'window ' + days + ' days · ' + out.join(' | ');
}
