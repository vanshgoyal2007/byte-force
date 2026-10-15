import { NextRequest, NextResponse } from "next/server";
import { calculateMatch, deduplicateJobs, JobSchema, SearchInputSchema, type Job } from "@/lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 120;
const SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
const FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";
const AGENT_ENDPOINT = "https://agent.tinyfish.ai/v1/automation/run";

const agentJobSchema = {
  type: "object",
  properties: {
    jobs: { type: "array", items: { type: "object", properties: {
      title: { type: "string" }, company: { type: "string" }, location: { type: "string" },
      employment_type: { type: "string" }, work_arrangement: { type: "string" }, description: { type: "string" },
      experience_level: { type: "string" },
      apply_url: { type: "string" }, posting_date: { type: "string" }, deadline: { type: "string" },
      compensation: { type: "string" }, required_skills: { type: "array", items: { type: "string" } },
      education_requirements: { type: "string" }, graduation_year_requirements: { type: "string" },
      visa_sponsorship: { type: "string" }, work_authorization: { type: "string" }, status: { type: "string" },
    }, required: ["title"] } },
  }, required: ["jobs"],
};

type SearchHit = { title: string; snippet: string; url: string; site_name: string; date?: string };
type FetchedPage = { url: string; final_url?: string; title?: string | null; description?: string | null; text?: string | null; links?: string[] };
type FetchError = { url: string; error: string; status?: number };
type AgentJob = { title: string; company?: string; location?: string; employment_type?: string; work_arrangement?: string; description?: string; experience_level?: string; apply_url?: string; posting_date?: string; deadline?: string; compensation?: string; required_skills?: string[]; education_requirements?: string; graduation_year_requirements?: string; visa_sponsorship?: string; work_authorization?: string; status?: string };

