const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueryHandler } = require('../src/routes/queryHandlers');

function createLoggerStub() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}

function createResponseStub() {
  const output = {
    statusCode: null,
    body: null
  };
  const res = {
    status(code) {
      output.statusCode = code;
      return this;
    },
    json(body) {
      output.body = body;
      return this;
    }
  };
  return { res, output };
}

test('POST /query returns 202 and query metadata when submission succeeds', async () => {
  const calls = [];
  const services = {
    createQuery: async (query, database) => {
      calls.push({ query, database });
      return {
        id: 'query-1',
        name: 'query-1',
        databaseName: 'analytics',
        status: 'RUNNING',
        submittedAt: '2026-03-02T10:00:00.000Z'
      };
    }
  };
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
  assert.deepEqual(output.body, {
    id: 'query-1',
    name: 'query-1',
    database: 'analytics',
    status: 'RUNNING',
    submittedAt: '2026-03-02T10:00:00.000Z'
  });
  assert.deepEqual(calls, [{ query: 'SELECT 1', database: 'analytics' }]);
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
  const services = {
    createQuery: async () => {
      throw new Error('athena unavailable');
    }
  };
  const handler = createQueryHandler({ services, logger: createLoggerStub() });
  const { res, output } = createResponseStub();

  await handler({ body: { query: 'SELECT 1' } }, res);

  assert.equal(output.statusCode, 500);
  assert.deepEqual(output.body, {
    error: 'CREATE_FAILED',
    message: 'Failed to submit query'
  });
});
