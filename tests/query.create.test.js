const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueryHandler } = require('../src/routes/queryHandlers');
const {
  createLoggerStub,
  createResponseStub,
  createServicesWithRealStack
} = require('./helpers/serviceHarness');

test('POST /query returns 202 and query metadata when submission succeeds', async () => {
  const { services, sentCommands } = createServicesWithRealStack({
    athenaSendImpl: async (command) => {
      return { QueryExecutionId: 'athena-qe-1' };
    },
    resultsDir: './results/test-query-create'
  });
  const handler = createQueryHandler({ services, logger: createLoggerStub() });
  const req = {
    body: {
      query: 'SELECT 1',
      database: 'analytics'
    }
  };
  const { res, output } = createResponseStub();

  await handler(req, res);

  assert.equal(output.statusCode, 202);
  assert.equal(output.body.id.length, 36);
  assert.deepEqual(output.body, {
    id: output.body.id,
    name: output.body.id,
    database: 'analytics',
    status: 'RUNNING',
    submittedAt: output.body.submittedAt
  });
  assert.equal(typeof output.body.submittedAt, 'string');
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].input.QueryString, 'SELECT 1');
  assert.equal(sentCommands[0].input.QueryExecutionContext.Database, 'analytics');
});

test('POST /query returns 400 when query is missing', async () => {
  const handler = createQueryHandler({
    services: { createQuery: async () => {} },
    logger: createLoggerStub()
  });
  const { res, output } = createResponseStub();

  await handler({ body: {} }, res);

  assert.equal(output.statusCode, 400);
  assert.equal(output.body.error, 'INVALID_REQUEST');
});

test('POST /query returns 500 when service throws', async () => {
  const { services } = createServicesWithRealStack({
    athenaSendImpl: async () => {
      throw new Error('athena unavailable');
    },
    resultsDir: './results/test-query-create'
  });
  const handler = createQueryHandler({ services, logger: createLoggerStub() });
  const { res, output } = createResponseStub();

  await handler({ body: { query: 'SELECT 1' } }, res);

  assert.equal(output.statusCode, 500);
  assert.deepEqual(output.body, {
    error: 'CREATE_FAILED',
    message: 'Failed to submit query'
  });
});
