/** Daily mails: what entered the CRM, what was blocked and what it cost. */

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mailTo_() {
  return CONFIG.MAIL_TO || Session.getEffectiveUser().getEmail();
}

function today_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'd MMM');
}

function crmUrl_() {
  const id = PropertiesService.getScriptProperties().getProperty('CRM_SHEET_ID');
  return id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : '#';
}

function sendRunMail_(opts, res) {
  const byIcp = Object.keys(CONFIG.icps).map(function (k) {
    return k + ' ' + res.added.filter(function (x) { return x.icp === k; }).length;
  }).join(' · ');
  const prefix = opts.mode === 'test' ? '[TEST, writes nothing] ' : '';
  const subject = res.error
    ? prefix + 'Job signals · ' + today_() + ' · ERROR'
    : prefix + 'Job signals · ' + today_() + ' · ' + res.added.length + ' new postings (' + byIcp + ')';

  const h = ['<div style="font-family:Arial,sans-serif;font-size:13px;color:#222">'];
  if (res.error) h.push('<p style="color:#b00020"><b>The run failed.</b> Nothing was written to the CRM.</p><pre style="font-size:11px">' + esc_(res.error) + '</pre>');
  res.warnings.forEach(function (a) { h.push('<p style="color:#8a6d00"><b>Warning:</b> ' + esc_(a) + '</p>'); });

  h.push('<p><b>' + res.added.length + '</b> new postings in the <a href="' + crmUrl_() + '">CRM</a> (' + byIcp + ') · ' +
    '<b>' + res.blocked.length + '</b> blocked by HubSpot · ' +
    '<b>' + res.credits + '</b> credits today' + (res.creditsMonth != null ? ' (' + res.creditsMonth + ' this month before this run)' : '') +
    ' · window ' + res.window + ' days' +
    (res.byMarket ? ' · by market: ' + Object.keys(res.byMarket).map(function (k) { return k + ' ' + res.byMarket[k]; }).join(', ') : '') + '</p>');
  h.push('<p style="color:#666">Fetched ' + res.fetched + ' · already seen ' + res.dropped.alreadySeen +
    ' · 2nd posting of the same company ' + res.dropped.perCompanyCap + ' · company in cooldown ' + res.dropped.cooldown +
    ' · posting already closed ' + res.closed.length + '</p>');

  if (res.added.length) {
    h.push('<table cellpadding="4" style="border-collapse:collapse;font-size:12px"><tr style="background:#eef">' +
      '<th align="left">ICP</th><th align="left">Company</th><th align="left">Role</th><th align="left">Hiring team</th></tr>');
    res.added.forEach(function (n) {
      h.push('<tr><td>' + n.icp + '</td><td><b>' + esc_(n.company) + '</b></td><td><a href="' + esc_(n.url) + '">' +
        esc_(n.role) + '</a></td><td>' + esc_(n.contact || '-') + '</td></tr>');
    });
    h.push('</table>');
  }
  const list = function (title, items, fmt) {
    if (!items.length) return;
    h.push('<p><b>' + title + '</b></p><ul>');
    items.forEach(function (b) { h.push('<li>' + fmt(b) + '</li>'); });
    h.push('</ul>');
  };
  list('Out of ICP (not added):', res.outOfIcp, function (b) { return b.icp + ' · ' + esc_(b.company) + ': ' + esc_(b.reason); });
  list('Already closed when detected (not added; the company stays eligible):', res.closed, function (b) { return b.icp + ' · ' + esc_(b.company) + ': ' + esc_(b.role); });
  list('Blocked by HubSpot (eligible again after the cooldown):', res.blocked, function (b) { return b.icp + ' · ' + esc_(b.company) + ': ' + esc_(b.reason); });
  h.push('<p style="color:#999;font-size:11px">Postings expire fast: about half are closed within a week. ' +
    'Keep detection-to-send under 3-5 days.</p></div>');

  MailApp.sendEmail({ to: mailTo_(), subject: subject, htmlBody: h.join('\n'),
    body: subject + '\n\n' + res.added.map(function (n) { return n.icp + ' · ' + n.company + ' · ' + n.role; }).join('\n') });
}

function sendEnrichMail_(res, r) {
  const h = ['<div style="font-family:Arial,sans-serif;font-size:13px;color:#222">'];
  let subject;
  if (res.error) {
    subject = 'Job signals contacts · ' + today_() + ' · ERROR';
    h.push('<p style="color:#b00020"><b>Enrichment failed.</b></p><pre style="font-size:11px">' + esc_(res.error) + '</pre>');
  } else if (!r) {
    subject = 'Job signals contacts · ' + today_() + ' · list processing';
    h.push('<p>Amplemarket is still processing the list of ' + res.urls + ' profiles. Emails will be written to the CRM when it finishes and you will get another mail.</p>');
  } else {
    const other = Object.keys(r.other).map(function (k) { return r.other[k] + ' ' + k; }).join(', ') || 'none';
    subject = 'Job signals contacts · ' + today_() + ' · ' + r.deliverable + ' new emails in ' + r.rows + ' postings';
    h.push('<p><b>' + r.deliverable + '</b> deliverable emails written to the CRM · dropped by validation: ' + other +
      ' · no email in Amplemarket: ' + r.noEmail + ' · dropped because the title cannot decide: ' + r.notDecider + ' (searched again next pass)</p>');
  }
  if (res.rows != null) {
    h.push('<p style="color:#666">Rows reviewed ' + res.rows + ' · contact searches ' + res.searched +
      ' · new contacts found ' + (res.found || 0) + ' · profiles sent to enrich ' + (res.urls || 0) + '</p>');
  }
  if (res.nobody && res.nobody.length) h.push('<p><b>No contact at all</b> (neither TheirStack nor Amplemarket): ' + res.nobody.map(esc_).join(', ') + '</p>');
  if (r && r.otherDomain.length) h.push('<p><b>Email on a different domain than the company</b> (usually legit, review): ' + r.otherDomain.map(esc_).join(', ') + '</p>');
  (res.warnings || []).forEach(function (a) { h.push('<p style="color:#8a6d00">' + esc_(a) + '</p>'); });
  h.push('<p style="color:#999;font-size:11px">Before sending: check the CRM history of rows with "Last CRM touch" filled in.</p></div>');
  MailApp.sendEmail({ to: mailTo_(), subject: subject, htmlBody: h.join('\n'), body: subject });
}
