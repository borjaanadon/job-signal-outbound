/**
 * The CRM is a Google Sheet tab. The job ONLY APPENDS rows: it never rewrites, because
 * the deliverable, outreach and notes columns are filled in by hand. Enrichment only fills
 * EMPTY contact cells on rows the job created.
 */
const HEADERS = [
  'Priority', 'Company', 'ICP', 'Role', 'Status', 'Posted', 'Added', 'URL', 'Job id', 'JD',
  'Industry', 'Employees', 'Location', 'Domain', 'Company LinkedIn', 'Last CRM touch',
  'Deliverable URL', 'Deliverable status', 'Outreach status', 'Replied', 'Notes',
  'Contact 1 name', 'Contact 1 title', 'Contact 1 email', 'Contact 1 LinkedIn',
  'Contact 2 name', 'Contact 2 title', 'Contact 2 email', 'Contact 2 LinkedIn',
  'Contact 3 name', 'Contact 3 title', 'Contact 3 email', 'Contact 3 LinkedIn',
];
const COL = {
  priority: 0, company: 1, icp: 2, role: 3, status: 4, posted: 5, added: 6, url: 7, jobId: 8, jd: 9,
  industry: 10, employees: 11, location: 12, domain: 13, companyLinkedin: 14, crmLastTouch: 15,
  deliverableUrl: 16, deliverableStatus: 17, outreachStatus: 18, replied: 19, notes: 20,
};
// Each contact = 4 consecutive columns: name, title, email, LinkedIn
const CONTACTS = [21, 25, 29];
const CRM_COLS = HEADERS.length;
const CRM_FIRST_ROW = 2;
const MAX_JD = 45000;   // a cell holds 50,000 characters
const ROW_HEIGHT = 21;
const AUTO_NOTE = /^Auto /; // rows created by the job

function crmSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('CRM_SHEET_ID');
  if (!id) throw new Error('Missing CRM_SHEET_ID: run setup() first');
  const sh = SpreadsheetApp.openById(id).getSheetByName(CONFIG.CRM_TAB);
  if (!sh) throw new Error('Tab "' + CONFIG.CRM_TAB + '" does not exist in the CRM');
  return sh;
}

/** Creates the CRM tab with its header if missing. Idempotent. */
function ensureCrm_(book) {
  let sh = book.getSheetByName(CONFIG.CRM_TAB);
  if (!sh) sh = book.insertSheet(CONFIG.CRM_TAB);
  if (sh.getRange(1, 1).getValue() === '') {
    sh.getRange(1, 1, 1, CRM_COLS).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(COL.jd + 1, 260);
  }
  return sh;
}

/** Fail closed: if the columns are not where expected, writing would misalign the whole CRM. */
function crmCheckColumns_(sh) {
  const head = sh.getRange(1, 1, 1, CRM_COLS).getValues()[0];
  const wrong = HEADERS.filter(function (h, i) { return head[i] !== h; });
  if (wrong.length) {
    throw new Error('CRM columns are not the expected ones (first mismatch: "' + wrong[0] + '"). Nothing was written.');
  }
}

/** Job ids already in the CRM (second safety net against duplicates). */
function crmJobIds_(sh) {
  const n = sh.getLastRow();
  if (n < CRM_FIRST_ROW) return {};
  const ids = {};
  sh.getRange(CRM_FIRST_ROW, COL.jobId + 1, n - CRM_FIRST_ROW + 1, 1).getValues()
    .forEach(function (r) { if (r[0] !== '') ids[String(r[0])] = true; });
  return ids;
}

function priority_(icp, hasContact) {
  if (!hasContact) return '3 · Low';
  return icp === 'A' ? '1 · High' : '2 · Medium';
}

function crmRow_(o, icp, hs) {
  const now = new Date();
  const team = (o.hiring_team || []).filter(validContact_);
  const junk = (o.hiring_team || []).length - team.length;
  const notes = ['Auto ' + Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd/MM')];
  notes.push(team.length ? 'Missing email (step 4)' : 'No contact (step 4)');
  if (team.length && !team[0].role) notes.push('contact title unconfirmed');
  if (junk) notes.push('invalid hiring team discarded');
  const row = Array(CRM_COLS).fill('');
  row[COL.priority] = priority_(icp, team.length > 0);
  row[COL.company] = (o.company_object && o.company_object.name) || o.company || '';
  row[COL.icp] = icp;
  row[COL.role] = o.job_title || '';
  row[COL.status] = 'Open';
  row[COL.posted] = o.date_posted || '';
  row[COL.added] = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  row[COL.url] = o.url || o.final_url || '';
  row[COL.jobId] = String(o.id);
  // Line breaks are kept on purpose: the deliverable step reads the JD and its structure matters
  row[COL.jd] = String(o.description || '').slice(0, MAX_JD);
  row[COL.industry] = (o.company_object && o.company_object.industry) || '';
  row[COL.employees] = (o.company_object && o.company_object.employee_count) || '';
  const country = o.country_code || (o.country_codes && o.country_codes[0]) || '';
  row[COL.location] = (o.short_location || o.location || '') + (country ? ' (' + country + ')' : '');
  row[COL.domain] = domain_(o);
  row[COL.companyLinkedin] = (o.company_object && o.company_object.linkedin_url) || o.company_linkedin_url || '';
  row[COL.crmLastTouch] = hs.lastTouch || '';
  row[COL.deliverableStatus] = 'Pending';
  row[COL.outreachStatus] = 'Not Contacted';
  row[COL.notes] = notes.join(' · ');
  CONTACTS.forEach(function (base, i) {
    const p = team[i];
    if (!p) return;
    row[base] = p.full_name || ''; row[base + 1] = p.role || ''; row[base + 3] = p.linkedin_url || '';
  });
  return row;
}

/** Appends rows at the end and copies the format of the first data row. */
function crmAppend_(sh, rows) {
  if (!rows.length) return;
  const from = Math.max(sh.getLastRow() + 1, CRM_FIRST_ROW);
  sh.getRange(from, 1, rows.length, CRM_COLS).setValues(rows);
  if (from > CRM_FIRST_ROW) {
    sh.getRange(CRM_FIRST_ROW, 1, 1, CRM_COLS).copyFormatToRange(sh, 1, CRM_COLS, from, from + rows.length - 1);
  }
  // The JD has line breaks and Sheets grows the row even with CLIP: force the height
  sh.getRange(from, COL.jd + 1, rows.length, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sh.setRowHeightsForced(from, rows.length, ROW_HEIGHT);
}

/** Rows created by the job (the note starts with "Auto"). */
function autoRows_(sh) {
  const n = sh.getLastRow();
  if (n < CRM_FIRST_ROW) return [];
  return sh.getRange(CRM_FIRST_ROW, 1, n - CRM_FIRST_ROW + 1, CRM_COLS).getValues()
    .map(function (v, i) { return { row: CRM_FIRST_ROW + i, v: v }; })
    .filter(function (r) { return AUTO_NOTE.test(String(r.v[COL.notes])); });
}
