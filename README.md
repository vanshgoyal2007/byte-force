# CareerPilot

**Find your next opportunity. Skip the noise.**

CareerPilot is a desktop-first job and internship discovery app. Live search is powered by TinyFish Search, Fetch, and Agent; it does not fill empty results with invented sample listings.

## Requirements

- Node.js 20.9 or newer
- npm
- TinyFish API key from the TinyFish dashboard

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and set `TINYFISH_API_KEY`.
3. Start the app with `npm run dev` and open the local address printed by Next.js.
4. Use Discover Jobs to enter a role, location, experience level, type, skills, or a natural-language query.

If the TinyFish key is absent, the live-search route returns an explicit setup message; there is no silent mock-data fallback. `TINYFISH_AGENT_ENABLED=false` disables the optional Agent pass while preserving Search and Fetch.

## Live search implementation

The backend uses official documented REST APIs and sends `X-API-Key` only from the server:

- **Search:** `GET https://api.search.tinyfish.ai` with query and geo-target parameters; discovers ranked job pages and listings.
- **Fetch:** `POST https://api.fetch.tinyfish.ai` with up to ten discovered URLs, `format: markdown`, links enabled, and `ttl: 0` to extract live page content and application links.
- **Agent:** `POST https://agent.tinyfish.ai/v1/automation/run` with documented `url`, `goal`, and `output_schema`; applied to up to two career-directory results to find listings that require navigation. Agent failures do not discard successful Search/Fetch results.

The server validates inbound search input, restricts returned apply links to HTTP(S), normalizes external information into the shared job schema, deduplicates canonical URLs and title/company/location fallbacks, and computes a transparent weighted preference score. Matching indicates preference fit, not qualification. Unknown eligibility stays unknown. Listing extraction from unstructured source pages is best-effort, so always review the employer page.

The TinyFish API contract was checked against the official docs: `https://docs.tinyfish.ai/search-api/reference`, `https://docs.tinyfish.ai/fetch-api/reference`, and `https://docs.tinyfish.ai/agent-api/reference`.

## Features and current limitations

- Live multi-query discovery, Fetch extraction, optional career-page Agent automation, partial-failure messaging, timeout/rate-limit/configuration errors.
- Explainable 0–100 weighted match scores; role, skills, location, opportunity type, experience and graduation criteria.
- Search results filters and sorting; details panel; direct source/application links; verification confidence/status warnings.
- Saved jobs, preferences, recent search history, and application stages/notes/dates are persisted in browser local storage only. There is no authentication or cross-device sync in this version.
- Application Kit, server-side account persistence, automatic expired-link probing and exhaustive legal/campus eligibility checks are not implemented. The UI does not claim these happened.
- TinyFish Search results and extracted pages are public-web snapshots; a source may be inaccessible, ambiguous, stale, or rate-limited. Verify time-sensitive details on the original employer listing.

## Checks

- `npm run typecheck`
- `npm test`
- `npm run build`

## Environment variables

See `.env.example`. Do not commit `.env.local` or expose `TINYFISH_API_KEY` to browser code.
