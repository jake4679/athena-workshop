const test = require('node:test');
const assert = require('node:assert/strict');
const { getAssistantStatusHandler } = require('../src/routes/queryHandlers');
const { createResponseStub } = require('./helpers/serviceHarness');

test('GET /query/:id/assistant/status returns usage fields', async () => {
  const handler = getAssistantStatusHandler({
    services: {
      getAssistantStatus: async () => ({
        queryId: 'q-1',
        provider: 'openai',
        sessionExists: true,
        sessionId: 's-1',
        model: 'gpt-5',
        runStatus: 'IDLE',
        runStartedAt: null,
        runFinishedAt: null,
        cancelRequestedAt: null,
        lastErrorMessage: null,
        usage: {
          promptTokens: 123,
          completionTokens: 45,
          totalTokens: 168
        }
      })
    }
  });
  const { res, output } = createResponseStub();

  await handler({ params: { id: 'q-1' } }, res);

  assert.equal(output.statusCode, 200);
  assert.deepEqual(output.body.usage, {
    promptTokens: 123,
    completionTokens: 45,
    totalTokens: 168
  });
});
