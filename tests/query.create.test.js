const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueryHandler } = require('../src/routes/queryHandlers');
const { AthenaService } = require('../src/services/athenaService');
const { QueryStore } = require('../src/services/queryStore');
const { LockManager } = require('../src/services/lockManager');
const { createServices } = require('../src/services/appServices');

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

function createInMemoryPool() {
  const rowsById = new Map();

  return {
    async execute(sql, params = []) {
      const normalizedSql = String(sql).replace(/\s+/g, ' ').trim().toUpperCase();

      if (normalizedSql.startsWith('INSERT INTO QUERIES')) {
        const [id, name, databaseName, queryText, athenaQueryExecutionId, status, submittedAt, updatedAt] = params;
        rowsById.set(id, {
          id,
          name,
          database_name: databaseName,
          query_text: queryText,
          athena_query_execution_id: athenaQueryExecutionId,
          status,
          submitted_at: submittedAt,
          updated_at: updatedAt,
          completed_at: null,
          cancelled_at: null,
          result_path: null,
          result_received_at: null,
          error_message: null
        });
        return [{ affectedRows: 1 }];
      }

      if (normalizedSql.startsWith('SELECT * FROM QUERIES WHERE ID = ?')) {
        const id = params[0];
        const row = rowsById.get(id);
        return [row ? [row] : []];
      }

      throw new Error(`Unsupported SQL in test pool: ${sql}`);
    }
  };
}

function createServicesWithRealStack({ athenaSendImpl }) {
  const pool = createInMemoryPool();
  const queryStore = new QueryStore(pool);
  const athenaService = new AthenaService({
    aws: {
      region: 'us-east-1',
      outputLocation: 's3://unit-test-results/prefix/',
      workGroup: 'primary'
    },
    server: {
      resultsDir: './results/test-query-create'
    }
  });
  athenaService.client.send = athenaSendImpl;

  const assistantService = {
    send: async () => ({ error: 'NOT_USED' }),
    getStatus: async () => ({ error: 'NOT_USED' }),
    cancel: async () => ({ error: 'NOT_USED' }),
    listMessages: async () => ({ error: 'NOT_USED' })
  };

  return createServices({
    queryStore,
    assistantService,
    athenaService,
    lockManager: new LockManager(),
    logger: createLoggerStub()
  });
}

test('POST /query returns 202 and query metadata when submission succeeds', async () => {
  const sentCommands = [];
  const services = createServicesWithRealStack({
    athenaSendImpl: async (command) => {
      sentCommands.push(command);
      return { QueryExecutionId: 'athena-qe-1' };
    }
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
  const services = createServicesWithRealStack({
    athenaSendImpl: async () => {
      throw new Error('athena unavailable');
    }
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
