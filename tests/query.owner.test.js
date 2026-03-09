const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueryHandler, getQueryListHandler } = require('../src/routes/queryHandlers');
const {
  createLoggerStub,
  createResponseStub,
  createServicesWithRealStack
} = require('./helpers/serviceHarness');

test('POST /query stores the authenticated user as query owner', async () => {
  const { services } = createServicesWithRealStack({
    athenaSendImpl: async () => ({ QueryExecutionId: 'athena-qe-owner' }),
    resultsDir: './results/test-query-owner'
  });
  const handler = createQueryHandler({ services, logger: createLoggerStub() });
  const req = {
    auth: {
      user: {
        id: 'user-123'
      }
    },
    body: {
      query: 'SELECT 1',
      database: 'analytics'
    }
  };
  const { res, output } = createResponseStub();

  await handler(req, res);

  assert.equal(output.statusCode, 202);
  const stored = await services.queryStore.getById(output.body.id);
  assert.equal(stored.createdByUserId, 'user-123');
});

test('GET /query supports filtering by userId', async () => {
  const services = {
    queryStore: {
      async listAll(options = {}) {
        return [
          {
            id: 'q1',
            name: 'q1',
            databaseName: 'analytics',
            status: 'RUNNING',
            queryText: 'SELECT 1',
            submittedAt: '2026-03-06T00:00:00.000Z',
            updatedAt: '2026-03-06T00:00:00.000Z',
            completedAt: null,
            cancelledAt: null,
            resultReceivedAt: null
          }
        ].filter(() => options.userId === 'user-123');
      }
    }
  };

  const handler = getQueryListHandler({ services });
  const { res, output } = createResponseStub();

  await handler({ query: { userId: 'user-123' } }, res);

  assert.equal(output.statusCode, 200);
  assert.equal(output.body.queries.length, 1);
});
