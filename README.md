# Athena Query Manager

Minimal Node.js HTTP service for submitting and managing AWS Athena queries.

## Setup
1. Copy `config.example.json` to `config.json` and set real values.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start server with config path:
   ```bash
   node src/server.js --config ./config.json
   ```

Optional port override:
```bash
node src/server.js --config ./config.json --port 4000
```

## Endpoints
- `GET /schema` (Athena database tables and columns/types)
- `POST /query/validate` body: `{ "query": "SELECT ..." }` (Athena-backed syntax validation)
- `POST /query` body: `{ "query": "SELECT ..." }`
- `GET /query`
- `PUT /query/:id` body: `{ "name": "Friendly name", "query": "SELECT ..." }` (either field may be provided)
- `DELETE /query/:id` (removes query metadata and any local stored results)
- `GET /query/:id/status`
- `GET /query/:id/results`
- Pagination on results: `GET /query/:id/results?limit=25&offset=0` or `GET /query/:id/results?page=1&size=25`
- `POST /query/:id/refresh`
- `POST /query/:id/cancel`
- `GET /health`

## Frontend
- `GET /` serves a minimal HTML page with:
- Monaco SQL editor
- Monaco autocomplete for SQL keywords, table names, and columns
- Debounced backend syntax validation with inline Monaco error markers
- SQL formatting button
- Query submit action
- Live status polling
- Query metadata panel
- Tabulator table for tabular results with remote pagination
- Right-side query list (`/query`) with click-to-load query text and available results
- Right-side query list includes delete action for selected query
- Query metadata includes editable `name` value from backend (defaulted to query ID on create)
- Left-side collapsible Athena schema tree (tables -> columns with data types)

## Exercise Script
```bash
./scripts/exercise.sh http://localhost:3000
```

`jq` is used by the script for assertions and JSON handling.
You can override queries for testing large result sets:

```bash
PAGINATION_SQL='SELECT * FROM your_large_table' ./scripts/exercise.sh http://localhost:3000
```
