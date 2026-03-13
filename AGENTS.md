# Athena Workshop Agent Notes

Before making changes, scan the repository tree for additional `AGENTS.md` files and follow the most specific one for the files you touch. Only update the `AGENTS.md` and `README.md` that apply to the current workspace, and do not copy tool-specific or business-proprietary details from subfolders such as `tools/` back into the top-level project docs.

## Project Goal
Build a minimal Node.js HTTP server to manage AWS Athena queries.

## API Requirements
- `GET /auth/me`: return current authenticated user profile and roles, or unauthenticated state, plus auth mode and enabled sign-in providers.
- `POST /auth/login`: authenticate a local account by email/password and start a session.
- `GET /auth/login/google`: start Google OIDC login.
- `GET /auth/google/callback`: complete Google OIDC login.
- `POST /auth/logout`: destroy the authenticated session.
- `GET /database`: list Athena databases.
- `GET /database/:database/tables`: list tables for a selected Athena database.
- `GET /database/:database/:table/schema`: return schema (columns/types) for a selected table.
- `POST /query`: submit query from JSON body (`query`, optional `database`), generate and return identifier.
- `POST /query/validate`: validate SQL syntax using Athena `EXPLAIN` from JSON body (`query`, optional `database`); returns markers suitable for editor diagnostics.
- `GET /query`: list all queries and their metadata.
- `GET /?query=<query-id>` on the frontend should deep-link the UI to a selected query for any authenticated user with access.
- `PUT /query/:id`: update query `name`, query body (`query`), and/or selected database (`database`).
- `DELETE /query/:id`: delete query metadata and the local query result/tool-artifact directory tree.
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
- `GET /query/:id/assistant/messages`: return persisted assistant conversation messages for a query across the query's assistant sessions; compaction summaries remain part of the visible conversation.
- `GET /users`: list users (admin only).
- `GET /users/:id`: fetch a specific user (self or admin).
- `PUT /users/:id`: update a specific user profile and, when authorized, their password.
- `DELETE /users/:id`: disable a user (admin only).
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
- Assistant message history remains visible across compacted sessions for the same query; summarize compact adds its summary as part of the visible conversation.
- When a query's stored SQL text or selected database changes, the next assistant send automatically rolls over to a new summarized session so the provider context is re-grounded on the latest query while prior guidance is retained.
- Assistant provider calls (OpenAI/Anthropic) do not use a local backend timeout; runs complete when response returns or are cancelled/failed.
- Enabled auth mode supports Google OIDC, local email/password accounts, or both.
- Any Google account may authenticate; local users are auto-created on first successful login.
- Local accounts are created/administered by admins via backend tooling; there is no self-registration flow.
- Session-backed auth uses MySQL persistence; disabled users lose access on their next request.
- OIDC-created users default to an invalid local password hash and cannot use local sign-in until an admin sets a password.
- Self-service password changes require the current password; admins may set/reset any user password.
- `admin` is a read/manage/delete role, not an implicit query-execution role.
- `querier` owns query mutation and assistant-send operations.
- `viewer` can read all queries, download results, and read assistant conversations.
- Query list supports optional `userId` filtering; the frontend initially requests only the authenticated user’s queries.
- Frontend mirrors the selected query into the browser URL as `?query=<query-id>` and should load deep-linked accessible queries even if they fall outside the current query-list filter.
- Assistant `run_read_query` tool safeguards:
  - read-only SQL verification via backend parser/tokenizer guard
  - `TRUNCATE(...)` numeric function usage is allowed for read queries; destructive `TRUNCATE TABLE`/statement usage remains blocked
  - hard row cap (`LIMIT 500`) enforced by backend query rewrite
  - max 5 tool executions per assistant run
  - optional result column cap (`maxColumns`, up to 50)
  - audit logging of original SQL, rewritten SQL, limits, and execution stats
- Assistant includes built-in `search_tools` for discovery of built-in and configured assistant tools.
- Configured assistant tools execute sequentially within a single assistant run.
- Configured assistant tools run with explicit child-process environments only; the parent server environment is not inherited.

