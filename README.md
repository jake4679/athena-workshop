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
   - Assistant settings are configured under `assistant` with provider selection (`assistant.provider`) and generic key resolution (`assistant.apiKeyEnvVar` / `assistant.apiKey`).
   - Provider-specific options are configured under `providers.<provider>` (for example `providers.openai.model` or `providers.anthropic.model`).
   - `assistant.assistantSeedInstruction` controls the default instruction injected when a query's assistant session is first created.
   - `assistant.maxToolRounds` controls assistant tool-loop ceiling (default/recommended: `1000`; cancel via `/query/:id/assistant/cancel` or UI cancel).
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

## Docker
Build image:
```bash
docker build -t athena-query-manager .
```

Run container (mount config + expose port):
```bash
docker run --rm \
  -p 3000:3000 \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  -e PORT=3000 \
  athena-query-manager
```

Notes:
- Container expects config at `CONFIG_PATH` (default `/app/config.json`).
- App still requires access to your MySQL instance and AWS credentials.

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
- `POST /query/:id/assistant/send` body: `{ "prompt": "..." }` (starts assistant run; lazy-creates session on first send)
- `GET /query/:id/assistant/status` (returns assistant run state for the query)
- `POST /query/:id/assistant/cancel` (requests cancellation of active assistant run)
- `GET /query/:id/assistant/messages` (returns persisted assistant conversation messages for the query)
- Assistant provider requests (OpenAI/Anthropic) do not use a local backend timeout; runs complete when model response returns or when cancelled/failed.
- Assistant includes `run_read_query` tool for self-serve sampling with backend safeguards:
  - parser/tokenizer guard allows only SELECT-style read queries
  - hard enforced outer `LIMIT 500`
  - max 5 `run_read_query` calls per assistant run
  - optional `maxColumns` (1-50) limits returned columns in tool output
  - backend audit logs capture original SQL, rewritten SQL, limits, and execution stats
- `GET /health`

## Frontend
- `GET /` serves a minimal HTML page with:
- Collapsible assistant panel with response area, prompt input, run status, and elapsed timer
- Assistant prompt send/cancel controls backed by `/query/:id/assistant/*` APIs
- Assistant prompt submit via `Cmd+Enter` / `Ctrl+Enter` when prompt textarea is focused
- Assistant run polling (`/assistant/status`) and conversation rendering (`/assistant/messages`)
- Assistant responses are rendered as sanitized Markdown (with plain-text fallback if Markdown libraries fail to load)
- Assistant response bubbles include a `Use` action to copy that response into the SQL editor
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

Assistant API exercise:
```bash
./scripts/exercise-assistant.sh http://localhost:3000
```

Environment overrides for assistant exercise:
- `ASSISTANT_PROMPT` (default: `Give me a SQL query that gives me the current date time`)
- `QUERY_SQL` (default: empty; script uses `SELECT 1` only for required query creation step)
- `LOG_FILE` (default: `./results/exercise-assistant-<timestamp>.log`; includes request/response pairs)

## Automated Tests
- Run all tests:
  ```bash
  npm test
  ```
- Run the mocked `POST /query` endpoint pilot test:
  ```bash
  npm run test:post-query
  ```
- The pilot test exercises real `AthenaService` and `QueryStore` codepaths while mocking only the AWS client `send` call and MySQL `pool.execute` interface.
- Run the mocked `POST /query/:id/cancel` endpoint test:
  ```bash
  npm run test:cancel-query
  ```
- Run the same test with artifact logging for iteration:
  ```bash
  npm run test:post-query:report
  ```
  This writes timestamped outputs under `./results/test-runs/<timestamp>/` including console output and run metadata.
  A cancel-endpoint report variant is also available:
  ```bash
  npm run test:cancel-query:report
  ```

## TODO
- Remove legacy `assistant_sessions.openai_conversation_id` and `assistant_messages.openai_response_id` columns after all known database instances have been migrated and verified to use `provider_conversation_id` / `provider_response_id` only.
