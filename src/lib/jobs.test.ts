import { describe, expect, it } from "vitest";
import { calculateMatch, deduplicateJobs, type Job, SearchInputSchema } from "./jobs";

const baseJob = (overrides: Partial<Job> = {}): Job => ({
  id: "one", title: "Software Engineer Intern", company: "Acme", companyUrl: "https://acme.example/careers/one?utm_source=search", applyUrl: "https://acme.example/jobs/1", source: "acme.example", description: "Build with Python and SQL", location: "Bengaluru", workArrangement: "Hybrid", employmentType: "Internship", experienceLevel: "Student / Intern", requiredSkills: ["Python", "SQL"], preferredSkills: [], educationRequirements: null, graduationYearRequirements: null, compensation: null, compensationAmount: null, compensationCurrency: null, compensationPeriod: null, postingDate: null, deadline: null, visaSponsorship: "unspecified", workAuthorization: null, lastChecked: "2026-10-14T00:00:00.000Z", listingStatus: "needs_verification", verificationConfidence: 0.4, matchScore: 0, matchReasons: [], matchBreakdown: [], rawSnippet: null, ...overrides,
});

describe("CareerPilot job logic", () => {
  it("validates and defaults empty optional search preferences", () => {
    expect(SearchInputSchema.parse({ query: "Data analyst in Delhi" })).toMatchObject({ query: "Data analyst in Delhi", skills: [], opportunityType: "Any type" });
  });
  it("scores match factors and provides evidence for each weighted dimension", () => {
    const input = SearchInputSchema.parse({ role: "Software Engineer", location: "Bengaluru", opportunityType: "Internship", experienceLevel: "Student / Intern", skills: ["Python", "SQL"] });
    const result = calculateMatch(baseJob(), input);
    expect(result.matchScore).toBeGreaterThanOrEqual(75);
    expect(result.matchScore).toBeLessThanOrEqual(100);
    expect(result.matchBreakdown).toHaveLength(9);
    expect(result.matchBreakdown[1].evidence).toBe("2 of 2 selected skills found");
  });
  it("keeps unknown education and incomparable compensation neutral", () => {
    const input = SearchInputSchema.parse({ role: "Software Engineer", degree: "B.Tech", graduationYear: "2027", minCompensation: 100000, minCompensationCurrency: "INR", minCompensationPeriod: "year" });
    const job = baseJob({ educationRequirements: null, graduationYearRequirements: null, compensationAmount: 95000, compensationCurrency: "USD", compensationPeriod: "year" });
    const result = calculateMatch(job, input);
    expect(result.matchBreakdown[5].score).toBe(50);
    expect(result.matchBreakdown[6].score).toBe(50);
    expect(result.matchBreakdown[5].evidence).toContain("not confirmed");
    expect(result.matchBreakdown[6].evidence).toContain("not published in a comparable currency");
  });
  it("distinguishes explicitly offered visa sponsorship from unspecified", () => {
    const input = SearchInputSchema.parse({ role: "Software Engineer", visaSponsorshipPreference: "Required" });
    const offered = calculateMatch(baseJob({ visaSponsorship: "offered" }), input);
    const unknown = calculateMatch(baseJob({ visaSponsorship: "unspecified" }), input);
    expect(offered.matchBreakdown[7].score).toBe(100);
    expect(unknown.matchBreakdown[7].score).toBe(50);
  });
  it("deduplicates tracking-parameter variants by the canonical application URL", () => {
    const first = baseJob({ id: "first", companyUrl: "https://acme.example/careers/one?utm_source=search" });
    const duplicate = baseJob({ id: "duplicate", companyUrl: "https://different.example/listing", applyUrl: "https://acme.example/jobs/1", description: "A longer and more complete description.", requiredSkills: ["Python", "SQL", "React"] });
    const result = deduplicateJobs([first, duplicate]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("duplicate");
  });
  it("retains different listings when canonical URLs differ", () => {
    expect(deduplicateJobs([baseJob(), baseJob({ id: "two", applyUrl: "https://acme.example/jobs/2" })])).toHaveLength(2);
  });
  it("fuzzy-deduplicates near-identical titles for the same employer and location", () => {
    const first = baseJob({ id: "a", title: "Software Engineer Intern", companyUrl: "https://jobs.example/search?q=intern", applyUrl: "https://jobs.example/search?q=intern" });
    const variant = baseJob({ id: "b", title: "Software Engineer Internship", companyUrl: "https://careers.example/listings?role=intern", applyUrl: "https://careers.example/listings?role=intern", description: "A more complete and detailed role description." });
    expect(deduplicateJobs([first, variant])).toHaveLength(1);
    expect(deduplicateJobs([first, baseJob({ id: "c", title: "Software Engineer Intern", company: "Other Co", applyUrl: "https://other.example/jobs/1" })])).toHaveLength(2);
  });
});
