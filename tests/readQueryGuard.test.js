const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReadQuery, rewriteReadQueryWithHardLimit } = require('../src/assistant/readQueryGuard');

test('validateReadQuery allows SELECT', () => {
  const result = validateReadQuery('SELECT * FROM sample_table');
  assert.equal(result.valid, true);
  assert.equal(result.normalizedQuery, 'SELECT * FROM sample_table');
});

test('validateReadQuery allows WITH SELECT', () => {
  const result = validateReadQuery(
    `
      WITH top_rows AS (
        SELECT id FROM sample_table LIMIT 10
      )
      SELECT * FROM top_rows
    `
  );
  assert.equal(result.valid, true);
});

test('validateReadQuery blocks forbidden keywords', () => {
  const result = validateReadQuery('DELETE FROM sample_table WHERE id = 1');
  assert.equal(result.valid, false);
  assert.match(result.reason, /only SELECT-style read queries are allowed|disallowed SQL keyword/i);
});

test('validateReadQuery blocks multiple statements', () => {
  const result = validateReadQuery('SELECT 1; DROP TABLE users');
  assert.equal(result.valid, false);
  assert.match(result.reason, /multiple SQL statements/i);
});

test('validateReadQuery allows TRUNCATE function usage in SELECT', () => {
  const result = validateReadQuery('SELECT TRUNCATE(price, 2) AS rounded_price FROM sample_table');
  assert.equal(result.valid, true);
});

test('validateReadQuery blocks destructive TRUNCATE usage in SELECT-style context', () => {
  const result = validateReadQuery('EXPLAIN TRUNCATE TABLE sample_table');
  assert.equal(result.valid, false);
  assert.match(result.reason, /TRUNCATE/i);
});

test('rewriteReadQueryWithHardLimit wraps query and enforces max row limit', () => {
  const result = rewriteReadQueryWithHardLimit('SELECT id FROM sample_table', 500);
  assert.equal(result.valid, true);
  assert.equal(result.enforcedRowLimit, 500);
  assert.match(result.rewrittenQuery, /FROM \(\nSELECT id FROM sample_table\n\) AS assistant_read_query\nLIMIT 500/);
});