export async function POST(request: NextRequest) {
  const parsed = SearchInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Please check your search details and try again." }, { status: 400 });
  const input = parsed.data;
  if (!input.query && !input.role) return NextResponse.json({ error: "Enter a role or a natural-language search to get started." }, { status: 400 });
  const apiKey = process.env.TINYFISH_API_KEY;
  if (!apiKey) return NextResponse.json({ code: "MISSING_CONFIGURATION", error: "TinyFish is not configured yet. Add TINYFISH_API_KEY to your local environment, then restart the app." }, { status: 503 });

  const query = composeQuery(input);
  const status: string[] = [];
  let searchPartial = false;
  let fetchUnavailable = false;
  let agentPartial = false;
  let verificationPartial = false;
  let hits: SearchHit[] = [];
  try {
    status.push("Searching career pages and job portals");
    const queries = [...new Set([query, `${input.role || input.query} ${input.location} jobs internships careers`.trim()])].slice(0, 2);
    const searchAttempts = await Promise.allSettled(queries.map((q) => tinyfishSearch(q, input.location, apiKey)));
    const searchResponses = searchAttempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value] : []);
    searchPartial = searchResponses.length < queries.length;
    if (searchPartial) status.push("One discovery query was unavailable; keeping results from the successful query");
    if (!searchResponses.length) {
      const failure = searchAttempts.find((attempt) => attempt.status === "rejected");
      throw failure?.status === "rejected" ? failure.reason : new Error("TinyFish Search did not return results.");
    }
    hits = deduplicateHits(searchResponses.flatMap((response) => response.results ?? []));
    if (!hits.length) return NextResponse.json({ jobs: [], status: [...status, "No matching source pages found"], partial: searchPartial, lastScanned: new Date().toISOString(), sourceCount: 0 });

    status.push("Reading relevant live listings");
    const fetchHits = hits.slice(0, 6);
    const directoryHits = process.env.TINYFISH_AGENT_ENABLED === "false" ? [] : hits.filter((hit) => /career|jobs|job-search|opportunit|work-with-us|greenhouse\.io|lever\.co|ashbyhq\.com/i.test(`${hit.url} ${hit.title}`)).slice(0, 2);
    if (directoryHits.length) status.push("Using TinyFish Agent on career directories");
    const fetchPromise = fetchPages(fetchHits, query, apiKey).then((value) => ({ pages: value, failed: false })).catch(() => ({ pages: [] as { hit: SearchHit; page: FetchedPage }[], failed: true }));
    const agentPromise = Promise.allSettled(directoryHits.map((hit) => runAgent(hit, query, apiKey)));
    const [fetchOutcome, agentResults] = await Promise.all([fetchPromise, agentPromise]);
    const pages = fetchOutcome.pages;
    fetchUnavailable = fetchOutcome.failed;
    if (fetchUnavailable) status.push("Page extraction was unavailable; retaining genuine search result snippets");
    const agentJobs = agentResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    agentPartial = agentResults.some((result) => result.status === "rejected");
    if (agentPartial) status.push("TinyFish Agent could not read every career directory");

    const fetchedByUrl = new Map(pages.map(({ hit, page }) => [hit.url, { hit, page }]));
    const fetchedJobs = hits.slice(0, 6).map((hit) => {
      const fetched = fetchedByUrl.get(hit.url);
      return normalizePage(hit, fetched?.page ?? { url: hit.url, title: hit.title, description: hit.snippet, text: hit.snippet }, input);
    }).filter((job): job is Job => job !== null);
    const candidates = deduplicateJobs([...agentJobs, ...fetchedJobs].filter((job) => job.title.trim().length > 2));
    status.push("Checking application links");
    let jobs = candidates;
    try { const verification = await verifyApplicationLinks(candidates, apiKey); jobs = verification.jobs; verificationPartial = verification.partial; }
    catch { verificationPartial = true; }
    if (verificationPartial) status.push("Some application links could not be checked; no temporary failure was treated as expiry");
    status.push("Removing duplicate listings and calculating explainable matches");
    jobs = deduplicateJobs(jobs.flatMap((job) => { const parsedJob = JobSchema.safeParse(job); return parsedJob.success ? [parsedJob.data] : []; }));
    const partial = searchPartial || fetchUnavailable || verificationPartial || agentPartial || pages.length < Math.min(hits.length, 6) || hits.length > 6;
    return NextResponse.json({ jobs, status, partial, lastScanned: new Date().toISOString(), sourceCount: new Set(jobs.map((job) => job.source)).size, totalDiscovered: hits.length });
  } catch (error) {
    const message = error instanceof TinyFishError ? error.message : "The live search could not reach TinyFish. Check your connection and try again.";
    const code = error instanceof TinyFishError ? error.code : "NETWORK_ERROR";
    const httpStatus = error instanceof TinyFishError ? error.status : 502;
    return NextResponse.json({ code, error: message, jobs: [], status, partial: false }, { status: httpStatus });
  }
}

class TinyFishError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

function composeQuery(input: ReturnType<typeof SearchInputSchema.parse>) {
  const parts = [input.query, input.role && !input.query.toLowerCase().includes(input.role.toLowerCase()) ? input.role : "", input.location, input.opportunityType === "Any type" || input.opportunityType === "Both" ? "jobs internships" : input.opportunityType, input.experienceLevel === "Any level" ? "" : input.experienceLevel, input.skills.join(" "), input.degree, input.branch, input.targetCompanies.join(" "), input.industries.join(" ")].filter(Boolean);
  return `${parts.join(" ")} careers hiring`.trim();
}

function countryFor(location: string) {
  if (/india|bengaluru|bangalore|delhi|mumbai|hyderabad|pune|chennai/i.test(location)) return "IN";
  if (/london|uk|united kingdom/i.test(location)) return "GB";
  if (/canada|toronto|vancouver/i.test(location)) return "CA";
  if (/germany|berlin/i.test(location)) return "DE";
  if (/australia|sydney|melbourne/i.test(location)) return "AU";
  if (/france|paris/i.test(location)) return "FR";
  if (/japan|tokyo/i.test(location)) return "JP";
  if (/united states|\busa\b|\bus\b|new york|san francisco/i.test(location)) return "US";
  return undefined;
}

