/**
 * All tunable parameters live here. Edit, then `clasp push`.
 *
 * Secrets NEVER go in this file. Set them in Project Settings -> Script properties:
 *   THEIRSTACK_KEY    job postings API
 *   HUBSPOT_TOKEN     read-only Private App token
 *   AMPLEMARKET_KEY   contact search + email validation (optional: without it, step 4 is skipped)
 * CRM_SHEET_ID and STATE_SHEET_ID are created by setup().
 *
 * The ICPs below are an example for a B2B recruiting SaaS:
 *   A = boutique recruiting agencies · B = tech startups and scale-ups · C = IT consultancies.
 * Order = priority = spending order.
 */
const CONFIG = {
  TIMEZONE: 'Europe/Madrid',
  CRM_TAB: 'Job signals',
  MAIL_TO: '', // empty = the account that runs the script
  RUN_HOURS: [2, 3], // Mon-Fri. Two runs per night: each one fits in the 6-minute Apps Script limit

  budget: {
    max_credits_per_run: 100,
    // Agencies post in bursts (one posting per company per day still costs 1 credit each).
    // Without a cap they eat the whole budget.
    max_share_per_icp: { A: 0.4 },
    // Hard monthly brake: once reached, the job fetches nothing and says so in the mail.
    max_credits_per_month: 1480,
    paused: false,
  },

  freshness: {
    first_run_days: 7,
    max_window_days: 7,
    // The provider discovers postings 2-3 days late. A 1-day window would never see them.
    // Companies already seen are excluded at the source, so the overlap is almost free.
    min_window_days: 3,
  },
  // Apps Script stops at 6 min and the CRM is written at the end: stop early and write what is done.
  // Whatever is left unprocessed is not marked as seen and enters the next run.
  max_runtime_ms: 270000,

  // Spending order: first postings that already name the hiring team (step 4 arrives half solved),
  // in ICP priority order; then the rest.
  passes: [
    { icp: 'A', priority: true }, { icp: 'B', priority: true }, { icp: 'C', priority: true },
    { icp: 'A', priority: false }, { icp: 'B', priority: false }, { icp: 'C', priority: false },
  ],

  // Case-insensitive regex, filtered server-side (free). Chosen with data: engineering + data/AI
  // were ~80% of the technical pool; design, QA and tech leadership added width but little volume.
  titles: [
    'software (engineer|developer)', 'back[- ]?end', 'front[- ]?end', 'full[- ]?stack',
    '(ios|android|mobile) (engineer|developer)', 'devops', '(platform|site reliability|sre) engineer',
    'data engineer', 'data scientist', 'data analyst', 'analytics engineer', 'machine learning',
    '(ai|artificial intelligence) engineer',
    // Local-language titles for non-English markets
    'sviluppatore', 'programmatore', 'ingegnere (del )?software', 'analista (programmatore|dati)',
  ],
  titles_extended: ['product (manager|owner|lead)', 'product managers', 'product owners'],
  // RULE: every new pattern in singular AND plural. The first false positives came from exactly that.
  titles_excluded: [
    'business development', 'business developer', 'account development', 'account developer',
    'sales development', 'sales developer', 'spontaneous', 'speculative', 'talent pool', 'open application',
    "sviluppatore d'azienda", "sviluppatori d'azienda", 'sviluppatore commerciale', 'sviluppatori commerciali',
    'phd', 'doctorado', 'doctoral', 'internship', 'internships', 'becario', 'becaria', 'becarios',
    'practicas', 'prácticas', 'tirocinio', 'tirocini', 'stage curriculare',
  ],
  // Not ICP even when the provider says so (regex on the company name).
  companies_excluded: [
    'chamber', 'confidential', 'university', 'universidad', 'foundation', 'fundaci[oó]n', 'ministry', 'ministerio',
    // Local subsidiaries of multinationals: own domain and a local headcount inside the range
    'accenture', 'deloitte', '\\bpwc\\b', 'kpmg', '\\bey\\b', 'capgemini', '\\bibm\\b', 'amazon', 'google', 'microsoft', 'oracle',
  ],
  // Same rule by domain: the company's or the one in a contact's email.
  multinational_domains: [
    'accenture.com', 'deloitte.com', 'pwc.com', 'kpmg.com', 'ey.com', 'capgemini.com', 'ibm.com',
    'amazon.com', 'google.com', 'microsoft.com', 'oracle.com',
  ],
  // Is the posting still open? Checked before writing (about 1 in 6 were already closed when processed).
  liveness: { check: true, wait_ms: 800 },
  // The provider fills hiring_team with garbage when it finds no one.
  junk_contacts: {
    names: [],
    min_linkedin_slug: 4, // "linkedin.com/in/en/" is not a person
  },
  industries_excluded: [
    'Construction', 'Hospitals and Health Care', 'Restaurants', 'Retail', 'Manufacturing', 'Real Estate',
    'Hospitality', 'Staffing and Recruiting', 'Transportation, Logistics, Supply Chain and Storage', 'Wholesale',
    'Non-profit Organizations', 'Education', 'Consumer Services', 'Entertainment Providers', 'Legal Services',
    'Government Administration', 'Dentists', 'Personal Care Services', 'Truck Transportation',
  ],
  industries_consulting: [
    'IT Services and IT Consulting', 'Business Consulting and Services', 'Outsourcing and Offshoring Consulting',
  ],

  // Markets in spending order. "extended" = wider ICP limits + product titles, for markets where
  // the brand is known. Secondary markets run the strict ICP with their own credit cap.
  markets: [
    { name: 'core', countries: ['ES', 'IT'], extended: true },
    { name: 'secondary', countries: ['GB', 'SE', 'DK', 'NO', 'FI'], extended: false, max_credits: 30 },
  ],

  icps: {
    A: { name: 'Boutique recruiting agencies', company_type: 'recruiting_agency', max_employees: 20, max_employees_extended: 50, cooldown_days: 45 },
    B: { name: 'Tech startups and scale-ups', company_type: 'direct_employer', min_employees: 10, max_employees: 300, max_employees_extended: 500,
      industry: 'exclude_non_tech_and_consulting', industry_extended: 'exclude_consulting', cooldown_days: 30 },
    C: { name: 'IT consultancies', company_type: 'direct_employer', min_employees: 10, max_employees: 300, max_employees_extended: 500,
      industry: 'only_consulting', cooldown_days: 30 },
  },

  theirstack: {
    url: 'https://api.theirstack.com/v1/jobs/search',
    credits_url: 'https://api.theirstack.com/v0/teams/credits_consumption',
    page_size: 25,
    wait_between_calls_ms: 7000,
  },

  amplemarket: {
    url: 'https://api.amplemarket.com',
    owner: '', // owner of the lead lists the job creates; empty = the account that runs the script
    enrich_hours: [4, 5], // one hour after detection; a second pass picks up what did not fit
    max_runtime_ms: 210000,
    // Titles per ICP. NEVER a bare "Owner": it matches Product Owner.
    founders: ['Founder', 'Co-Founder', 'Cofounder', 'CEO', 'Managing Director', 'Director General', 'Fundador', 'Cofundador',
      'Fondatore', 'Co-fondatore', 'Amministratore Delegato', 'Titolare'],
    partners: ['Managing Partner', 'Partner', 'Socio', 'Socia', 'Socio Director'],
    // Only people who can decide on buying a tool. Recruiters and HR business partners execute, they do not buy.
    talent: ['Head of Talent', 'Head of Talent Acquisition', 'Talent Acquisition Manager', 'Head of Recruitment', 'Recruitment Manager',
      'Head of People', 'People Director', 'Chief People Officer', 'VP People', 'HR Director', 'Head of HR', 'HR Manager',
      'Director de Recursos Humanos', 'Directora de Recursos Humanos', 'Responsable de Selección', 'Responsable de RRHH',
      'Direttore Risorse Umane', 'Responsabile Risorse Umane', 'Responsabile Selezione'],
    // In mid-size tech companies the technical hiring manager decides
    technical: ['CTO', 'Chief Technology Officer', 'VP Engineering', 'VP of Engineering', 'Head of Engineering', 'Director of Engineering',
      'Head of Data', 'Director Tecnológico', 'Director de Tecnología', 'Direttore Tecnico',
      'CPO', 'Chief Product Officer', 'VP Product', 'VP of Product', 'Head of Product', 'Director of Product'],
    founder_threshold: 30,       // B below 30 employees: write to the founder
    single_contact_threshold: 5, // A below 5 employees: one contact only
    three_contacts_threshold: 30, // B and C from 30 employees: three contacts
    // If the job provider does not know the headcount, ask Amplemarket and drop it if above the ICP cap
    check_size_if_missing: true,
  },

  hubspot: {
    lifecycle_blocks: ['customer', 'opportunity', 'salesqualifiedlead', 'marketingqualifiedlead'],
    recent_contact_days: 30,
    // Deals that block, with the EXACT labels in your portal. '*' = the whole pipeline.
    // If a label does not exist, the job STOPS (fail closed): a typo would silently disable the filter.
    deals_block: [
      { pipeline: 'Sales Pipeline', stages: ['Discovery', 'Demo', 'Proposal', 'Negotiation', 'Closed Won'] },
      { pipeline: 'Customer Success', stages: '*' },
    ],
    personal_domains: ['gmail.com', 'hotmail.com', 'hotmail.es', 'outlook.com', 'outlook.es', 'yahoo.com', 'yahoo.es',
      'icloud.com', 'me.com', 'live.com', 'msn.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.es'],
    wait_ms: 250,
  },
};
