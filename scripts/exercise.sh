#!/usr/bin/env bash
set -u -o pipefail

BASE_URL="${1:-http://localhost:3000}"
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

  tmp=$(mktemp)
  if [[ -n "$body" ]]; then
    LAST_STATUS=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$url" -H 'Content-Type: application/json' -d "$body")
  else
    LAST_STATUS=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$url")
  fi

  LAST_BODY=$(cat "$tmp")
  rm -f "$tmp"
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

wait_for_terminal_state() {
  local id="$1"
  local max_attempts="${2:-90}"
  local attempt=1
  local state=""

  while (( attempt <= max_attempts )); do
    request GET "$BASE_URL/query/$id/status"
    if [[ "$LAST_STATUS" != "200" ]]; then
      fail "status polling for $id returned HTTP $LAST_STATUS"
      echo "$LAST_BODY" | jq . 2>/dev/null || echo "$LAST_BODY"
      echo ""
      return
    fi

    state=$(echo "$LAST_BODY" | jq -r '.status')
    echo "Polling $id attempt=$attempt state=$state" >&2

    if [[ "$state" == "SUCCEEDED" || "$state" == "FAILED" || "$state" == "CANCELLED" ]]; then
      echo "$state"
      return
    fi

    attempt=$((attempt + 1))
    sleep 2
  done

  fail "timed out waiting for terminal state for $id"
  echo "TIMEOUT"
}

require_cmd curl
require_cmd jq

echo "Running exercise against $BASE_URL"

request GET "$BASE_URL/health"
assert_status 200 "health endpoint"
assert_jq_eq '.status' 'ok' "health payload"

request POST "$BASE_URL/query" '{"query":"SELECT current_timestamp"}'
assert_status 202 "create query #1"
assert_jq_nonempty '.id' "create query #1 id present"
ID1=$(echo "$LAST_BODY" | jq -r '.id')
assert_jq_eq '.status' 'RUNNING' "create query #1 initial status"

request POST "$BASE_URL/query" '{"query":"SELECT * FROM information_schema.tables"}'
assert_status 202 "create query #2"
assert_jq_nonempty '.id' "create query #2 id present"
ID2=$(echo "$LAST_BODY" | jq -r '.id')

request POST "$BASE_URL/query/$ID2/cancel" '{}'
assert_status 202 "cancel query #2"
assert_jq_eq '.status' 'CANCELLED' "cancel query #2 status"

request GET "$BASE_URL/query/$ID2/status"
assert_status 200 "status query #2"
assert_jq_eq '.status' 'CANCELLED' "status query #2 payload"

request GET "$BASE_URL/query/$ID2/results"
assert_status 409 "results query #2 while cancelled"
assert_jq_eq '.error' 'QUERY_CANCELLED' "results query #2 error code"

STATE1=$(wait_for_terminal_state "$ID1")
if [[ "$STATE1" == "SUCCEEDED" ]]; then
  pass "query #1 reached SUCCEEDED"
else
  fail "query #1 expected SUCCEEDED for result retrieval flow, got '$STATE1'"
fi

request GET "$BASE_URL/query/$ID1/results"
if [[ "$STATE1" == "SUCCEEDED" ]]; then
  assert_status 200 "results query #1"
  assert_jq_nonempty '.resultReceivedAt' "results query #1 timestamp"
else
  assert_status 409 "results query #1 when not succeeded"
fi

request POST "$BASE_URL/query/$ID1/refresh" '{}'
assert_status 202 "refresh query #1"
assert_jq_eq '.status' 'RUNNING' "refresh query #1 status"

request POST "$BASE_URL/query/$ID1/refresh" '{}'
assert_status 409 "refresh query #1 while running"
assert_jq_eq '.error' 'QUERY_RUNNING' "refresh query #1 running error"

STATE1_REFRESH=$(wait_for_terminal_state "$ID1")
if [[ "$STATE1_REFRESH" == "SUCCEEDED" ]]; then
  pass "refreshed query #1 reached SUCCEEDED"
else
  fail "refreshed query #1 expected SUCCEEDED, got '$STATE1_REFRESH'"
fi

request GET "$BASE_URL/query/$ID1/results"
if [[ "$STATE1_REFRESH" == "SUCCEEDED" ]]; then
  assert_status 200 "results refreshed query #1"
  assert_jq_nonempty '.resultReceivedAt' "results refreshed query #1 timestamp"
else
  assert_status 409 "results refreshed query #1 when not succeeded"
fi

request GET "$BASE_URL/query/unknown-id/status"
assert_status 404 "unknown query status"
assert_jq_eq '.error' 'QUERY_NOT_FOUND' "unknown query status error"

if (( FAILURES == 0 )); then
  echo "EXERCISE RESULT: SUCCESS"
  exit 0
fi

echo "EXERCISE RESULT: FAILED ($FAILURES checks failed)"
exit 1
