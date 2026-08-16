# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**quappe-service** is the Quappe **API + storage + all domain logic** — the
single source of truth every client talks to. It is a **headless SvelteKit app**:
only `/api/*` routes, no UI. The browser UI lives in a separate repo
(`quappe-web`) and reaches this service over the API. Other future clients
(CLI, app, analytics) are also just API consumers.

The API is the contract. Keep it stable and explicit.

## Commands

- `npm run dev` — start the API on http://localhost:5273. Seeds ~200 theses on the first authenticated request.
- `npm run dev:all` — same, plus `ollama serve` in parallel (needed for `/api/reports/*` LLM features).
- `npm run build` / `npm run preview` — production build + local preview.
- `npm run check` — `svelte-kit sync` + `svelte-check`. This is the type-check; there is no separate lint or test suite. (Expect one harmless warning: no Svelte files, since this app is headless.)
- `npm run paraglide:compile` — regenerate `src/lib/paraglide/` after editing `messages/*.json` (used for localized LLM report output).
- `QUAPPE_SEED_COUNT=100000 npm run dev` — override seed size for stress tests.
- `QUAPPE_DB_PATH=/tmp/foo.db npm run dev` — point at a different SQLite file. Default is `.data/quappe.db`.

Env: `QUAPPE_SECRET` (JWT signing secret — set it in prod so identities survive restarts), plus Ollama defaults `OLLAMA_URL=http://127.0.0.1:11434`, `OLLAMA_MODEL=llama3.1:8b`, `OLLAMA_TIMEOUT=60000`. Without Ollama, report endpoints degrade to a "LLM unavailable" fallback — nothing else depends on it.

## Architecture

### Data layer — SQLite façade

State lives in `.data/quappe.db` (better-sqlite3, synchronous, WAL journal). **`src/lib/stores/data.ts` is a façade with ~38 exports that are the only surface every consumer imports.** Its internals delegate to `src/lib/server/db/*`.

- `src/lib/server/db/index.ts` — lazy singleton `getDb()`, module-scoped prepared-statement cache in `prepare(sql)`, `withTransaction(fn)`, `isDbEmpty()`. Schema in `schema.sql` runs on first `getDb()` call. `hooks.server.ts` eagerly calls `getDb()` at import time so tables exist before any handler runs.
- `theses.ts`, `arguments.ts`, `votes.ts`, `embeddings.ts` — one module per table, each exposing `dbGet*/dbInsert*/dbUpdate*/dbDelete*` helpers built on cached prepared statements.
- `mappers.ts` — row↔domain conversions (`rowToThesis(row, votes)` etc.) and `Float32Array ↔ Buffer` for embedding BLOBs. Reads always copy bytes into a fresh `ArrayBuffer` so the DB row buffer is never shared.

Non-obvious decisions to preserve:

- **Single `votes` table** with `(target_type, target_id, user_id)` PK — argument and thesis votes coexist so `getVotesByUserSince` is one query. FK integrity is enforced at the application layer; `arguments.thesis_id` has `ON DELETE CASCADE` but votes cleanup for cascaded arguments is manual.
- **Tier is derived, not stored.** Every "tier" query filters by `lifecycle_state`. Hot = `seedling|discussed|contested|crystallized`, warm = `faded`, cold = `dormant`.
- **Embedding warm cache.** `data.ts` holds `Map<string, Float32Array>` mirrors that lazy-load from `dbGetAllEmbeddings(...)`. Writes are write-through (Map + DB). Semantic search reads only from the Map.
- **In-memory derived caches stay in `data.ts`** (30 s TTL): `_heatCache`, `_argCountsCache`, `_activityCache`, `_dataVersion`/`bumpVersion()`. Every write path bumps the version to invalidate them.
- **Seed gate.** `seedData(devUserId?)` returns immediately if `dbTierStats().total > 0`. `seedOnce` in `dev-seed.ts` fires on the first authenticated request in dev.

