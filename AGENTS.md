# Athena Workshop Agent Notes

## Project Goal
Build a minimal Node.js HTTP server to manage AWS Athena queries.

## API Requirements
- `GET /database`: list Athena databases.
- `GET /database/:database/tables`: list tables for a selected Athena database.
- `GET /database/:database/:table/schema`: return schema (columns/types) for a selected table.
- `POST /query`: submit query from JSON body (`query`), generate and return identifier.
- `POST /query/validate`: validate SQL syntax using Athena `EXPLAIN`; returns markers suitable for editor diagnostics.
- `GET /query`: list all queries and their metadata.
- `PUT /query/:identifier`: update query `name`, query body (`query`), and/or selected database (`database`).
- `DELETE /query/:identifier`: delete query metadata and any local downloaded results.
- `GET /query/:identifier/status`: return query state and metadata.
- `GET /query/:identifier/results`: return results and timestamp when available.
- `POST /query/:identifier/refresh`: rerun existing query and clear prior results.
- `POST /query/:identifier/cancel`: cancel running Athena query when possible.
- `GET /query/:identifier/results` also supports pagination query params: `limit`/`offset` and `page`/`size`.

## Behavior Requirements
- Unknown query id should return an appropriate response.
- Running query should return an appropriate response for results and refresh.
- Cancelled query should return an appropriate response for results.
- Completed query should not become cancelled.
- If query already cancelled/completed, cancel endpoint should return an appropriate response.
- Multiple queries must run in parallel.
- Backend should poll Athena for running query states.
- Concurrency protection required around query state updates.

## Storage Requirements
- Query metadata should be stored in a minimal DB (MySQL preferred).
- Each query has a `name` field; default name is the query identifier when created.
- Each query stores selected Athena `database`.
- Query result payloads may be large and should be stored in a project subfolder.
- Assistant conversation storage uses MySQL tables:
  - `assistant_sessions`
  - `assistant_messages`

## Config Requirements
- Region/profile/S3 output/bucket settings and server settings in JSON config file.
- OpenAI settings should be present in config (`openai` block), supporting:
  - env-var key resolution
  - optional config-file key fallback
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
- Results stored under `./results/<query-id>.json`.
- JSON logger includes timestamp/level/file/line/message.
- Config loaded from `--config <path>`.
- OpenAI tool schemas scaffolded under `src/openai` (`toolSchemas.js` / `index.js`) for future assistant integration.
- Static frontend served from `/` with Monaco SQL editor, SQL format action, submit, polling, and results view.
- Monaco editor uses schema-aware autocomplete (keywords/tables/columns) and debounced backend validation markers.
- Frontend includes collapsible assistant panel (response display + prompt input) above query editor.
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
- `scripts/exercise.sh` validates base API behavior plus paginated results behavior, and supports SQL overrides via env vars (`QUERY1_SQL`, `QUERY2_SQL`, `PAGINATION_SQL`).
