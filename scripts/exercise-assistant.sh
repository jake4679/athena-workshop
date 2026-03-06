#!/usr/bin/env bash
set -u -o pipefail

BASE_URL="${1:-http://localhost:3000}"
ASSISTANT_PROMPT="${ASSISTANT_PROMPT:-Give me a SQL query that gives me the current date time}"
QUERY_SQL="${QUERY_SQL:-}"
CREATE_QUERY_SQL="$QUERY_SQL"
if [[ -z "${CREATE_QUERY_SQL// }" ]]; then
  CREATE_QUERY_SQL="SELECT 1"
fi
LOG_FILE="${LOG_FILE:-./results/exercise-assistant-$(date +%Y%m%d-%H%M%S).log}"
FAILURES=0
LAST_BODY=""
LAST_STATUS=""

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $cmd"
    exit 2
  fi
}

request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local tmp
  local timestamp

  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp=$(mktemp)
  if [[ -n "$body" ]]; then
    LAST_STATUS=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$url" -H 'Content-Type: application/json' -d "$body")
  else
    LAST_STATUS=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$url")
  fi
  LAST_BODY=$(cat "$tmp")
  rm -f "$tmp"

  {
    echo "[$timestamp] REQUEST $method $url"
    if [[ -n "$body" ]]; then
      echo "[$timestamp] REQUEST_BODY:"
      echo "$body"
    fi
    echo "[$timestamp] RESPONSE_STATUS: $LAST_STATUS"
    echo "[$timestamp] RESPONSE_BODY:"
    echo "$LAST_BODY"
    echo "[$timestamp] ---"
  } >>"$LOG_FILE"
}

pass() {
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}

assert_status() {
  local expected="$1"
  local label="$2"
  if [[ "$LAST_STATUS" == "$expected" ]]; then
    pass "$label (HTTP $LAST_STATUS)"
  else
    fail "$label expected HTTP $expected got HTTP $LAST_STATUS"
    echo "$LAST_BODY" | jq . 2>/dev/null || echo "$LAST_BODY"
  fi
}

assert_jq_eq() {
  local expr="$1"
  local expected="$2"
  local label="$3"
  local actual
  actual=$(echo "$LAST_BODY" | jq -r "$expr" 2>/dev/null || echo "__JQ_ERROR__")
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label expected '$expected' got '$actual'"
    echo "$LAST_BODY" | jq . 2>/dev/null || echo "$LAST_BODY"
  fi
}

assert_jq_nonempty() {
  local expr="$1"
  local label="$2"
  local actual
  actual=$(echo "$LAST_BODY" | jq -r "$expr" 2>/dev/null || echo "__JQ_ERROR__")
  if [[ -n "$actual" && "$actual" != "null" && "$actual" != "__JQ_ERROR__" ]]; then
    pass "$label"
  else
    fail "$label expected non-empty value"
    echo "$LAST_BODY" | jq . 2>/dev/null || echo "$LAST_BODY"
  fi
}

wait_for_assistant_terminal() {
  local id="$1"
  local max_attempts="${2:-90}"
  local attempt=1
  local state=""

  while (( attempt <= max_attempts )); do
    request GET "$BASE_URL/query/$id/assistant/status"
    if [[ "$LAST_STATUS" != "200" ]]; then
      fail "assistant status polling for $id returned HTTP $LAST_STATUS"
      echo "$LAST_BODY" | jq . 2>/dev/null || echo "$LAST_BODY"
      echo ""
      return
    fi

    state=$(echo "$LAST_BODY" | jq -r '.runStatus')
    echo "Assistant polling query=$id attempt=$attempt runStatus=$state" >&2
    if [[ "$state" == "IDLE" || "$state" == "FAILED" ]]; then
      echo "$state"
      return
    fi

    attempt=$((attempt + 1))
    sleep 2
  done

  fail "timed out waiting for assistant run terminal state for query $id"
  echo "TIMEOUT"
}

require_cmd curl
require_cmd jq

mkdir -p "$(dirname "$LOG_FILE")"
echo "Assistant exercise log: $LOG_FILE"
{
  echo "=== assistant exercise run ==="
  echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "base_url=$BASE_URL"
  echo "assistant_prompt=$ASSISTANT_PROMPT"
  echo "query_sql=$QUERY_SQL"
  echo "create_query_sql=$CREATE_QUERY_SQL"
  echo
} >>"$LOG_FILE"

echo "Running assistant exercise against $BASE_URL"

request GET "$BASE_URL/health"
assert_status 200 "health endpoint"

request GET "$BASE_URL/database"
assert_status 200 "database list endpoint"
assert_jq_nonempty '.databases[0]' "database exists"
DB_NAME=$(echo "$LAST_BODY" | jq -r '.databases[0]')

