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
- `POST /query` body: `{ "query": "SELECT ..." }`
- `GET /query/:id/status`
- `GET /query/:id/results`
- `POST /query/:id/refresh`
- `POST /query/:id/cancel`
- `GET /health`

## Exercise Script
```bash
./scripts/exercise.sh http://localhost:3000
```

`jq` is used by the script for pretty JSON output.
