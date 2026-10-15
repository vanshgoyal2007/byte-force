import { z } from "zod";

export const JobSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string().nullable(),
  companyUrl: z.string().nullable(),
  applyUrl: z.string().nullable(),
  source: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  workArrangement: z.enum(["Remote", "Hybrid", "On-site", "Unknown"]),
  employmentType: z.enum(["Internship", "Full-time", "Part-time", "Contract", "Unknown"]),
  experienceLevel: z.string().nullable(),
  requiredSkills: z.array(z.string()),
  preferredSkills: z.array(z.string()),
  educationRequirements: z.string().nullable(),
  graduationYearRequirements: z.string().nullable(),
  compensation: z.string().nullable(),
  compensationAmount: z.number().nullable(),
  compensationCurrency: z.string().nullable(),
  compensationPeriod: z.string().nullable(),
  postingDate: z.string().nullable(),
  deadline: z.string().nullable(),
  visaSponsorship: z.enum(["offered", "unavailable", "unspecified", "confirm"]),
  workAuthorization: z.string().nullable(),
  lastChecked: z.string(),
  listingStatus: z.enum(["verified", "needs_verification", "possibly_expired", "closed", "conflicting"]),
  verificationConfidence: z.number().min(0).max(1),
  matchScore: z.number().min(0).max(100),
  matchReasons: z.array(z.string()),
  matchBreakdown: z.array(z.object({ label: z.string(), score: z.number(), weight: z.number(), evidence: z.string() })),
  rawSnippet: z.string().nullable(),
});

export type Job = z.infer<typeof JobSchema>;

