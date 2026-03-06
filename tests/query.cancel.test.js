const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelQueryHandler } = require('../src/routes/queryHandlers');
const {
  createLoggerStub,
  createResponseStub,
  createServicesWithRealStack
} = require('./helpers/serviceHarness');

test('POST /query/:id/cancel returns 202 and cancelled status for running query', async () => {
  const { services, queryStore, sentCommands } = createServicesWithRealStack({
    resultsDir: './results/test-query-cancel'
  });

  const seeded = await queryStore.create({
    id: 'query-running-1',
    name: 'query-running-1',
    databaseName: 'analytics',
    queryText: 'SELECT 1',
    athenaQueryExecutionId: 'athena-qe-running-1',
    status: 'RUNNING'
  });

  const handler = cancelQueryHandler({ services, logger: createLoggerStub() });
  const { res, output } = createResponseStub();
  await handler({ params: { id: seeded.id } }, res);

  assert.equal(output.statusCode, 202);
  assert.equal(output.body.id, seeded.id);
  assert.equal(output.body.status, 'CANCELLED');
  assert.equal(typeof output.body.cancelledAt, 'string');

  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].input.QueryExecutionId, 'athena-qe-running-1');
});

test('POST /query/:id/cancel returns 404 for unknown query id', async () => {
  const { services } = createServicesWithRealStack({
    resultsDir: './results/test-query-cancel'
  });
  const handler = cancelQueryHandler({ services, logger: createLoggerStub() });
  const { res, output } = createResponseStub();

  await handler({ params: { id: 'missing-id' } }, res);

  assert.equal(output.statusCode, 404);
  assert.equal(output.body.error, 'QUERY_NOT_FOUND');
});

test('POST /query/:id/cancel returns 409 for already cancelled query', async () => {
  const { services, queryStore } = createServicesWithRealStack({
    resultsDir: './results/test-query-cancel'
  });

  const seeded = await queryStore.create({
    id: 'query-cancelled-1',
    name: 'query-cancelled-1',
    databaseName: 'analytics',
    queryText: 'SELECT 1',
    athenaQueryExecutionId: 'athena-qe-cancelled-1',
    status: 'CANCELLED'
  });

  const handler = cancelQueryHandler({ services, logger: createLoggerStub() });
  const { res, output } = createResponseStub();
  await handler({ params: { id: seeded.id } }, res);

  assert.equal(output.statusCode, 409);
  assert.equal(output.body.error, 'QUERY_ALREADY_CANCELLED');
});

test('POST /query/:id/cancel returns 409 for already completed query', async () => {
  const { services, queryStore } = createServicesWithRealStack({
    resultsDir: './results/test-query-cancel'
  });

  const seeded = await queryStore.create({
    id: 'query-succeeded-1',
    name: 'query-succeeded-1',
    databaseName: 'analytics',
    queryText: 'SELECT 1',
    athenaQueryExecutionId: 'athena-qe-succeeded-1',
    status: 'SUCCEEDED'
  });

  const handler = cancelQueryHandler({ services, logger: createLoggerStub() });
  const { res, output } = createResponseStub();
  await handler({ params: { id: seeded.id } }, res);

  assert.equal(output.statusCode, 409);
  assert.equal(output.body.error, 'QUERY_ALREADY_COMPLETED');
});
