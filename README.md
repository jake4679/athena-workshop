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
   - Authentication settings are configured under `auth`.
   - `auth.mode` supports:
     - `oidc` for normal Google login
     - `disabled` for local/dev testing with a fixed configured user
   - `auth.baseURL` must match the browser-visible server origin used for Google callback handling.
   - `auth.sessionSecret` signs the session cookie.
   - `auth.google.clientId` and `auth.google.clientSecret` must match your Google OIDC application.
   - When `auth.mode = "disabled"`, the app auto-authenticates as `auth.devUser`; this mode is blocked when `NODE_ENV=production`.
   - If you use named AWS CLI profiles or IAM Identity Center (SSO), set `aws.profile` in config to force the Node process to use the same profile.
   - When `aws.profile` is set, server startup clears `AWS_ACCESS_KEY_ID`/`AWS_SESSION_TOKEN` env credentials so stale env tokens cannot override profile-based auth.
   - Assistant settings are configured under `assistant` with provider selection (`assistant.provider`) and generic key resolution (`assistant.apiKeyEnvVar` / `assistant.apiKey`).
   - Provider-specific options are configured under `providers.<provider>` (for example `providers.openai.model` or `providers.anthropic.model`).
   - `assistant.assistantSeedInstruction` controls the default instruction injected when a query's assistant session is first created.
   - `assistant.maxToolRounds` controls assistant tool-loop ceiling (default/recommended: `1000`; cancel via `/query/:id/assistant/cancel` or UI cancel).
   - Assistant tool runtime settings are configured under `tools`.
   - `tools.credentialSets` defines named environment-variable bundles for child-process tools (for example AWS credentials for an S3 log helper).
   - `tools.userSupplied` defines configured assistant tools with `name`, `description`, `tags`, `inputSchema`, and `runner`.
   - User-supplied tool descriptions should include any fixed query surface the model must reference directly, such as a required temp view or table name.
   - Configured tools run as child processes with JSON `stdin` / `stdout`, explicit env only, and query-scoped working directories under `server.resultsDir/<query-id>/`.
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

## Docker Compose
This repository now includes a full Docker Compose topology for the app and MySQL with persistent storage for:

- MySQL data
- local query results under `./results`
- mounted app config under `./docker/config/config.json`

Initial setup:
```bash
cp .env.example .env
cp docker/config/config.example.json docker/config/config.json
```

Then edit:

- `.env` for MySQL passwords and optional AWS mount overrides
- `docker/config/config.json` for AWS region/profile/output location, assistant settings, and any app tuning

Important Docker config values:

- `server.resultsDir` should remain `/data/results`
- `mysql.host` should remain `athena-mysql`
- `mysql.port` should remain `3306`

Build images:
```bash
docker compose build
```

Start the stack:
```bash
docker compose up --build -d
```

Stop running containers without removing them:
```bash
docker compose stop
```

Stop the stack without deleting persistent data:
```bash
docker compose down
```

Reset containers while preserving data:
```bash
docker compose up --build -d
```

Destroy containers and the MySQL volume:
```bash
docker compose down -v
```

View logs:
```bash
docker compose logs
```

Follow live logs for the app:
```bash
docker compose logs -f athena-app
```

Follow live logs for MySQL:
```bash
docker compose logs -f athena-mysql
```

Notes:

- The app container expects config at `CONFIG_PATH=/app/config.json`.
- The app mounts `./results` to `/data/results`, so cached/downloaded query results and query-scoped tool workspaces survive container replacement.
- The app image includes the checked-in `tools/` subtree, a Python runtime, and AWS CLI so configured Python/S3 tools can run inside Docker.
- MySQL stores data in the named volume `athena_mysql_data`, so database contents survive container replacement.
- MySQL bootstrap scripts under `./docker/mysql/init/` run only when the MySQL data volume is initialized for the first time.
- The app now retries MySQL initialization on startup using `server.startupRetryCount` and `server.startupRetryDelayMs`.