export const SearchInputSchema = z.object({
  query: z.string().trim().max(500).default(""),
  role: z.string().trim().max(120).default(""),
  location: z.string().trim().max(120).default(""),
  opportunityType: z.enum(["Any type", "Internship", "Full-time", "Both"]).default("Any type"),
  experienceLevel: z.string().trim().max(80).default("Any level"),
  skills: z.array(z.string().trim().max(60)).max(30).default([]),
  graduationYear: z.string().trim().max(8).optional(),
  workArrangement: z.string().trim().max(30).optional(),
  minCompensation: z.number().nonnegative().optional(),
  minCompensationCurrency: z.string().trim().max(3).optional(),
  minCompensationPeriod: z.string().trim().max(20).optional(),
  visaSponsorshipPreference: z.enum(["Any", "Required", "Not required"]).default("Any"),
  workAuthorization: z.string().trim().max(180).optional(),
  degree: z.string().trim().max(100).optional(),
  branch: z.string().trim().max(100).optional(),
  targetCompanies: z.array(z.string().trim().max(100)).max(20).default([]),
  industries: z.array(z.string().trim().max(100)).max(20).default([]),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

const skillBank = ["Python", "SQL", "JavaScript", "TypeScript", "React", "Java", "C++", "Machine Learning", "Data Analysis", "Excel", "AWS", "Docker", "Communication", "Product Management", "Figma"];

export function calculateMatch(job: Pick<Job, "title" | "description" | "location" | "employmentType" | "experienceLevel" | "requiredSkills" | "preferredSkills" | "educationRequirements" | "graduationYearRequirements" | "compensation" | "compensationAmount" | "compensationCurrency" | "compensationPeriod" | "visaSponsorship" | "workAuthorization">, input: SearchInput) {
  const text = `${job.title} ${job.description ?? ""} ${job.requiredSkills.join(" ")} ${job.preferredSkills.join(" ")}`.toLowerCase();
  const wantedRole = (input.role || input.query).toLowerCase();
  const roleScore = wantedRole ? (job.title.toLowerCase().includes(wantedRole) || wantedRole.split(/\s+/).some((w) => w.length > 3 && job.title.toLowerCase().includes(w)) ? 1 : wantedRole.split(/\s+/).filter((w) => w.length > 3 && text.includes(w)).length / Math.max(1, wantedRole.split(/\s+/).filter((w) => w.length > 3).length)) : 0.55;
  const desiredSkills = Array.from(new Set([...input.skills, ...(input.query ? skillBank.filter((skill) => input.query.toLowerCase().includes(skill.toLowerCase())) : [])]));
  const matchedSkills = desiredSkills.filter((skill) => text.includes(skill.toLowerCase()));
  const skillScore = desiredSkills.length ? matchedSkills.length / desiredSkills.length : 0.55;
  const locationScore = input.location ? (job.location?.toLowerCase().includes(input.location.toLowerCase()) ? 1 : job.location ? 0 : 0.5) : 0.5;
  const typeScore = input.opportunityType === "Any type" || input.opportunityType === "Both" ? 0.5 : job.employmentType === input.opportunityType ? 1 : job.employmentType === "Unknown" ? 0.5 : 0;
  const experienceText = (job.experienceLevel ?? "").toLowerCase();
  const levelMatches = input.experienceLevel === "Student / Intern" ? /intern|student|co-?op|apprentice/.test(experienceText) : input.experienceLevel === "Entry level" ? /entry|new grad|fresher|junior|intern/.test(experienceText) : input.experienceLevel === "Junior" ? /junior|entry/.test(experienceText) : experienceText.includes(input.experienceLevel.toLowerCase());
  const levelScore = input.experienceLevel === "Any level" || !input.experienceLevel ? 0.5 : levelMatches ? 1 : job.experienceLevel ? 0 : 0.5;
  const educationChecks = [input.graduationYear ? (job.graduationYearRequirements ? (job.graduationYearRequirements.includes(input.graduationYear) ? 1 : 0) : 0.5) : null, input.degree ? (job.educationRequirements ? (job.educationRequirements.toLowerCase().includes(input.degree.toLowerCase()) ? 1 : 0) : 0.5) : null, input.branch ? (job.educationRequirements ? (job.educationRequirements.toLowerCase().includes(input.branch.toLowerCase()) ? 1 : 0) : 0.5) : null].filter((score): score is number => score !== null);
  const educationScore = educationChecks.length ? educationChecks.reduce((sum, score) => sum + score, 0) / educationChecks.length : 0.5;
  const hasComparableCompensation = input.minCompensation !== undefined && job.compensationAmount !== null && job.compensationAmount !== undefined && input.minCompensationCurrency?.toUpperCase() === job.compensationCurrency?.toUpperCase() && input.minCompensationPeriod === job.compensationPeriod;
  const compensationScore = hasComparableCompensation ? (job.compensationAmount! >= input.minCompensation! ? 1 : 0) : 0.5;
  const visaScore = input.visaSponsorshipPreference === "Any" ? 0.5 : job.visaSponsorship === "unspecified" || job.visaSponsorship === "confirm" ? 0.5 : input.visaSponsorshipPreference === "Required" ? (job.visaSponsorship === "offered" ? 1 : 0) : (job.visaSponsorship === "unavailable" ? 1 : 0.5);
  const workAuthScore = input.workAuthorization ? (job.workAuthorization ? (job.workAuthorization.toLowerCase().includes(input.workAuthorization.toLowerCase()) || input.workAuthorization.toLowerCase().includes(job.workAuthorization.toLowerCase()) ? 1 : 0) : 0.5) : 0.5;
  const weights = [24, 24, 14, 10, 7, 8, 5, 4, 4];
  const scores = [roleScore, skillScore, locationScore, typeScore, levelScore, educationScore, compensationScore, visaScore, workAuthScore];
  const labels = ["Role relevance", "Skills overlap", "Location", "Opportunity type", "Experience level", "Education & graduation", "Compensation", "Visa sponsorship", "Work authorization"];
  const educationEvidence = [input.degree ? `Degree ${job.educationRequirements ? job.educationRequirements.toLowerCase().includes(input.degree.toLowerCase()) ? "appears in stated requirements" : "not found in stated requirements" : "not confirmed"}` : "", input.branch ? `Branch ${job.educationRequirements ? job.educationRequirements.toLowerCase().includes(input.branch.toLowerCase()) ? "appears in stated requirements" : "not found in stated requirements" : "not confirmed"}` : "", input.graduationYear ? `Graduation ${job.graduationYearRequirements ? job.graduationYearRequirements.includes(input.graduationYear) ? "year appears in stated criteria" : "year not found in stated criteria" : "eligibility not confirmed"}` : ""].filter(Boolean).join("; ");
  const evidence = [roleScore >= 0.8 ? "Title and role terms align" : "Partial role-term overlap", desiredSkills.length ? `${matchedSkills.length} of ${desiredSkills.length} selected skills found` : "No skill preference supplied", input.location ? (locationScore === 1 ? "Preferred location appears in listing" : job.location ? "Listing location differs" : "Location not specified") : "No location preference supplied", input.opportunityType === "Any type" || input.opportunityType === "Both" ? "No opportunity-type preference" : job.employmentType === "Unknown" ? "Opportunity type not specified" : `${job.employmentType} listed`, input.experienceLevel === "Any level" ? "No experience-level preference" : job.experienceLevel ?? "Experience level not specified", educationEvidence || job.educationRequirements || job.graduationYearRequirements || "No education preference supplied", hasComparableCompensation ? `${job.compensationCurrency} ${job.compensationAmount} / ${job.compensationPeriod}; ${compensationScore ? "meets" : "below"} minimum` : input.minCompensation !== undefined ? "Compensation not published in a comparable currency and period" : "No compensation preference supplied", input.visaSponsorshipPreference === "Any" ? `No sponsorship preference; listing says ${job.visaSponsorship}` : job.visaSponsorship === "unspecified" || job.visaSponsorship === "confirm" ? `Sponsorship ${job.visaSponsorship}; eligibility remains unknown` : `Sponsorship explicitly ${job.visaSponsorship}`, input.workAuthorization ? (job.workAuthorization ? `Listing states: ${job.workAuthorization}` : "Work authorization not specified") : "No work-authorization preference supplied"];
  const breakdown = scores.map((score, i) => ({ label: labels[i], score: Math.round(score * 100), weight: weights[i], evidence: evidence[i] }));
  return { matchScore: Math.round(scores.reduce((sum, score, i) => sum + score * weights[i], 0)), matchReasons: breakdown.filter((item) => item.score >= 70).slice(0, 3).map((item) => item.evidence), matchBreakdown: breakdown };
}

export function deduplicateJobs(jobs: Job[]): Job[] {
  const byKey = new Map<string, Job>();
  const canonicalKeys = new Map<string, string>();
  for (const job of jobs) {
    const canonical = canonicalize(job.applyUrl ?? job.companyUrl);
    const fallback = `${job.company ?? ""}|${job.title}|${job.location ?? ""}`.toLowerCase().replace(/[^a-z0-9|]/g, "").replace(/\|+/g, "|");
    const exactKey = canonical || fallback;
    const fuzzyKey = [...byKey.entries()].find(([, current]) => fuzzyDuplicate(job, current))?.[0];
    const key = canonicalKeys.get(exactKey) ?? fuzzyKey ?? exactKey;
    canonicalKeys.set(exactKey, key);
    const current = byKey.get(key);
    if (!current || completeness(job) > completeness(current)) byKey.set(key, job);
  }
  return Array.from(byKey.values());
}

function fuzzyDuplicate(left: Job, right: Job) {
  if (hasDistinctJobUrls(left, right)) return false;
  const companyLeft = normalizeWords(left.company ?? "");
  const companyRight = normalizeWords(right.company ?? "");
  if (!companyLeft || companyLeft !== companyRight) return false;
  const titleSimilarity = tokenSimilarity(left.title, right.title);
  const locationLeft = normalizeWords(left.location ?? "");
  const locationRight = normalizeWords(right.location ?? "");
  const sameLocation = !locationLeft || !locationRight || locationLeft === locationRight;
  return titleSimilarity >= 0.82 && sameLocation;
}

function hasDistinctJobUrls(left: Job, right: Job) {
  if (!left.applyUrl || !right.applyUrl) return false;
  const leftCanonical = canonicalize(left.applyUrl);
  const rightCanonical = canonicalize(right.applyUrl);
  if (!leftCanonical || leftCanonical === rightCanonical) return false;
  const hasJobId = (value: string) => /\/(?:jobs?|positions?|requisitions?)\/[^/?#]+/i.test(new URL(value).pathname);
  try { return hasJobId(leftCanonical) && hasJobId(rightCanonical); } catch { return false; }
}

function normalizeWords(value: string) { return value.toLowerCase().replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc|plc)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " "); }
function tokenSimilarity(left: string, right: string) { const normalizeTitleTokens = (value: string) => normalizeWords(value).split(" ").filter(Boolean).map((token) => token.replace(/^intern(ship)?s?$/, "intern")); const a = new Set(normalizeTitleTokens(left)); const b = new Set(normalizeTitleTokens(right)); if (!a.size || !b.size) return 0; const intersection = Array.from(a).filter((token) => b.has(token)).length; return intersection / (a.size + b.size - intersection); }

function canonicalize(value: string | null) {
  if (!value) return "";
  try { const url = new URL(value); url.hash = ""; ["utm_source", "utm_medium", "utm_campaign", "ref", "source"].forEach((key) => url.searchParams.delete(key)); return url.toString().replace(/\/$/, "").toLowerCase(); } catch { return ""; }
}
function completeness(job: Job) { return [job.description, job.company, job.location, job.compensation, job.deadline, job.applyUrl].filter(Boolean).length + job.requiredSkills.length; }