async function tinyfishSearch(query: string, location: string, apiKey: string) {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("purpose", "Find genuine active employer job listings matching the user’s role and preferences");
  const country = countryFor(location);
  if (country) url.searchParams.set("location", country);
  const response = await fetch(url, { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(15000), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw upstreamError(response.status, body);
  return body as { results?: SearchHit[] };
}

async function fetchPages(hits: SearchHit[], query: string, apiKey: string) {
  if (!hits.length) return [];
  const response = await fetch(FETCH_ENDPOINT, {
    method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: hits.map((hit) => hit.url), format: "markdown", links: true, ttl: 0, per_url_timeout_ms: 18000, purpose: `Extract job title, employer, work location, employment type, date, deadline, compensation, requirements and genuine application link relevant to: ${query}` }),
    signal: AbortSignal.timeout(24000), cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw upstreamError(response.status, body);
  const byUrl = new Map<string, FetchedPage>(((body.results ?? []) as FetchedPage[]).map((page) => [page.url, page]));
  return hits.flatMap((hit) => { const page = byUrl.get(hit.url); return page ? [{ hit, page }] : []; });
}

async function runAgent(hit: SearchHit, query: string, apiKey: string): Promise<Job[]> {
  const response = await fetch(AGENT_ENDPOINT, {
    method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ url: hit.url, goal: `Find up to five current open job or internship listings on this employer careers page that match: ${query}. Navigate only as needed. Return source-stated facts and direct job/apply URLs. Do not invent details; return an empty jobs array if none are found.`, output_schema: agentJobSchema, browser_profile: "lite", agent_config: { max_duration_seconds: 15 } }),
    signal: AbortSignal.timeout(18000), cache: "no-store",
  });
  if (!response.ok) throw upstreamError(response.status, await response.json().catch(() => ({})));
  const body = await response.json().catch(() => ({})) as { result?: { jobs?: AgentJob[]; result?: { jobs?: AgentJob[] } }; status?: string };
  const result = body.result?.jobs ?? body.result?.result?.jobs ?? [];
  return result.map((job) => normalizeAgentJob(job, hit, query));
}

async function verifyApplicationLinks(jobs: Job[], apiKey: string): Promise<{ jobs: Job[]; partial: boolean }> {
  const urls = Array.from(new Set(jobs.flatMap((job) => job.applyUrl ? [job.applyUrl] : [])));
  if (!urls.length) return { jobs, partial: false };
  const checkedUrls = urls.slice(0, 6);
  const response = await fetch(FETCH_ENDPOINT, {
    method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: checkedUrls, format: "markdown", ttl: 0, per_url_timeout_ms: 8000, purpose: "Check whether this job application page is reachable and explicitly says the job is closed or no longer accepting applications" }),
    signal: AbortSignal.timeout(11000), cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as { results?: FetchedPage[]; errors?: FetchError[] };
  if (!response.ok) throw upstreamError(response.status, body);
  const resultByUrl = new Map((body.results ?? []).map((page) => [page.url, page]));
  const errorsByUrl = new Map((body.errors ?? []).map((item) => [item.url, item]));
  const checked = new Set(checkedUrls);
  const normalized = jobs.map((job) => {
    const url = job.applyUrl;
    if (!url || !checked.has(url)) return job;
    const page = resultByUrl.get(url);
    const error = errorsByUrl.get(url);
    if (page) {
      const text = typeof page.text === "string" ? page.text : "";
      if (/no longer accepting|position (?:has been )?filled|job (?:has )?expired|applications? (?:are )?closed|requisition (?:is )?closed/i.test(text)) return { ...job, listingStatus: "closed" as const, verificationConfidence: 0.95 };
      return { ...job, listingStatus: "verified" as const, verificationConfidence: 0.85 };
    }
    if (error && (error.error === "page_not_found" || error.status === 404 || error.status === 410)) return { ...job, listingStatus: "possibly_expired" as const, verificationConfidence: 0.7 };
    return job;
  });
  return { jobs: normalized, partial: urls.length > checkedUrls.length || (body.errors ?? []).some((item) => item.error !== "page_not_found") };
}

