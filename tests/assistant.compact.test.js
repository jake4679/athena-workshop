const test = require('node:test');
const assert = require('node:assert/strict');
const { compactAssistantSessionHandler } = require('../src/routes/queryHandlers');
const { createResponseStub } = require('./helpers/serviceHarness');

test('POST /query/:id/assistant/compact returns 200 for empty compact', async () => {
  const handler = compactAssistantSessionHandler({
    services: {
      compactAssistantSession: async () => ({
        queryId: 'q-1',
        provider: 'openai',
        mode: 'empty',
        previousSessionId: 's-1',
        sessionId: 's-2',
        runStatus: 'IDLE',
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        },
        summaryIncluded: false
      })
    }
  });
  const { res, output } = createResponseStub();

  await handler({ params: { id: 'q-1' }, body: { mode: 'empty' } }, res);

  assert.equal(output.statusCode, 200);
  assert.equal(output.body.mode, 'empty');
  assert.equal(output.body.sessionId, 's-2');
  assert.deepEqual(output.body.usage, {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  });
});

test('POST /query/:id/assistant/compact returns 409 when run is active', async () => {
  const handler = compactAssistantSessionHandler({
    services: {
      compactAssistantSession: async () => ({
        error: 'RUN_ACTIVE',
        session: {
          id: 's-active',
          runStatus: 'RUNNING'
        }
      })
    }
  });
  const { res, output } = createResponseStub();

  await handler({ params: { id: 'q-1' }, body: { mode: 'summarize' } }, res);

  assert.equal(output.statusCode, 409);
  assert.equal(output.body.error, 'ASSISTANT_RUN_ACTIVE');
});

test('POST /query/:id/assistant/compact returns 400 for invalid mode', async () => {
  const handler = compactAssistantSessionHandler({
    services: {
      compactAssistantSession: async () => ({ error: 'INVALID_MODE' })
    }
  });
  const { res, output } = createResponseStub();

  await handler({ params: { id: 'q-1' }, body: { mode: 'bad-mode' } }, res);

  assert.equal(output.statusCode, 400);
  assert.equal(output.body.error, 'ASSISTANT_COMPACT_INVALID_MODE');
});