### Domain model (`src/lib/models/types.ts`)

- `Thesis` has `lifecycle: LifecycleInfo` (state + `state_since` + `quality_score`), `lang?`, and optional reading registers `description_simple` / `description_dense` (author-authored; the original is the "prose" register).
- `Argument` has `stance: 'support' | 'reject'`, `attributes: ArgumentAttribute[]` (evidence type derived from URLs — no user picker), optional `forked_from_id`, and async-filled `categories?`. Evidence types: `study | authority | logical | experiential` (no "emotional").
- `Vote.weight` walks a Fibonacci ladder (1, 2, 3, 5, 8). Weight 1 is free; extra weight is drawn from a daily weight pool. Daily budgets (3 stance buckets à 8 + weight pool 21) are enforced **server-side** in `src/lib/server/budget.ts`; `limits.ts` holds length caps + rate limits. Identity is an anonymous server-minted **JWT** (`src/lib/server/identity.ts`); a fresh identity can't cast weighted votes for its first minute (Sybil dampener).

Lifecycle + quality are computed in `data.ts::reevaluateLifecycle(id)` (uses `models/lifecycle.ts`) on every mutating path. Quality rewards discourse depth + evidence + engagement over mere agreement; a decaying germination boost lets fresh positions surface; visibility is direction-neutral (support == reject).

### Server startup (`src/hooks.server.ts`)

Background loops kick off at module load (fire-and-forget): embedding warmup + backfill, pulse cache refresh (24 h), nightly argument categorization, nightly language backfill.

The `handle` hook wraps every request in `paraglideMiddleware` (locale for LLM report output), then `ensureUserId(cookies)` mints/verifies the JWT and sets `event.locals.user_id`. **Handlers never trust `author_id`/`user_id` from the request body.** API writes >32 KB are rejected before JSON parse.

### Identity across the split

`quappe-web` proxies `/api/*` to this service, so the httpOnly JWT cookie is
established on the web origin and forwarded transparently. This service is the
only place that mints or verifies identity.

### i18n (Paraglide)

Base locale `en`, plus `de/fr/es`. Messages in `messages/{locale}.json`, compiled into `src/lib/paraglide/` (git-ignored — regenerated by `prepare`). Used server-side to localize LLM report output.

### Embeddings & dependency advisories

Semantic search uses `@huggingface/transformers` (maintained successor to the archived `@xenova/transformers`) — server-side only, model `Xenova/multilingual-e5-small` (384-dim, q8-quantised), cached under `.cache/transformers`. `npm audit` flags `sharp` + `onnxruntime-node` (high), both transitive: `sharp` is never reached (text embeddings only); the onnx advisory concerns loading *untrusted* models, while we load a fixed trusted one. Assessed as ~nil real exposure. Do not `npm audit fix --force`. Both native deps are in Vite's `ssr.external` + `optimizeDeps.exclude`.

## Working in this codebase

- **Do not reintroduce in-memory Maps for domain data.** Every read/write goes through `data.ts` → `src/lib/server/db/*`. New query? Add a `dbGet*` helper.
- Consumer modules (`+server.ts` handlers, `hooks.server.ts`, `pulse.ts`, `similarity.ts`, `argument-categorization.ts`) only import from `$lib/stores/data`. Keep the façade's exports and signatures stable — they are the contract behind the API.
- **This repo has no UI.** If you find yourself adding a `.svelte` page here, it belongs in `quappe-web`.
- ISO-8601 strings are the canonical timestamp format (they sort lexicographically).
- Domain design decisions are documented in `.meta/*.skill` and `.meta/.project` — update them when you change a decision.

## Platform context

- **quappe-service** — this repo: API + DB + logic.
- **quappe-web** — the browser UI (proxies `/api/*` here).
- **quappe-ops** — operational setup (k8s, prometheus, logs). Later, when load demands it.
- **quappe-insight** — data visualisation / meta reporting. Later.
- **quappe-docs** — the idea, rules, design decisions. Later.