## Storage Requirements
- Query metadata should be stored in a minimal DB (MySQL preferred).
- Each query has a `name` field; default name is the query identifier when created.
- Each query stores selected Athena `database`.
- Each query stores nullable `created_by_user_id`; legacy pre-auth rows may remain unowned.
- Query result payloads may be large and should be stored in a project subfolder.
- Query result cache and assistant tool artifacts should be stored under `server.resultsDir/<query-id>/`.
- Cached result payload should live at `server.resultsDir/<query-id>/result.json`.
- Query-scoped assistant tool folders should include:
  - `tools/workspace/`
  - `tools/tmp/`
  - `tools/runs/<assistant-session-id>/<tool-call-id>/`
- Dockerized deployments should persist MySQL data in a Docker volume and query result files in a host-mounted project folder so they survive container replacement.
- User/auth storage uses MySQL tables:
  - `users`
  - `user_identities`
  - `roles`
  - `user_roles`
  - `user_sessions`
- Assistant conversation storage uses MySQL tables:
  - `assistant_sessions`
  - `assistant_messages`
  - `assistant_sessions.provider_conversation_id` stores provider conversation linkage when supported.
  - `assistant_messages.provider_response_id` stores provider response identifiers when available.

## Config Requirements
- Region/profile/S3 output/bucket settings and server settings in JSON config file.
- Auth settings should be present in config (`auth` block), supporting:
  - `auth.mode` (`enabled` | `disabled`)
  - `auth.baseURL`
  - `auth.sessionSecret`
  - `auth.sessionCookieName`
  - `auth.sessionMaxAgeMs`
  - `auth.secureCookies`
  - `auth.devUser` (`id`, `email`, `firstName`, `lastName`, `roles`) for local bypass mode
  - `auth.google` (`enabled`, `issuer`, `clientId`, `clientSecret`)
  - `auth.local` (`enabled`, optional `passwordPepperEnvVar`, optional `passwordPepper`)
- Assistant settings should be present in config (`assistant` block), supporting:
  - provider selection (`assistant.provider`)
  - env-var key resolution
  - optional config-file key fallback
  - configurable `assistantSeedInstruction` for first-message session seeding
  - configurable `maxToolRounds` for assistant tool-loop ceiling (default `1000`)
- Tool settings should be present in config (`tools` block), supporting:
  - `tools.defaultTimeoutMs`
  - `tools.defaultMaxCallsPerRun`
  - optional `tools.defaultMaxStdoutBytes`
  - optional `tools.defaultMaxStderrBytes`
  - `tools.credentialSets` for named child-process env bundles
  - `tools.userSupplied[*]` with `name`, `description`, optional `tags`, `inputSchema`, and `runner`
  - user-supplied tool descriptions should include any fixed query surface the model must reference directly, such as a required temp view or table name
  - `tools.userSupplied[*].runner` supporting `type = exec`, fixed `command` argv, optional `cwd`, optional `credentialSet`, optional `env`, optional `timeoutMs`, optional `maxStdoutBytes`, optional `maxStderrBytes`, optional `maxCallsPerRun`
- Provider-specific settings should be present in config (`providers` block), including:
  - `providers.openai` (`model`, `baseURL`)
  - `providers.anthropic` (`model`, `baseURL`, `version`, `maxTokens`)
- Config file path should be passed via CLI when launching server.
- Server config should support startup retry tuning for containerized dependency readiness:
  - `server.startupRetryCount`
  - `server.startupRetryDelayMs`

## Documentation Requirements
- `README.md` and `AGENTS.md` must be kept up to date with the latest implementation changes.
- Any API, config, storage, or UI behavior change must update both files in the same change set.

## Logging Requirements
- Logs should be JSON and include timestamp, level, file, line, and descriptive messages.

## Routing Requirements
- Use a simple router with one handler per endpoint.
- Router should enforce authentication, RBAC, and ownership checks per endpoint.

## Utility Requirements
- Include a bash script using curl that exercises all endpoint functionality.

## UI Requirements
- Serve a minimal HTML frontend at root (`/`).
- Use Monaco editor for SQL input and provide SQL formatting.
- Include submit control and results display area.
- Include a collapsible left-side schema tree of Athena tables and fields/types.