function normalizePage(hit: SearchHit, page: FetchedPage, input: ReturnType<typeof SearchInputSchema.parse>): Job | null {
  if (isSearchResultsPage(hit)) return null;
  const text = typeof page.text === "string" ? page.text : "";
  const title = clean(page.title || hit.title.replace(/\s+[|–-].*$/, ""));
  const company = extractCompany(hit.site_name, title, hit.url);
  const applyUrl = findApplyLink(page.links ?? [], hit.url);
  const description = clean((page.description || hit.snippet || text.slice(0, 800)).slice(0, 1400)) || null;
  const structured = extractFields(`${page.title ?? ""}\n${page.description ?? ""}\n${hit.snippet}\n${text.slice(0, 6000)}`);
  const partial = { title, description, location: structured.location ?? (input.location && text.toLowerCase().includes(input.location.toLowerCase()) ? input.location : null), employmentType: structured.employmentType, experienceLevel: structured.experienceLevel, requiredSkills: structured.skills, preferredSkills: [], educationRequirements: structured.educationRequirements, graduationYearRequirements: structured.graduationYearRequirements, compensation: structured.compensation, compensationAmount: structured.compensationAmount, compensationCurrency: structured.compensationCurrency, compensationPeriod: structured.compensationPeriod, postingDate: hit.date ?? structured.postingDate, deadline: structured.deadline, visaSponsorship: normalizeVisa(text), workAuthorization: structured.workAuthorization };
  const match = calculateMatch({ ...partial, location: partial.location, employmentType: partial.employmentType, experienceLevel: partial.experienceLevel }, input);
  return { id: stableId(hit.url), ...partial, company, companyUrl: hit.url, applyUrl, source: hit.site_name || new URL(hit.url).hostname, workArrangement: structured.workArrangement, lastChecked: new Date().toISOString(), listingStatus: /closed|no longer accepting|position filled|job has expired|applications closed/i.test(text) ? "closed" : "needs_verification", verificationConfidence: 0.4, matchScore: match.matchScore, matchReasons: match.matchReasons, matchBreakdown: match.matchBreakdown, rawSnippet: hit.snippet };
}

function isSearchResultsPage(hit: SearchHit) {
  const text = `${hit.title} ${hit.url}`;
  if (/\b(?:search results|job search|jobs?\s+(?:in|near|around)\s|internships?\s+(?:in|near|around)\s|\d[\d,.]*\s+(?:open\s+)?(?:jobs?|internships?|vacancies)\b|(?:jobs?|internships?)\s+available)\b/i.test(hit.title)) return true;
  try { const path = new URL(hit.url).pathname; return /\/(?:q-|jobs?[-_]search|search[-_]jobs)[^/]*-jobs?\.html$/i.test(path) || /\/(?:jobs?|internships?)\/(?:search|browse)(?:\/|$)/i.test(path); } catch { return /\bjob search\b/i.test(text); }
}

function normalizeAgentJob(job: AgentJob, hit: SearchHit, query: string): Job {
  const input = SearchInputSchema.parse({ query });
  const employment = normalizeEmployment(job.employment_type);
  const arrangement = normalizeArrangement(job.work_arrangement);
  const status = /closed|filled|expired/i.test(job.status ?? "") ? "closed" : /\b(open|active|accepting applications)\b/i.test(job.status ?? "") ? "verified" : "needs_verification";
  const compensation = extractFields(job.compensation ?? "");
  const partial = { title: clean(job.title), description: clean(job.description ?? "").slice(0, 4000) || null, location: clean(job.location ?? "") || null, employmentType: employment, experienceLevel: job.experience_level ?? null, requiredSkills: job.required_skills ?? [], preferredSkills: [], educationRequirements: job.education_requirements ?? null, graduationYearRequirements: job.graduation_year_requirements ?? null, compensation: job.compensation ?? null, compensationAmount: compensation.compensationAmount, compensationCurrency: compensation.compensationCurrency, compensationPeriod: compensation.compensationPeriod, postingDate: job.posting_date ?? null, deadline: job.deadline ?? null, visaSponsorship: normalizeVisa(job.visa_sponsorship), workAuthorization: job.work_authorization ?? null };
  const match = calculateMatch({ ...partial, location: partial.location, employmentType: partial.employmentType, experienceLevel: partial.experienceLevel }, input);
  return { id: stableId(job.apply_url || `${hit.url}|${job.title}`), ...partial, company: job.company ?? extractCompany(hit.site_name, hit.title, hit.url), companyUrl: hit.url, applyUrl: validHttpUrl(job.apply_url), source: hit.site_name, workArrangement: arrangement, lastChecked: new Date().toISOString(), listingStatus: status, verificationConfidence: status === "verified" ? 0.85 : 0.6, matchScore: match.matchScore, matchReasons: match.matchReasons, matchBreakdown: match.matchBreakdown, rawSnippet: hit.snippet };
}

