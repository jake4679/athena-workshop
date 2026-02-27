# Athena Workshop Agent Notes

## Project Goal
Build a minimal Node.js HTTP server to manage AWS Athena queries.

## API Requirements
- `POST /query`: submit query from JSON body (`query`), generate and return identifier.
- `GET /query/:identifier/status`: return query state and metadata.
- `GET /query/:identifier/results`: return results and timestamp when available.
- `POST /query/:identifier/refresh`: rerun existing query and clear prior results.
- `POST /query/:identifier/cancel`: cancel running Athena query when possible.

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
- Query result payloads may be large and should be stored in a project subfolder.

## Config Requirements
- Region/database/S3 output/bucket settings and server settings in JSON config file.
- Config file path should be passed via CLI when launching server.

## Logging Requirements
- Logs should be JSON and include timestamp, level, file, line, and descriptive messages.

## Routing Requirements
- Use a simple router with one handler per endpoint.
- Router should be authorization-capable (placeholder is acceptable now).

## Utility Requirements
- Include a bash script using curl that exercises all endpoint functionality.

## Current Implementation Snapshot
- Express-based HTTP server with one handler per endpoint.
- MySQL-backed `queries` table for query metadata/state.
- Athena integration using AWS SDK v3.
- Background poller updates state and downloads results on success.
- Per-query lock manager to avoid race conditions between poll/cancel/refresh.
- Results stored under `./results/<query-id>.json`.
- JSON logger includes timestamp/level/file/line/message.
- Config loaded from `--config <path>`.
