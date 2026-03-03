# Athena Workshop Agent Notes

## Project Goal
Build a minimal Node.js HTTP server to manage AWS Athena queries.

## API Requirements
- `GET /database`: list Athena databases.
- `GET /database/:database/tables`: list tables for a selected Athena database.
- `GET /database/:database/:table/schema`: return schema (columns/types) for a selected table.
- `POST /query`: submit query from JSON body (`query`, optional `database`), generate and return identifier.
- `POST /query/validate`: validate SQL syntax using Athena `EXPLAIN` from JSON body (`query`, optional `database`); returns markers suitable for editor diagnostics.
- `GET /query`: list all queries and their metadata.
- `PUT /query/:id`: update query `name`, query body (`query`), and/or selected database (`database`).
- `DELETE /query/:id`: delete query metadata and any local downloaded results.
- `GET /query/:id/status`: return query state and metadata.
- `GET /query/:id/results`: return results and timestamp when available.
- `GET /query/:id/results/download`: download full query results in `csv`, `excel`/`xlsx`, or `parquet` format.
- `POST /query/:id/refresh`: rerun existing query and clear prior results.
- `POST /query/:id/cancel`: cancel running Athena query when possible.
- `GET /query/:id/results` also supports pagination query params: `limit`/`offset` and `page`/`size`.
- `POST /query/:id/assistant/send`: submit assistant prompt for a query and start an async assistant run.
- `GET /query/:id/assistant/status`: return assistant run state metadata for a query.
- `POST /query/:id/assistant/cancel`: request cancellation of active assistant run for a query.
- `POST /query/:id/assistant/compact`: compact conversation into a new session (`mode: empty|summarize`).
- `GET /query/:id/assistant/messages`: return persisted assistant conversation messages for a query.
- `GET /health`: health check endpoint.

## Behavior Requirements
- Unknown query id should return an appropriate response.
- Running query should return an appropriate response for results and refresh.
- Cancelled query should return an appropriate response for results.
- Completed query should not become cancelled.
- If query already cancelled/completed, cancel endpoint should return an appropriate response.
- Multiple queries must run in parallel.
- Backend should poll Athena for running query states.
- Concurrency protection required around query state updates.
- Only one assistant run can be active per query at a time; concurrent sends for the same query are rejected.
- Assistant runs are asynchronous and polled via status endpoint.
- Assistant cancellation is best-effort and should transition running sessions to cancelling/idle states.
- Assistant status should include cumulative token usage for the current provider session.
- Assistant compact should reject while a run is active; summarize compact should carry forward a summary into the new session.
- Assistant provider calls (OpenAI/Anthropic) do not use a local backend timeout; runs complete when response returns or are cancelled/failed.
- Assistant `run_read_query` tool safeguards:
  - read-only SQL verification via backend parser/tokenizer guard
  - hard row cap (`LIMIT 500`) enforced by backend query rewrite
  - max 5 tool executions per assistant run
  - optional result column cap (`maxColumns`, up to 50)
  - audit logging of original SQL, rewritten SQL, limits, and execution stats

## Storage Requirements
- Query metadata should be stored in a minimal DB (MySQL preferred).
- Each query has a `name` field; default name is the query identifier when created.
- Each query stores selected Athena `database`.
- Query result payloads may be large and should be stored in a project subfolder.
- Assistant conversation storage uses MySQL tables:
  - `assistant_sessions`
  - `assistant_messages`
  - `assistant_sessions.provider_conversation_id` stores provider conversation linkage when supported.
  - `assistant_messages.provider_response_id` stores provider response identifiers when available.

## Config Requirements
- Region/profile/S3 output/bucket settings and server settings in JSON config file.
- Assistant settings should be present in config (`assistant` block), supporting:
  - provider selection (`assistant.provider`)
  - env-var key resolution
  - optional config-file key fallback
  - configurable `assistantSeedInstruction` for first-message session seeding
  - configurable `maxToolRounds` for assistant tool-loop ceiling (default `1000`)
- Provider-specific settings should be present in config (`providers` block), including:
  - `providers.openai` (`model`, `baseURL`)
  - `providers.anthropic` (`model`, `baseURL`, `version`, `maxTokens`)
- Config file path should be passed via CLI when launching server.

## Documentation Requirements
- `README.md` and `AGENTS.md` must be kept up to date with the latest implementation changes.
- Any API, config, storage, or UI behavior change must update both files in the same change set.

## Logging Requirements
- Logs should be JSON and include timestamp, level, file, line, and descriptive messages.

## Routing Requirements
- Use a simple router with one handler per endpoint.
- Router should be authorization-capable (placeholder is acceptable now).

## Utility Requirements
- Include a bash script using curl that exercises all endpoint functionality.

## UI Requirements
- Serve a minimal HTML frontend at root (`/`).
- Use Monaco editor for SQL input and provide SQL formatting.
- Include submit control and results display area.
- Include a collapsible left-side schema tree of Athena tables and fields/types.

