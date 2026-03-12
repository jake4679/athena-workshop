const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AssistantService } = require('../src/services/assistantService');
const { AthenaService } = require('../src/services/athenaService');

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

function createAssistantService(resultsDir) {
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

  return new AssistantService({
    assistantStore: {},
    queryStore: {
      async getById(id) {
        return {
          id,
          name: id,
          databaseName: 'analytics',
          queryText: 'SELECT 1'
        };
      }
    },
    athenaService,
    lockManager: createLockManagerStub(),
    config: {
      assistant: {
        provider: 'openai',
        apiKey: 'test-key'
      },
      tools: {
        credentialSets: {
          logsS3: {
            AWS_REGION: 'us-east-1'
          }
        },
        userSupplied: [
          {
            name: 'fetch_logs',
            description: 'Download relevant logs from S3.',
            tags: ['logs', 's3'],
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string'
                }
              },
              required: ['message'],
              additionalProperties: false
            },
            runner: {
              type: 'exec',
              command: ['node', './tests/fixtures/assistant-user-tool.js'],
              credentialSet: 'logsS3',
              env: {
                LOG_BUCKET: 'app-logs'
              },
              timeoutMs: 5000
            }
          }
        ]
      }
    },
    logger: createLoggerStub()
  });
}

test('search_tools returns configured tools without exposing source metadata', async () => {
  const service = createAssistantService('./results/test-assistant-tools-search');

  const result = await service.executeTool('search_tools', {
    query: 'logs',
    includeSchema: true
  });

  assert.equal(result.totalTools >= 1, true);
  const tool = result.tools.find((entry) => entry.name === 'fetch_logs');
  assert.ok(tool);
  assert.equal(tool.description, 'Download relevant logs from S3.');
  assert.deepEqual(tool.tags, ['logs', 's3']);
  assert.deepEqual(tool.inputSchema.required, ['message']);
  assert.equal(Object.prototype.hasOwnProperty.call(tool, 'source'), false);
});

test('configured tool executes with query-scoped directories and explicit env only', async () => {
  const resultsDir = './results/test-assistant-tools-exec';
  const absoluteResultsDir = path.resolve(process.cwd(), resultsDir);
  fs.rmSync(absoluteResultsDir, { recursive: true, force: true });

  const service = createAssistantService(resultsDir);
  const usage = { readQueryCalls: 0, toolCallsByName: {} };

  const result = await service.executeTool(
    'fetch_logs',
    { message: 'hello from test' },
    {
      queryId: 'query-tools-1',
      sessionId: 'assistant-session-1',
      toolCallId: 'tool-call-1',
      usage
    }
  );

  const queryDir = path.join(absoluteResultsDir, 'query-tools-1');
  const runDir = path.join(queryDir, 'tools', 'runs', 'assistant-session-1', 'tool-call-1');

  assert.equal(result.ok, true);
  assert.equal(result.echoedArgs.message, 'hello from test');
  assert.equal(result.env.QUERY_DIR, queryDir);
  assert.equal(result.env.RESULT_PATH, path.join(queryDir, 'result.json'));
  assert.equal(result.env.TOOL_WORKSPACE_DIR, path.join(queryDir, 'tools', 'workspace'));
  assert.equal(result.env.TOOL_TMP_DIR, path.join(queryDir, 'tools', 'tmp'));
  assert.equal(result.env.TOOL_RUN_DIR, runDir);
  assert.equal(result.env.AWS_REGION, 'us-east-1');
  assert.equal(result.env.LOG_BUCKET, 'app-logs');
  assert.equal(fs.existsSync(path.join(queryDir, 'tools', 'workspace', 'last-call.txt')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'result.json')), true);
  assert.equal(usage.toolCallsByName.fetch_logs, 1);
});
