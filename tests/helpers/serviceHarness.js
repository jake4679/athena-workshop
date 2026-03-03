const { AthenaService } = require('../../src/services/athenaService');
const { QueryStore } = require('../../src/services/queryStore');
const { LockManager } = require('../../src/services/lockManager');
const { createServices } = require('../../src/services/appServices');

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

      if (normalizedSql.startsWith('UPDATE QUERIES SET STATUS = ?')) {
        const [status, updatedAt, completedAt, cancelledAt, resultPath, resultReceivedAt, errorMessage, id] = params;
        const row = rowsById.get(id);
        if (!row) {
          return [{ affectedRows: 0 }];
        }

        row.status = status;
        row.updated_at = updatedAt;
        row.completed_at = completedAt ?? row.completed_at;
        row.cancelled_at = cancelledAt ?? row.cancelled_at;
        row.result_path = resultPath ?? row.result_path;
        row.result_received_at = resultReceivedAt ?? row.result_received_at;
        row.error_message = errorMessage ?? row.error_message;
        rowsById.set(id, row);
        return [{ affectedRows: 1 }];
      }

      throw new Error(`Unsupported SQL in test pool: ${sql}`);
    }
  };
}

function createServicesWithRealStack({ athenaSendImpl, resultsDir = './results/test-services' } = {}) {
  const pool = createInMemoryPool();
  const queryStore = new QueryStore(pool);
  const athenaService = new AthenaService({
    aws: {
      region: 'us-east-1',
      outputLocation: 's3://unit-test-results/prefix/',
      workGroup: 'primary'
    },
    server: {
      resultsDir
    }
  });

  const sentCommands = [];
  athenaService.client.send = async (command) => {
    sentCommands.push(command);
    if (typeof athenaSendImpl === 'function') {
      return athenaSendImpl(command);
    }
    if (command && command.input && typeof command.input.QueryString === 'string') {
      return { QueryExecutionId: 'athena-qe-default' };
    }
    return {};
  };

  const assistantService = {
    send: async () => ({ error: 'NOT_USED' }),
    getStatus: async () => ({ error: 'NOT_USED' }),
    cancel: async () => ({ error: 'NOT_USED' }),
    listMessages: async () => ({ error: 'NOT_USED' }),
    compact: async () => ({ error: 'NOT_USED' })
  };

  const services = createServices({
    queryStore,
    assistantService,
    athenaService,
    lockManager: new LockManager(),
    logger: createLoggerStub()
  });

  return {
    services,
    queryStore,
    sentCommands
  };
}

module.exports = {
  createLoggerStub,
  createResponseStub,
  createServicesWithRealStack
};