### AWS Credentials In Docker
By default the app container mounts your local AWS directory:

- host: `${HOME}/.aws`
- container: `/root/.aws`

This supports shared credentials, config files, and profile-based auth. If you need a different source path, set `AWS_DIR` in `.env`.

If you use `aws.profile` in config, the server sets `AWS_PROFILE` inside the container and clears conflicting static credential env vars before SDK initialization.

### Backups And Restore
Create a MySQL dump plus a tarball of the local `results/` directory:

```bash
./scripts/docker-backup.sh
```

Restore from a SQL dump and optionally a results tarball:

```bash
./scripts/docker-restore.sh ./docker/mysql/backups/mysql-YYYYMMDD-HHMMSS.sql ./docker/mysql/backups/results-YYYYMMDD-HHMMSS.tgz
```

The backup artifacts are written under `./docker/mysql/backups/`.

### Inspect MySQL
Connect to the app database as the application user:

```bash
docker compose exec athena-mysql mysql -uathena -p athena_manager
```

Connect as MySQL root:

```bash
docker compose exec athena-mysql mysql -uroot -p
```

Common inspection commands:

```sql
SHOW DATABASES;
USE athena_manager;
SHOW TABLES;
DESCRIBE queries;
DESCRIBE users;
DESCRIBE user_identities;
DESCRIBE user_roles;
DESCRIBE assistant_sessions;
DESCRIBE assistant_messages;
SELECT * FROM queries LIMIT 10;
```

