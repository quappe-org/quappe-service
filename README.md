# quappe-service

The Quappe **API + storage + all domain logic** — the single source of truth
that every client (web, CLI, app, analytics) talks to.

Headless SvelteKit: only `/api/*` routes, no UI. State lives in SQLite
(`better-sqlite3`, WAL) via the `data.ts` façade. Anonymous identity is a
server-minted JWT cookie. Semantic search uses `@huggingface/transformers`
(server-side embeddings).

## Run

```bash
npm install
npm run dev          # http://localhost:5273  (seeds ~200 demo theses)
npm run dev:all      # + ollama serve (for /pulse and report LLM features)
npm run check        # type check
```

Env: `QUAPPE_SECRET` (JWT secret — set it in prod), `QUAPPE_DB_PATH`,
`OLLAMA_URL` / `OLLAMA_MODEL` / `OLLAMA_TIMEOUT`.

## The API contract

The OpenAPI 3.1 spec lives in [`openapi.yaml`](./openapi.yaml) and is served at
`GET /api/openapi`. It is the contract every client (web, future CLI/app/
analytics) builds against — keep it in sync when endpoints change.

## Part of the Quappe platform

- **quappe-service** — this repo: API + DB + logic.
- **quappe-web** — the browser UI (proxies `/api/*` here).
- **quappe-ops** — operational setup (k8s, prometheus, log shipping). Later.
- **quappe-insight** — data visualisation / meta reporting. Later.
- **quappe-docs** — the idea, the rules, the design decisions. Later.

The API is the contract. See `.meta/` for domain design decisions.

## License

PolyForm Noncommercial 1.0.0 — see [`LICENSE`](./LICENSE).
