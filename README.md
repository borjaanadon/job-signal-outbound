# job-signal-outbound

A lead engine for a B2B HR SaaS that treats every job posting as a public signal of need.

A company that publishes an opening is saying, in public, that it has the problem a recruiting product solves. This engine finds those postings every night, keeps only the ones that match the ICP, drops companies already in a sales conversation, finds the people who can decide and writes everything into a CRM sheet ready for outreach. The first contact then delivers work already done against that posting (for a recruiting product, a sample shortlist for that exact role) instead of a promise.

It runs on Google Apps Script with zero model calls: every decision is a rule you can read in `src/Config.js`.

## Pipeline

```
1 ICP          2 Detect         3 Screen         4 Enrich           5 Deliverable     6 Send
Config.js  ->  TheirStack   ->  HubSpot     ->   Amplemarket   ->   (your product) -> (your sequencer)
               TheirStack.js    HubSpot.js       Enrich.js
                         \____________ CRM sheet + daily mail ____________/
```

| Step | What it does | Where |
|---|---|---|
| 1. ICP | Titles, exclusions, headcount, industries, markets and budget. All parameters, no logic | `Config.js` |
| 2. Detect | Fetches postings from TheirStack with a credit cap per run, per ICP and per market, dedup and 429 handling | `TheirStack.js`, `Main.js` |
| 3. Screen | Drops companies with a commercial lifecycle, a recent contact or an open deal in HubSpot | `HubSpot.js` |
| 4. Enrich | Fills decision makers by title family and validates their emails through an async lead list | `Enrich.js`, `Amplemarket.js` |
| 5-6 | Building the deliverable and sending it depend on your product and sequencer, so they stay out of this repo | |

## Design decisions (and the data behind them)

**There is more signal than sending capacity, so the job is to choose well, not to detect more.** In one market and a 7-day window, the ICP produced around 390 postings a week against a sending capacity of 100-140. That 3-4x surplus is why the per-run credit cap is the regulator of the whole system and why there is a cap of one posting per company per run: small agencies publish seven or more postings each, and without the cap one ten-person firm would get seven emails.

**Count before you pay.** TheirStack charges 1 credit per posting returned. A count with `limit: 1` and `include_total_results` costs 1 credit and returns the size of the pool, so `measurePool()` sizes every filter change before a real run spends anything. Companies in cooldown are excluded at the source with `company_domain_not`, so you never pay for them.

**Priority mode spends first on postings that name the hiring team.** About a quarter of the pool comes with `hiring_team` filled in, and in the first real batch 95% of those arrived with an owner already resolved. Step 4 then changes from "find the decision maker and their email" to "find the email of someone you already know". It cannot be a hard filter (it would drop three quarters of the pool), so the job fetches those first and fills the rest of the budget with the others.

**Industry is filtered by exclusion.** Excluding 19 non-tech industries kept about 30% more postings than including 6 tech ones. The difference is companies with no industry on file, and in early tests the two best fits were small startups with neither industry nor headcount listed. For the same reason the `_or_null` headcount filters are mandatory: without them a quarter of the volume disappears, and it is the smallest companies.

**Funding is a scoring signal, never a gate.** Filtering by funding cut the pool by almost 90%, because the provider only has that data for a minority of companies.

**"Exists in the CRM" does not block.** In the first batch, more than half of the companies were already in HubSpot, but fewer than half of those had a real conversation. The rest were leads with no activity. The job blocks on commercial lifecycle, contact in the last 30 days, or a deal in a configured stage. It also looks for deals through the contacts on the company's domain, because most deals have no company associated.

**Fail closed.** If a configured pipeline or deal stage does not exist in HubSpot, or the CRM columns are not where they should be, the run stops before spending a credit or writing a row. A typo should break the job loudly, never disable a filter silently.

**Postings expire fast.** About half were closed a week after detection (more for agencies), and around 1 in 6 were already closed when processed. The job checks every posting for free before writing it (the public LinkedIn guest endpoint, or closing markers in the page's visible text) and the daily mail reminds you to keep detection-to-send under 3-5 days.

**Only people who can buy.** Contacts are searched by title families per ICP and size: founders for small startups, the technical hiring manager first for mid-size tech companies, talent leaders for consultancies. Recruiters and HR business partners are discarded: they execute, they do not decide on a tool. Every contact passes `isDecisionMaker_()` before and after enrichment.

**The CRM is append-only.** The sheet is edited by hand (deliverable links, outreach status, notes), so the job only appends rows and only fills empty contact cells on its own rows. Its memory of what it has seen lives in a separate state spreadsheet.

## Gotchas found along the way

- `property_exists_or` in TheirStack is an OR. Adding `hiring_team` to the list widens the query instead of narrowing it.
- `job_country_code_or` filters the country of the job, not of the company's headquarters. A foreign company with an opening in your market comes in, and the copy has to say the right city.
- The job title is a poor proxy for the role. Add every exclusion pattern in singular and plural: the first false positives came from `business developer` when only `business development` was listed.
- In regex, never put `\b` next to `.`, `#` or `+`: `\b\.net` and `c#\b` almost never match.
- TheirStack returns LinkedIn slugs percent-encoded and Amplemarket in plain text. Without decoding and normalizing, about a third of the contacts did not match.
- TheirStack fills `hiring_team` with junk when it finds nobody (slugs like `/in/en/`). They are filtered out.
- `job_id_not` and `discovered_at_gte` return HTTP 500. `GET /v1/users/me` returns your own API key in clear text: never log it.
- HubSpot omits empty properties from search results. A missing `num_associated_deals` means zero, not "property does not exist".
- Apps Script stops at 6 minutes. The job stops itself at 4.5, writes what it finished and leaves the rest unmarked for the next run.

## Setup

1. Create an Apps Script project and copy `.clasp.json.example` to `.clasp.json` with its script id. Then `clasp push`.
2. In Project Settings → Script properties, add `THEIRSTACK_KEY`, `HUBSPOT_TOKEN` (read-only Private App) and, optionally, `AMPLEMARKET_KEY`.
3. Edit `src/Config.js`: ICPs, markets, titles, budget and the exact HubSpot pipeline and stage labels that should block.
4. Run `setup()` once. It creates the CRM and state spreadsheets and the triggers.
5. Run `checkConfig()` (0 credits), then `testRun()` (5 credits, writes nothing, mails you the preview).

| Function | When |
|---|---|
| `runDaily()` | Trigger, Mon-Fri at night. Detect, screen, write, mail |
| `enrichDaily()` | Trigger, one hour later. Contacts and the validation lead list |
| `collectEnrichment()` | Trigger, every 15 min. Writes the emails when the list completes |
| `measurePool(days)` | By hand. Pool size per country and ICP, 1 credit per count |

---

Built by Borja Anadón · Growth & Go-To-Market · [borjaanadon.com](https://borjaanadon.com)