## Endpoints
- `GET /auth/me` (returns current user profile + roles or unauthenticated state)
- `GET /auth/login/google` (starts Google OIDC login)
- `GET /auth/google/callback` (Google OIDC callback)
- `POST /auth/logout` (destroys current session)
- `GET /database` (list available Athena databases)
- `GET /database/:database/tables` (list tables for a database)
- `GET /database/:database/:table/schema` (columns/types for a table)
- `POST /query/validate` body: `{ "query": "SELECT ...", "database": "my_db" }` (database optional; Athena-backed syntax validation)
- `POST /query` body: `{ "query": "SELECT ...", "database": "my_db" }` (database optional)
- `GET /query` and `GET /query?userId=<user-id>`
- Query deep link: `/?query=<query-id>` loads that query into the UI for an authenticated user with access
- `PUT /query/:id` body: `{ "name": "Friendly name", "query": "SELECT ...", "database": "my_db" }` (any provided field is updated)
- `DELETE /query/:id` (removes query metadata and the local query result/tool-artifact directory tree)
- `GET /query/:id/status`
- `GET /query/:id/results`
- Pagination on results: `GET /query/:id/results?limit=25&offset=0` or `GET /query/:id/results?page=1&size=25`
- Full results download: `GET /query/:id/results/download?format=csv|excel|xlsx|parquet`
- `POST /query/:id/refresh`
- `POST /query/:id/cancel`
- `POST /query/:id/assistant/send` body: `{ "prompt": "..." }` (starts assistant run; lazy-creates session on first send)
- `GET /query/:id/assistant/status` (returns assistant run state for the query)
- `POST /query/:id/assistant/cancel` (requests cancellation of active assistant run)
- `POST /query/:id/assistant/compact` body: `{ "mode": "empty" | "summarize" }` (resets to a new assistant session; summarize mode carries forward a summary into the new session)
- `GET /query/:id/assistant/messages` (returns persisted assistant conversation messages for the query across the query's assistant sessions; compact summaries remain visible as assistant messages)
- When a query's stored SQL text or selected database changes, the next `POST /query/:id/assistant/send` automatically rolls over to a new assistant session seeded with the updated query context and a carry-forward summary of prior guidance.
- `GET /users` (admin only)
- `GET /users/:id` (self or admin)
- `PUT /users/:id` body: `{ "email": "new@example.com", "firstName": "Ada", "lastName": "Lovelace" }` for self updates; admins may also send `{ "status": "ACTIVE" | "DISABLED" }`
- `DELETE /users/:id` (admin only; disables the user)
- Assistant status payload includes cumulative token usage for the current provider session (`usage.promptTokens`, `usage.completionTokens`, `usage.totalTokens`).
- Assistant provider requests (OpenAI/Anthropic) do not use a local backend timeout; runs complete when model response returns or when cancelled/failed.
- Assistant includes `run_read_query` tool for self-serve sampling with backend safeguards:
  - parser/tokenizer guard allows only SELECT-style read queries
  - read guard allows `TRUNCATE(...)` numeric function usage, while blocking destructive `TRUNCATE TABLE`/statement usage
  - hard enforced outer `LIMIT 500`
  - max 5 `run_read_query` calls per assistant run
  - optional `maxColumns` (1-50) limits returned columns in tool output
  - backend audit logs capture original SQL, rewritten SQL, limits, and execution stats
- Assistant includes built-in `search_tools` for discovery of built-in and configured tools.
- Configured assistant tools from `tools.userSupplied` run sequentially within one assistant run and receive these working-directory env vars:
  - `QUERY_DIR`
  - `RESULT_PATH`
  - `TOOL_WORKSPACE_DIR`
  - `TOOL_TMP_DIR`
  - `TOOL_RUN_DIR`
- `GET /health`

## Local Storage
Cached query results and tool artifacts live under the configured `server.resultsDir` in this layout:

```text
results/
  <query-id>/
    result.json
    tools/
      workspace/
      tmp/
      runs/
        <assistant-session-id>/
          <tool-call-id>/
```

Behavior:

- Query refresh replaces `result.json` and keeps `tools/workspace/`.
- Query delete removes the entire `results/<query-id>/` tree.
- Assistant compact/session rollover keeps the same query-scoped tool workspace.
- Existing pre-migration flat result caches are not moved into the new per-query directory layout.

## Frontend
- `GET /` serves a minimal HTML page with:
- A dedicated dark-mode login screen when `/auth/me` reports the user is unauthenticated
- The login screen includes placeholder username/password inputs plus a `Log In With Google` social-login action for actual authentication
- The main app shell after successful sign-in, with current-user/role summary and sign-out control sourced from `/auth/me`
- When `auth.mode = "disabled"`, the frontend bypasses the login screen and loads directly into the configured dev user session
- Refreshed glass-panel UI with responsive card layout and higher-contrast controls
- General action buttons use a compact size, while sidebar collapse toggles remain larger
- Main shell stretches to the full browser width with narrow outer gutters
- Light/dark theme toggle persisted in browser local storage and applied to Monaco when available
- Section card headers render title and descriptive subtitle inline on one row when space allows
- Section card headers align title left and description right on the same row when space allows
- Sidebar headers keep the collapse button aligned with the title row, with the description shown below and left-aligned
- Collapsible SQL editor card in addition to schema, assistant, and query list panels
- Collapsed sidebars retain their full panel height and only compress horizontally
- Collapsible assistant panel with response area, prompt input, run status, and elapsed timer
- Assistant panel label is provider-aware: `Buddy` for OpenAI and `Copain` for Anthropic (Claude)
- Assistant prompt send/cancel controls backed by `/query/:id/assistant/*` APIs
- Assistant compact controls for session reset (`Compact`) and summarize-then-reset (`Compact + Summary`)
- Assistant prompt submit via `Cmd+Enter` / `Ctrl+Enter` when prompt textarea is focused
- Assistant run polling (`/assistant/status`) and conversation rendering (`/assistant/messages`) preserve visible history across compacted assistant sessions for the same query
- Assistant automatically re-grounds on the latest stored SQL/database after query edits by rolling over to a new summarized session while keeping the visible thread history across sessions
- Assistant metadata line includes run status, elapsed timer, and current-session token usage
- Assistant responses are rendered as sanitized Markdown (with plain-text fallback if Markdown libraries fail to load)
- Assistant panel shows optimistic user messages immediately on send and a live animated typing indicator while assistant run is active
- Assistant response bubbles include a `Use` action to copy that response into the SQL editor
- Monaco SQL editor
- Athena database selector persisted in browser local storage
- Monaco autocomplete for SQL keywords, table names, and columns
- Debounced backend syntax validation with inline Monaco error markers
- SQL formatting button
- Query submit action
- Query cancel action for the selected query
- Live status polling
- Query metadata panel
- Results metadata cards render labels and values inline on one row when space allows
- Results metadata values, including the editable `Name` input, are right-aligned
- Failed queries surface Athena `StateChangeReason` details in the results pane and status messaging
- Tabulator table for tabular results with remote pagination
- Tabulator fills the available results-pane width for narrower result sets while remaining horizontally scrollable for wider ones
- HTTP/HTTPS values in Tabulator cells render as clickable links
- Tabular result rows support click-to-select highlighting (Tabulator and fallback HTML table)
- Results panel includes full-results download controls with format selection (CSV, Excel, Parquet)
- Right-side query list (`/query`) with click-to-load query text and available results
- Right-side query list includes a `Mine` / `All` scope filter; `Mine` uses `GET /query?userId=<current-user-id>` and `All` uses `GET /query`
- Selected query is mirrored into the browser URL as `?query=<query-id>` for shareable deep links
- Deep-linked accessible queries load into the UI even if they are outside the current query-list filter, but they are not injected into the saved-query list
- Right-side query list includes delete action for selected query
- Query metadata includes editable `name` value from backend (defaulted to query ID on create)
- Left-side collapsible Athena schema tree (tables -> columns with data types)
- Table schemas are prefetched in the background after table list load

## Exercise Script
```bash
./scripts/exercise.sh http://localhost:3000
```

`jq` is used by the script for assertions and JSON handling.
Authenticated API exercise now requires either:

- `COOKIE_JAR=/path/to/cookies.txt`
- `COOKIE_HEADER='athena.sid=...'`

If neither is provided, the script warns that authenticated endpoints will return `401`.

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
- `COOKIE_JAR` or `COOKIE_HEADER` for authenticated assistant API access
- Script validates send/status/messages/cancel plus compact (`summarize` and `empty`) behavior and usage reset on empty compact.

## Authorization Model
- `viewer`: can read all queries, download results, and read assistant conversations
- `querier`: can do everything `viewer` can do, plus create/update/refresh/cancel owned queries and send/cancel/compact owned assistant runs
- `admin`: can read all queries/results/assistant messages, manage users, and delete any query, including legacy unowned queries

`admin` is not an implicit `querier`. If someone should administer and run queries, assign both roles.

## Auth Bypass Mode
For local testing without Google login, set:

```json
{
  "auth": {
    "mode": "disabled",
    "devUser": {
      "id": "dev-user-local",
      "email": "dev@example.com",
      "firstName": "Dev",
      "lastName": "User",
      "roles": ["admin", "querier", "viewer"]
    }
  }
}
```

Behavior:
- `/auth/me` returns the configured dev user
- authenticated API requests succeed without Google login
- Google login is disabled
- this mode is rejected when `NODE_ENV=production`

## Admin CLI
Use the backend admin helper with the same config file you use for the server:

```bash
npm run admin -- list-users
npm run admin -- grant-role --email user@example.com --role admin
npm run admin -- disable-user --email user@example.com
npm run admin -- list-queries --userId <user-id>
npm run admin -- list-unowned-queries
npm run admin -- assign-query --queryId <query-id> --userId <user-id>
```

JSON output for automation:

```bash
npm run admin -- list-users --json
```

Without `npm`:

```bash
node ./scripts/admin.js --config ./config.json list-users
```

With Docker:

```bash
docker compose exec athena-app node ./scripts/admin.js --config /app/config.json list-users
docker compose exec athena-app node ./scripts/admin.js --config /app/config.json grant-role --email user@example.com --role admin
```

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