## Current Implementation Snapshot
- Express-based HTTP server with one handler per endpoint.
- MySQL-backed `queries` table for query metadata/state and selected Athena `database`.
- MySQL-backed `assistant_sessions` and `assistant_messages` tables for assistant conversation persistence.
- Athena integration using AWS SDK v3.
- Background poller updates state and downloads results on success.
- Per-query lock manager to avoid race conditions between poll/cancel/refresh.
- Results stored under configured `server.resultsDir` (default: `./results`) as `<query-id>.json`.
- JSON logger includes timestamp/level/file/line/message.
- Config loaded from `--config <path>`.
- Provider-agnostic assistant tool schemas are defined under `src/assistant/tools.js` and translated per provider.
- Assistant integration supports `openai` and `anthropic` providers via `/query/:id/assistant/*` endpoints with a shared tool-call execution loop.
- Assistant session seed instruction is configurable via `assistant.assistantSeedInstruction`.
- Assistant tool-loop ceiling is configurable via `assistant.maxToolRounds` (default `1000`), with cancellation expected via assistant cancel endpoint/UI when needed.
- Assistant tools include `run_read_query` for bounded read sampling (parser-guarded SELECT-only execution, max 500 rows, max 5 calls per run, capped columns, audit logging).
- Static frontend served from `/` with Monaco SQL editor, SQL format action, submit, polling, and results view.
- Monaco editor uses schema-aware autocomplete (keywords/tables/columns) and debounced backend validation markers.
- Frontend includes collapsible assistant panel (response display + prompt input) above query editor.
- Frontend assistant panel includes send/cancel controls, run status polling, elapsed run timer, and per-query conversation rendering from backend messages.
- Frontend assistant panel includes compact controls (`Compact`, `Compact + Summary`) and current-session token usage display.
- Frontend assistant panel renders assistant responses as sanitized Markdown (with plain-text fallback when Markdown libraries are unavailable).
- Frontend assistant panel shows optimistic user messages immediately on send and an animated typing indicator while assistant runs are active.
- Assistant response bubbles include a `Use` action that copies selected assistant output into the SQL editor.
- Frontend includes right-side query list populated from `/query`; selecting an item loads SQL and associated state/results.
- Right-side query list includes delete control for selected query and clears UI state after deletion.
- Results metadata panel includes `name` alongside Query ID/Status/timestamps.
- Query `name` is editable in the metadata panel and is persisted on field blur via `PUT /query/:identifier`.
- Frontend includes left-side Athena schema tree loaded via `/database/:database/tables` and `/database/:database/:table/schema`.
- Frontend prefetches table schemas in the background after table list load.
- Frontend includes editable textarea fallback if Monaco CDN loading fails.
- Results panel now separates query metadata fields from result payload rendering.
- If Athena response includes `columns`, rows are rendered using Tabulator with remote pagination; otherwise JSON is shown.
- Tabulator renders HTTP/HTTPS cell values as clickable links.
- If Tabulator is unavailable or fails to initialize, frontend falls back to a basic HTML table rendering.
- Tabular result rows support click-to-select highlighting in both Tabulator mode and basic HTML table fallback.
- Results panel includes full-results download controls with selectable format (`CSV`, `Excel`, `Parquet`) wired to `/query/:id/results/download`.
- `scripts/exercise.sh` validates base API behavior plus paginated results behavior, and supports SQL overrides via env vars (`QUERY1_SQL`, `QUERY2_SQL`, `PAGINATION_SQL`).
- `scripts/exercise-assistant.sh` validates assistant send/status/messages/cancel/compact behavior (including usage reporting/reset), logs request/response pairs to a file (`LOG_FILE`), and supports prompt/query overrides (`ASSISTANT_PROMPT`, `QUERY_SQL`; empty `QUERY_SQL` uses `SELECT 1` only for query creation).
- App construction is factored into `src/app.js` (`buildApp`) so endpoint tests can inject mocked services.
- Service orchestration is factored into `src/services/appServices.js` (`createServices`) so tests can reuse production service wiring.
- Endpoint tests are split by endpoint into separate files (`tests/query.create.test.js`, `tests/query.cancel.test.js`).
- Endpoint tests use Node's built-in test runner and validate `POST /query` and `POST /query/:id/cancel` with real `AthenaService` + `QueryStore` codepaths, mocking only AWS `client.send` and MySQL `pool.execute`.
- Shared test harness utilities live under `tests/helpers/serviceHarness.js`.
- `scripts/run-test-report.sh` writes timestamped test artifacts to `./results/test-runs/<timestamp>/` for iteration (`npm run test:post-query:report`, `npm run test:cancel-query:report`).
- Docker support is available via repo-root `Dockerfile` (runtime config injected via mounted `config.json` and `CONFIG_PATH` env var).
