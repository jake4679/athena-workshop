const test = require('node:test');
const assert = require('node:assert/strict');
const { AssistantService } = require('../src/services/assistantService');

function createLoggerStub() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}

function createLockManagerStub() {
  return {
    async runWithLock(_key, fn) {
      return fn();
    }
  };
}

test('send rolls over to a new summarized session when stored query context has changed', async () => {
  const createdMessages = [];
  const service = new AssistantService({
    assistantStore: {
      async getActiveSessionByQueryId(queryId) {
        assert.equal(queryId, 'q-1');
        return null;
      },
      async getSessionByQueryIdAndProvider(queryId, provider) {
        assert.equal(queryId, 'q-1');
        assert.equal(provider, 'openai');
        return {
          id: 's-old',
          provider: 'openai',
          runStatus: 'IDLE',
          seedQueryHash: 'stale-hash',
          seedDatabaseName: 'analytics'
        };
      },
      async markRunStarted(sessionId) {
        assert.equal(sessionId, 's-new');
        return true;
      },
      async createMessage(record) {
        createdMessages.push(record);
      },
      async getSessionById(sessionId) {
        assert.equal(sessionId, 's-new');
        return {
          id: 's-new',
          runStatus: 'RUNNING',
          runStartedAt: '2026-03-09T15:00:00.000Z'
        };
      }
    },
    queryStore: {
      async getById(id) {
        assert.equal(id, 'q-1');
        return {
          id: 'q-1',
          databaseName: 'analytics',
          queryText: 'SELECT * FROM orders'
        };
      }
    },
    athenaService: {},
    lockManager: createLockManagerStub(),
    config: {
      assistant: {
        provider: 'openai',
        apiKey: 'test-key'
      }
    },
    logger: createLoggerStub()
  });

  let rolloverCalled = false;
  service.rolloverSessionForQueryChange = async (query, previousSession) => {
    rolloverCalled = true;
    assert.equal(query.id, 'q-1');
    assert.equal(previousSession.id, 's-old');
    return {
      session: {
        id: 's-new',
        provider: 'openai',
        runStatus: 'IDLE'
      },
      created: true,
      rolledOver: true,
      summaryIncluded: true
    };
  };
  service.runAssistantLoop = async () => ({ cancelled: false });

  const result = await service.send('q-1', 'Explain this query');

  assert.equal(rolloverCalled, true);
  assert.equal(result.sessionId, 's-new');
  assert.equal(result.runStatus, 'RUNNING');
  assert.equal(createdMessages.length, 1);
  assert.equal(createdMessages[0].sessionId, 's-new');
  assert.equal(createdMessages[0].role, 'user');
  assert.equal(createdMessages[0].content, 'Explain this query');
});