## Current Implementation Snapshot
- Express-based HTTP server with one handler per endpoint.
- Enabled auth mode supports Google OIDC and local email/password authentication with MySQL-backed server-side sessions.
- Configurable auth bypass mode (`auth.mode = disabled`) for local/dev testing using a fixed configured dev user; blocked when `NODE_ENV=production`.
- MySQL-backed `users`, `user_identities`, `roles`, `user_roles`, and `user_sessions` tables, with `users.password_hash` storing salted scrypt password hashes or invalid sentinels for non-local accounts.
- MySQL-backed `queries` table for query metadata/state, selected Athena `database`, and nullable `created_by_user_id`.
- MySQL-backed `assistant_sessions` and `assistant_messages` tables for assistant conversation persistence.
- `assistant_sessions` stores the seeded query-context snapshot used to detect query drift and trigger automatic summarized rollover on the next assistant send.
- Athena integration using AWS SDK v3.
- Background poller updates state and downloads results on success.
- Per-query lock manager to avoid race conditions between poll/cancel/refresh.
- Results stored under configured `server.resultsDir` (default: `./results`) as `/<query-id>/result.json`, with query-scoped assistant tool folders under `/<query-id>/tools/`.
- JSON logger includes timestamp/level/file/line/message.
- Config loaded from `--config <path>`.
- Provider-agnostic built-in assistant tool schemas are defined under `src/assistant/tools.js`, merged with config-defined `tools.userSupplied`, and translated per provider.
- Assistant integration supports `openai` and `anthropic` providers via `/query/:id/assistant/*` endpoints with a shared tool-call execution loop.
- Assistant session seed instruction is configurable via `assistant.assistantSeedInstruction`.
- Assistant tool-loop ceiling is configurable via `assistant.maxToolRounds` (default `1000`), with cancellation expected via assistant cancel endpoint/UI when needed.
- Assistant tools include built-in `search_tools`, built-in `run_read_query` for bounded read sampling (parser-guarded SELECT-only execution, max 500 rows, max 5 calls per run, capped columns, audit logging), and config-defined child-process tools from `tools.userSupplied`.
- Config-defined assistant tools receive explicit env vars for `QUERY_DIR`, `RESULT_PATH`, `TOOL_WORKSPACE_DIR`, `TOOL_TMP_DIR`, and `TOOL_RUN_DIR`, plus configured credential/env values.
- Static frontend served from `/` with Monaco SQL editor, SQL format action, submit, polling, and results view.
- Frontend loads to a dedicated dark-mode login screen when `/auth/me` reports the user is unauthenticated, then shows the main app shell after successful sign-in.
- Login screen supports local email/password sign-in and conditionally shows Google sign-in when `auth.google.enabled` is true.
- Main app top bar shows current-user/role summary plus sign-out control; sign-in options are only shown on the dedicated login screen.
- Frontend query list supports a `Mine` / `All` scope toggle, where `Mine` requests `GET /query?userId=<current-user-id>` and `All` requests `GET /query`.
- Frontend keeps the selected query in the browser URL for shareable deep links and restores query selection from `?query=<query-id>` on load/back-forward navigation.
- Frontend can load an accessible deep-linked query outside the current query-list filter without injecting it into the saved-query sidebar.
- Frontend uses a refreshed glass-panel layout with responsive cards, higher-contrast controls, and persisted light/dark theme switching.
- General action buttons use a compact size, while sidebar collapse toggles remain larger.
- Frontend shell spans the full browser width with narrow outer gutters, and the SQL editor card is collapsible like the other major panels.
- Collapsed sidebars retain their full panel height and only compress horizontally.
- Frontend card headers render title and descriptive subtitle inline on one row when space allows, preserving the existing type contrast.
- Frontend card headers align title left and description right when space allows.
- Sidebar headers keep the collapse button aligned with the title row, while the description sits below and remains left-aligned.
- Monaco editor uses schema-aware autocomplete (keywords/tables/columns) and debounced backend validation markers.
- Frontend includes collapsible assistant panel (response display + prompt input) above query editor.
- Frontend assistant panel includes send/cancel controls, run status polling, elapsed run timer, and per-query conversation rendering from backend messages.
- Frontend assistant panel includes compact controls (`Compact`, `Compact + Summary`) and current-session token usage display.
- Frontend assistant panel label is provider-aware: `Buddy` for OpenAI and `Copain` for Anthropic (Claude).
- Frontend assistant panel renders assistant responses as sanitized Markdown (with plain-text fallback when Markdown libraries are unavailable).
- Frontend assistant panel shows optimistic user messages immediately on send and an animated typing indicator while assistant runs are active.
- Assistant response bubbles include a `Use` action that copies selected assistant output into the SQL editor.
- Frontend sign-out clears the app-owned browser local-storage keys and removes the selected-query URL param before reload.
- Frontend includes right-side query list populated from `/query`; selecting an item loads SQL and associated state/results.
- Right-side query list includes delete control for selected query and clears UI state after deletion.
- Results metadata panel includes `name` alongside Query ID/Status/timestamps.
- Results metadata cards render labels and values inline on one row when space allows.
- Results metadata values, including the editable `name` input, are right-aligned.
- Query `name` is editable in the metadata panel and is persisted on field blur via `PUT /query/:identifier`.
- Frontend includes left-side Athena schema tree loaded via `/database/:database/tables` and `/database/:database/:table/schema`.
- Frontend prefetches table schemas in the background after table list load.
- Frontend self-hosts Monaco from `/vendor/monaco`; auth/app bootstrap does not wait on Monaco, and editor actions remain disabled until Monaco loads successfully.
- Frontend includes selected-query cancel control wired to `POST /query/:id/cancel`.
- Results panel now separates query metadata fields from result payload rendering.
- Failed queries display Athena failure details (`StateChangeReason`) in the results panel and status messaging.
- If Athena response includes `columns`, rows are rendered using Tabulator with remote pagination; otherwise JSON is shown.
- Tabulator expands to fill the available results-pane width for narrower result sets while remaining horizontally scrollable for wider ones.
- Tabulator renders HTTP/HTTPS cell values as clickable links.
- If Tabulator is unavailable or fails to initialize, frontend falls back to a basic HTML table rendering.
- Tabular result rows support click-to-select highlighting in both Tabulator mode and basic HTML table fallback.
- Results panel includes full-results download controls with selectable format (`CSV`, `Excel`, `Parquet`) wired to `/query/:id/results/download`.
- `scripts/exercise.sh` validates base API behavior plus paginated results behavior, supports SQL overrides via env vars (`QUERY1_SQL`, `QUERY2_SQL`, `PAGINATION_SQL`), and accepts authenticated cookie input via `COOKIE_JAR` or `COOKIE_HEADER`.
- `scripts/exercise-assistant.sh` validates assistant send/status/messages/cancel/compact behavior (including usage reporting/reset), logs request/response pairs to a file (`LOG_FILE`), supports prompt/query overrides (`ASSISTANT_PROMPT`, `QUERY_SQL`; empty `QUERY_SQL` uses `SELECT 1` only for query creation), and accepts authenticated cookie input via `COOKIE_JAR` or `COOKIE_HEADER`.
- `scripts/admin.js` provides backend admin operations for listing users, creating local users, setting/resetting passwords, disabling local sign-in, listing queries, inspecting unowned queries, assigning query ownership, granting/removing roles by email, and enabling/disabling users, with text output by default and `--json` automation support.
- App construction is factored into `src/app.js` (`buildApp`) so endpoint tests can inject mocked services.
- Service orchestration is factored into `src/services/appServices.js` (`createServices`) so tests can reuse production service wiring.
- Endpoint tests are split by endpoint into separate files (`tests/query.create.test.js`, `tests/query.cancel.test.js`).
- Endpoint tests use Node's built-in test runner and validate `POST /query` and `POST /query/:id/cancel` with real `AthenaService` + `QueryStore` codepaths, mocking only AWS `client.send` and MySQL `pool.execute`.
- Shared test harness utilities live under `tests/helpers/serviceHarness.js`.
- `scripts/run-test-report.sh` writes timestamped test artifacts to `./results/test-runs/<timestamp>/` for iteration (`npm run test:post-query:report`, `npm run test:cancel-query:report`).
- Docker support includes a repo-root `Dockerfile`, `docker-compose.yml`, Docker-mounted config templates under `docker/config/`, MySQL bootstrap scripts under `docker/mysql/init/`, and backup/restore helpers (`scripts/docker-backup.sh`, `scripts/docker-restore.sh`).
- Docker Compose runs separate `athena-app` and `athena-mysql` services, persists MySQL data in the `athena_mysql_data` volume, mounts `./results` into the app container, and mounts host config from `./docker/config/config.json`.
- The Docker image includes the checked-in `tools/` subtree, a Python runtime, and AWS CLI so configured Python/S3 tools can execute inside the app container.
- Docker-oriented config uses `mysql.host = athena-mysql`, `mysql.port = 3306`, and `server.resultsDir = /data/results`.
- Server startup retries MySQL connection and schema initialization using `server.startupRetryCount` and `server.startupRetryDelayMs`, improving resilience while the MySQL container is still initializing.