QUERY_BODY=$(jq -nc --arg q "$CREATE_QUERY_SQL" --arg d "$DB_NAME" '{query: $q, database: $d}')
request POST "$BASE_URL/query" "$QUERY_BODY"
assert_status 202 "create query for assistant"
assert_jq_nonempty '.id' "query id present"
QUERY_ID=$(echo "$LAST_BODY" | jq -r '.id')

SEND_BODY=$(jq -nc --arg prompt "$ASSISTANT_PROMPT" '{prompt: $prompt}')
request POST "$BASE_URL/query/$QUERY_ID/assistant/send" "$SEND_BODY"
if [[ "$LAST_STATUS" == "503" ]]; then
  fail "assistant send failed: OpenAI not configured"
  echo "$LAST_BODY" | jq . 2>/dev/null || echo "$LAST_BODY"
  exit 1
fi
assert_status 202 "assistant send accepted"
assert_jq_eq '.runStatus' 'RUNNING' "assistant run started"
assert_jq_nonempty '.sessionId' "assistant session id returned"

request POST "$BASE_URL/query/$QUERY_ID/assistant/send" "$SEND_BODY"
assert_status 409 "assistant send rejected while run active"
assert_jq_eq '.error' 'ASSISTANT_RUN_ACTIVE' "assistant single-flight protection"

TERMINAL_STATE=$(wait_for_assistant_terminal "$QUERY_ID")
if [[ "$TERMINAL_STATE" == "IDLE" ]]; then
  pass "assistant run reached IDLE"
elif [[ "$TERMINAL_STATE" == "FAILED" ]]; then
  fail "assistant run reached FAILED"
else
  fail "assistant run unexpected terminal state: $TERMINAL_STATE"
fi

request GET "$BASE_URL/query/$QUERY_ID/assistant/messages"
assert_status 200 "assistant messages endpoint"
assert_jq_eq '(.messages | type)' 'array' "assistant messages payload type"
assert_jq_nonempty '.messages[] | select(.role=="assistant") | .id' "assistant response message exists"
ASSISTANT_SQL_TEXT=$(echo "$LAST_BODY" | jq -r '[.messages[] | select(.role=="assistant") | .content] | join("\n")')
if echo "$ASSISTANT_SQL_TEXT" | grep -Eqi '\bselect\b'; then
  pass "assistant response contains SQL-like SELECT"
else
  fail "assistant response missing SQL-like SELECT"
fi

request GET "$BASE_URL/query/$QUERY_ID/assistant/status"
assert_status 200 "assistant status after first run"
assert_jq_eq '(.usage.totalTokens | type)' 'number' "assistant usage total tokens present"

request POST "$BASE_URL/query/$QUERY_ID/assistant/compact" '{"mode":"summarize"}'
assert_status 200 "assistant compact summarize accepted"
assert_jq_eq '.mode' 'summarize' "assistant compact summarize mode echoed"
assert_jq_eq '.summaryIncluded' 'true' "assistant compact summarize included summary"

request POST "$BASE_URL/query/$QUERY_ID/assistant/compact" '{"mode":"empty"}'
assert_status 200 "assistant compact empty accepted"
assert_jq_eq '.mode' 'empty' "assistant compact empty mode echoed"
assert_jq_eq '.usage.totalTokens' '0' "assistant compact reset token usage"

SECOND_SEND=$(jq -nc --arg prompt "Give one shorter SQL alternative." '{prompt: $prompt}')
request POST "$BASE_URL/query/$QUERY_ID/assistant/send" "$SECOND_SEND"
assert_status 202 "assistant second run accepted"

request POST "$BASE_URL/query/$QUERY_ID/assistant/cancel" '{}'
assert_status 202 "assistant cancel accepted"
assert_jq_eq '.runStatus' 'CANCELLING' "assistant cancel moved run to cancelling"

TERMINAL_STATE_2=$(wait_for_assistant_terminal "$QUERY_ID")
if [[ "$TERMINAL_STATE_2" == "IDLE" || "$TERMINAL_STATE_2" == "FAILED" ]]; then
  pass "assistant cancelled run reached terminal state"
else
  fail "assistant cancelled run unexpected terminal state: $TERMINAL_STATE_2"
fi

request POST "$BASE_URL/query/$QUERY_ID/assistant/cancel" '{}'
assert_status 409 "assistant cancel rejected without active run"
assert_jq_eq '.error' 'ASSISTANT_RUN_NOT_ACTIVE' "assistant cancel inactive error"

if (( FAILURES == 0 )); then
  echo "ASSISTANT EXERCISE RESULT: SUCCESS"
  echo "completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) result=SUCCESS failures=$FAILURES" >>"$LOG_FILE"
  exit 0
fi

echo "ASSISTANT EXERCISE RESULT: FAILED ($FAILURES)"
echo "completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) result=FAILED failures=$FAILURES" >>"$LOG_FILE"
exit 1