function extractFields(text: string) {
  const locationMatch = text.match(/(?:location|based in|work location)\s*[:–-]?\s*([^\n|]{3,80})/i);
  const compensationMatch = text.match(/(?:([$₹£€])\s*([\d,.]+)\s*(k|lpa|lakhs?)?|([\d,.]+)\s*(USD|INR|GBP|EUR|CAD|AUD)\s*(k|lpa|lakhs?)?)(?:\s*(?:\/|per)\s*(hour|hr|month|mo|year|yr|annum))?/i);
  const compensation = compensationMatch?.[0] ?? text.match(/(?:\$|₹|£|€)\s?[\d,]+(?:\s?[-–to]+\s?(?:\$|₹|£|€)?\s?[\d,]+)?(?:\s?(?:\/\s?(?:hr|hour|month|year|annum)|per\s+(?:hour|month|year)|\s?(?:k|lpa|lakh|lakhs)))?/i)?.[0] ?? null;
  const amount = Number((compensationMatch?.[2] ?? compensationMatch?.[4] ?? "").replace(/,/g, ""));
  const multiplier = /lpa|lakhs?/i.test(compensationMatch?.[3] ?? compensationMatch?.[6] ?? "") ? 100000 : /k/i.test(compensationMatch?.[3] ?? compensationMatch?.[6] ?? "") ? 1000 : 1;
  const symbol = compensationMatch?.[1];
  const code = compensationMatch?.[5]?.toUpperCase() ?? ({ "$": "USD", "₹": "INR", "£": "GBP", "€": "EUR" } as Record<string, string>)[symbol ?? ""] ?? null;
  const periodText = (compensationMatch?.[7] ?? "").toLowerCase();
  const compensationPeriod = /hour|hr/.test(periodText) ? "hour" : /month|mo/.test(periodText) ? "month" : /year|yr|annum/.test(periodText) || multiplier > 1 ? "year" : null;
  const deadline = text.match(/(?:deadline|apply by|application closes?)\s*[:–-]?\s*([^\n.]{3,50})/i)?.[1]?.trim() ?? null;
  const postingDate = text.match(/(?:posted|published)\s*(?:on)?\s*[:–-]?\s*([^\n.]{3,40})/i)?.[1]?.trim() ?? null;
  const skills = ["Python", "SQL", "JavaScript", "TypeScript", "React", "Java", "C++", "Machine Learning", "AWS", "Excel", "Figma", "Docker"].filter((skill) => new RegExp(`\\b${skill.replace(/[+]/g, "\\+")}\\b`, "i").test(text));
  const graduationYearRequirements = text.match(/\b(?:graduating|graduation|class of)\s*(?:in\s*)?(20\d{2}(?:\s*(?:-|–|to)\s*20\d{2})?)/i)?.[0] ?? null;
  const educationRequirements = text.match(/\b(?:bachelor'?s?|master'?s?|b\.?tech|b\.?e\.?|m\.?tech|degree|graduate|undergraduate)[^\n.]{0,100}/i)?.[0]?.trim() ?? null;
  const experienceLevel = text.match(/\b(?:entry[- ]level|new grad(?:uate)?|intern(?:ship)?|junior|mid[- ]level|senior|[1-5]\+? years? of experience)\b/i)?.[0] ?? null;
  const workAuthorization = text.match(/(?:authorized to work|work authorization|right to work)[^\n.]{0,120}/i)?.[0]?.trim() ?? null;
  return { location: locationMatch?.[1]?.trim() ?? null, compensation, compensationAmount: Number.isFinite(amount) && amount > 0 ? amount * multiplier : null, compensationCurrency: code, compensationPeriod, deadline, postingDate, skills, employmentType: normalizeEmployment(text), workArrangement: normalizeArrangement(text), educationRequirements, graduationYearRequirements, experienceLevel, workAuthorization };
}
function normalizeEmployment(value?: string | null): Job["employmentType"] { const v = (value ?? "").toLowerCase(); return /intern|co-op|apprentice/.test(v) ? "Internship" : /full.?time|permanent/.test(v) ? "Full-time" : /part.?time/.test(v) ? "Part-time" : /contract|freelance/.test(v) ? "Contract" : "Unknown"; }
function normalizeArrangement(value?: string | null): Job["workArrangement"] { const v = (value ?? "").toLowerCase(); return /remote|work from home/.test(v) ? "Remote" : /hybrid/.test(v) ? "Hybrid" : /on.?site|in.?office/.test(v) ? "On-site" : "Unknown"; }
function normalizeVisa(value?: string | null): Job["visaSponsorship"] { const v = (value ?? "").toLowerCase(); return /not available|no sponsorship|cannot sponsor|does not sponsor/.test(v) ? "unavailable" : /sponsor|visa available/.test(v) ? "offered" : /confirm|contact/.test(v) ? "confirm" : "unspecified"; }
function extractCompany(site: string, title: string, url: string) { const suffix = title.match(/[|–-]\s*([^|–-]+)$/)?.[1]?.trim(); if (suffix && !/jobs?|careers?|linkedin/i.test(suffix)) return suffix; try { return site || new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { return site || null; } }
function findApplyLink(links: string[], pageUrl: string) { const candidate = links.find((link) => /apply|job.?detail|requisition|opening|positions?/i.test(link) && !/linkedin|indeed|glassdoor/i.test(link)); if (candidate) return validHttpUrl(candidate); return /\/jobs?\/|\/careers?\/.*(?:job|opening|role|requisition)|\/positions?\//i.test(new URL(pageUrl).pathname) ? pageUrl : null; }
function validHttpUrl(value?: string | null) { try { if (!value) return null; const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.toString() : null; } catch { return null; } }
function clean(value: string) { return value.replace(/\s+/g, " ").trim(); }
function stableId(value: string) { let hash = 0; for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0; return `job-${Math.abs(hash).toString(36)}`; }
function deduplicateHits(hits: SearchHit[]) { const seen = new Set<string>(); return hits.filter((hit) => { if (!validHttpUrl(hit.url) || seen.has(hit.url)) return false; seen.add(hit.url); return true; }); }
function upstreamError(status: number, body: unknown): TinyFishError { const code = status === 429 ? "RATE_LIMITED" : status === 401 ? "INVALID_API_KEY" : status === 402 ? "CREDITS_EXHAUSTED" : status >= 500 ? "TINYFISH_UNAVAILABLE" : "TINYFISH_ERROR"; const message = status === 429 ? "TinyFish is receiving too many requests. Wait a moment and retry." : status === 401 ? "TinyFish rejected the API key. Check TINYFISH_API_KEY in your environment." : status === 402 ? "TinyFish usage credits are unavailable. Check your TinyFish account." : status >= 500 ? "TinyFish is temporarily unavailable. Please retry shortly." : `TinyFish returned an error (${status}).`; return new TinyFishError(status === 429 ? 429 : status === 401 ? 401 : status === 402 ? 402 : 502, code, `${message} ${body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : ""}`.trim()); }
