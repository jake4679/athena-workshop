const test = require('node:test');
const assert = require('node:assert/strict');
const { getQueryResultsHandler } = require('../src/routes/queryHandlers');
const {
  createLoggerStub,
  createResponseStub,
  createServicesWithRealStack
} = require('./helpers/serviceHarness');

test('GET /query/:id/results returns Athena error details for failed queries', async () => {
  const { services, queryStore } = createServicesWithRealStack({
    resultsDir: './results/test-query-results'
  });

  const seeded = await queryStore.create({
    id: 'query-failed-1',
    name: 'query-failed-1',
    databaseName: 'analytics',
    queryText: 'SELECT * FROM missing_table',
    athenaQueryExecutionId: 'athena-qe-failed-1',
    status: 'RUNNING'
  });

  await queryStore.updateStatus(seeded.id, 'FAILED', {
    completedAt: new Date('2026-03-06T12:00:00.000Z'),
    errorMessage: 'TABLE_NOT_FOUND: line 1:15: Table analytics.missing_table does not exist'
  });

  const handler = getQueryResultsHandler({ services, logger: createLoggerStub() });
  const { res, output } = createResponseStub();

  await handler({ params: { id: seeded.id }, query: {} }, res);

  assert.equal(output.statusCode, 409);
  assert.deepEqual(output.body, {
    error: 'QUERY_FAILED',
    message: 'TABLE_NOT_FOUND: line 1:15: Table analytics.missing_table does not exist',
    id: seeded.id,
    status: 'FAILED',
    errorMessage: 'TABLE_NOT_FOUND: line 1:15: Table analytics.missing_table does not exist'
  });
});
