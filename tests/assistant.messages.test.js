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

test('GET /query/:id/assistant/messages includes messages across compacted sessions for the query', async () => {
  const service = new AssistantService({
    assistantStore: {
      async getSessionByQueryIdAndProvider(queryId, provider) {
        assert.equal(queryId, 'q-1');
        assert.equal(provider, 'openai');
        return {
          id: 's-2',
          provider: 'openai'
        };
      },
      async listMessagesByQueryId(queryId) {
        assert.equal(queryId, 'q-1');
        return [
          {
            id: 'm-1',
            sessionId: 's-1',
            queryId: 'q-1',
            role: 'user',
            content: 'Original question',
            createdAt: '2026-03-09T10:00:00.000Z'
          },
          {
            id: 'm-2',
            sessionId: 's-2',
            queryId: 'q-1',
            role: 'assistant',
            content: 'Conversation compacted from prior session. Summary:\n\nSummary text',
            createdAt: '2026-03-09T10:05:00.000Z'
          }
        ];
      }
    },
    queryStore: {
      async getById(id) {
        assert.equal(id, 'q-1');
        return { id: 'q-1' };
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

  const result = await service.listMessages('q-1');

  assert.equal(result.queryId, 'q-1');
  assert.equal(result.provider, 'openai');
  assert.equal(result.sessionExists, true);
  assert.equal(result.sessionId, 's-2');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(
    result.messages.map((message) => ({
      id: message.id,
      sessionId: message.sessionId,
      queryId: message.queryId,
      role: message.role
    })),
    [
      { id: 'm-1', sessionId: 's-1', queryId: 'q-1', role: 'user' },
      { id: 'm-2', sessionId: 's-2', queryId: 'q-1', role: 'assistant' }
    ]
  );
});
