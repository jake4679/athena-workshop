# Athena Query Manager

Minimal Node.js HTTP service for submitting and managing AWS Athena queries.

## Setup
1. Install MySQL locally (or ensure an accessible MySQL instance is available).
2. Start the MySQL service.
3. Create the application database:
   ```sql
   CREATE DATABASE athena_manager;
   ```
4. Copy `config.example.json` to `config.json` and set real values.
   - If you use named AWS CLI profiles or IAM Identity Center (SSO), set `aws.profile` in config to force the Node process to use the same profile.
   - When `aws.profile` is set, server startup clears `AWS_ACCESS_KEY_ID`/`AWS_SESSION_TOKEN` env credentials so stale env tokens cannot override profile-based auth.
   - OpenAI settings are configured under `openai` (supports env-var key and optional config-file key fallback).
5. Install dependencies:
   ```bash
   npm install
   ```
6. Start server with config path:
   ```bash
   node src/server.js --config ./config.json
   ```

Optional port override:
```bash
node src/server.js --config ./config.json --port 4000
```

## Endpoints
- `GET /database` (list available Athena databases)
- `GET /database/:database/tables` (list tables for a database)
- `GET /database/:database/:table/schema` (columns/types for a table)
- `POST /query/validate` body: `{ "query": "SELECT ...", "database": "my_db" }` (database optional; Athena-backed syntax validation)
- `POST /query` body: `{ "query": "SELECT ...", "database": "my_db" }` (database optional)
- `GET /query`
- `PUT /query/:id` body: `{ "name": "Friendly name", "query": "SELECT ...", "database": "my_db" }` (any provided field is updated)
- `DELETE /query/:id` (removes query metadata and any local stored results)
- `GET /query/:id/status`
- `GET /query/:id/results`
- Pagination on results: `GET /query/:id/results?limit=25&offset=0` or `GET /query/:id/results?page=1&size=25`
- `POST /query/:id/refresh`
- `POST /query/:id/cancel`
- `GET /health`

## Frontend
- `GET /` serves a minimal HTML page with:
- Collapsible assistant panel with response area and prompt input (frontend scaffold)
- Monaco SQL editor
- Athena database selector persisted in browser local storage
- Monaco autocomplete for SQL keywords, table names, and columns
- Debounced backend syntax validation with inline Monaco error markers
- SQL formatting button
- Query submit action
- Live status polling
- Query metadata panel
- Tabulator table for tabular results with remote pagination
- HTTP/HTTPS values in Tabulator cells render as clickable links
- Right-side query list (`/query`) with click-to-load query text and available results
- Right-side query list includes delete action for selected query
- Query metadata includes editable `name` value from backend (defaulted to query ID on create)
- Left-side collapsible Athena schema tree (tables -> columns with data types)
- Table schemas are prefetched in the background after table list load

## Exercise Script
```bash
./scripts/exercise.sh http://localhost:3000
```

`jq` is used by the script for assertions and JSON handling.
You can override queries for testing large result sets:

```bash
PAGINATION_SQL='SELECT * FROM your_large_table' ./scripts/exercise.sh http://localhost:3000
```
