const { v4: uuidv4 } = require('uuid');
const { assistantTools, TOOL_NAMES } = require('../openai');

const MAX_SCHEMA_TABLES = 50;
const MAX_COLUMNS_PER_TABLE = 50;
const MAX_TOOL_ROUNDS = 6;

function resolveOpenAiApiKey(config) {
  const openaiConfig = config.openai || {};
  const envVarName = openaiConfig.apiKeyEnvVar;
  const envValue =
    typeof envVarName === 'string' && envVarName.trim() !== '' ? process.env[envVarName.trim()] : null;
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    return envValue.trim();
  }

  if (typeof openaiConfig.apiKey === 'string' && openaiConfig.apiKey.trim() !== '') {
    return openaiConfig.apiKey.trim();
  }

  return null;
}

function summarizeSchema(schemaResult) {
  const tables = Array.isArray(schemaResult?.tables) ? schemaResult.tables : [];
  const limitedTables = tables.slice(0, MAX_SCHEMA_TABLES).map((table) => ({
    table: table.name,
    columns: (Array.isArray(table.columns) ? table.columns : [])
      .slice(0, MAX_COLUMNS_PER_TABLE)
      .map((column) => ({ name: column.name, type: column.type }))
  }));

  return {
    totalTables: tables.length,
    includedTables: limitedTables.length,
    truncated: tables.length > limitedTables.length,
    tables: limitedTables
  };
}

function parseJsonArgs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function extractAssistantText(responseJson) {
  if (!responseJson) {
    return '';
  }

  if (typeof responseJson.output_text === 'string' && responseJson.output_text.trim() !== '') {
    return responseJson.output_text.trim();
  }

  const output = Array.isArray(responseJson.output) ? responseJson.output : [];
  const chunks = [];
  output.forEach((item) => {
    if (item?.type !== 'message') {
      return;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    content.forEach((part) => {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    });
  });

  return chunks.join('\n').trim();
}

function extractFunctionCalls(responseJson) {
  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  return output
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({
      id: item.call_id || item.id || uuidv4(),
      name: item.name,
      arguments: typeof item.arguments === 'string' ? item.arguments : '{}'
    }));
}

class AssistantService {
  constructor({ assistantStore, queryStore, athenaService, lockManager, config, logger }) {
    this.assistantStore = assistantStore;
    this.queryStore = queryStore;
    this.athenaService = athenaService;
    this.lockManager = lockManager;
    this.logger = logger;
    this.model = config.openai?.model || 'gpt-5';
    this.baseURL = (config.openai?.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.timeoutMs = Number(config.openai?.timeoutMs || 30000);
    this.apiKey = resolveOpenAiApiKey(config);
  }

  ensureConfigured() {
    if (!this.apiKey) {
      const error = new Error('OpenAI API key is not configured');
      error.code = 'OPENAI_NOT_CONFIGURED';
      throw error;
    }
  }

  async createSessionSeedMessage(query) {
    const databaseName = query.databaseName || (await this.athenaService.resolveDatabaseName(null));
    let schemaSummary;

    try {
      const schema = await this.athenaService.listTableSchema(databaseName);
      schemaSummary = summarizeSchema(schema);
    } catch (error) {
      schemaSummary = {
        totalTables: 0,
        includedTables: 0,
        truncated: false,
        schemaLookupError: error.message,
        tables: []
      };
    }

    const seedPayload = {
      instruction:
        'You are a SQL assistant for AWS Athena. Provide concise, practical guidance and valid Athena SQL.',
      selectedDatabase: databaseName,
      currentQueryText: query.queryText || null,
      schema: schemaSummary
    };

    return JSON.stringify(seedPayload, null, 2);
  }

  async getOrCreateSession(query) {
    let session = await this.assistantStore.getSessionByQueryId(query.id);
    if (session) {
      return { session, created: false };
    }

    session = await this.assistantStore.createSession({
      id: uuidv4(),
      queryId: query.id,
      mode: 'query_assistant',
      provider: 'openai',
      model: this.model
    });

    const seedMessage = await this.createSessionSeedMessage(query);
    await this.assistantStore.createMessage({
      id: uuidv4(),
      sessionId: session.id,
      role: 'system',
      content: seedMessage,
      contentType: 'text'
    });

    return { session, created: true };
  }

  async executeTool(toolName, args) {
    if (toolName === TOOL_NAMES.LIST_DATABASES) {
      const databases = await this.athenaService.listDatabases();
      return { databases };
    }

    if (toolName === TOOL_NAMES.LIST_TABLES) {
      const database = typeof args?.database === 'string' ? args.database.trim() : '';
      if (!database) {
        throw new Error('database is required');
      }
      return this.athenaService.listTables(database);
    }

    if (toolName === TOOL_NAMES.GET_TABLE_SCHEMA) {
      const database = typeof args?.database === 'string' ? args.database.trim() : '';
      const table = typeof args?.table === 'string' ? args.table.trim() : '';
      if (!database || !table) {
        throw new Error('database and table are required');
      }
      return this.athenaService.getTableSchema(database, table);
    }

    if (toolName === TOOL_NAMES.VALIDATE_QUERY) {
      const database = typeof args?.database === 'string' ? args.database.trim() : '';
      const query = typeof args?.query === 'string' ? args.query : '';
      if (!database || !query.trim()) {
        throw new Error('database and query are required');
      }
      return this.athenaService.validateQuery(query, { databaseName: database });
    }

    if (toolName === TOOL_NAMES.GET_QUERY) {
      const queryId = typeof args?.queryId === 'string' ? args.queryId.trim() : '';
      if (!queryId) {
        throw new Error('queryId is required');
      }
      const query = await this.queryStore.getById(queryId);
      if (!query) {
        return { error: 'QUERY_NOT_FOUND', queryId };
      }
      return {
        id: query.id,
        name: query.name,
        database: query.databaseName,
        status: query.status,
        query: query.queryText,
        submittedAt: query.submittedAt,
        updatedAt: query.updatedAt
      };
    }

    throw new Error(`unsupported tool: ${toolName}`);
  }

  async callOpenAi({ input, previousResponseId }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          input,
          tools: assistantTools,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {})
        }),
        signal: controller.signal
      });

      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMessage = json?.error?.message || `OpenAI request failed with HTTP ${response.status}`;
        const error = new Error(errMessage);
        error.code = 'OPENAI_REQUEST_FAILED';
        throw error;
      }

      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  async shouldCancel(sessionId) {
    const latest = await this.assistantStore.getSessionById(sessionId);
    return latest && latest.runStatus === 'CANCELLING';
  }

  async buildRunStartContext(sessionId, userPrompt) {
    const session = await this.assistantStore.getSessionById(sessionId);
    const trimmedPrompt = String(userPrompt || '').trim();
    if (session?.openaiConversationId) {
      return {
        previousResponseId: session.openaiConversationId,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: trimmedPrompt }]
          }
        ]
      };
    }

    const messages = await this.assistantStore.listMessagesBySessionId(sessionId);
    const seed = messages.find((message) => message.role === 'system');
    const input = [];
    if (seed && typeof seed.content === 'string' && seed.content.trim() !== '') {
      input.push({
        role: 'system',
        content: [{ type: 'input_text', text: seed.content }]
      });
    }
    input.push({
      role: 'user',
      content: [{ type: 'input_text', text: trimmedPrompt }]
    });

    return {
      previousResponseId: null,
      input
    };
  }

  async runAssistantLoop(sessionId, userPrompt) {
    const startContext = await this.buildRunStartContext(sessionId, userPrompt);
    let input = startContext.input;
    let previousResponseId = startContext.previousResponseId;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (await this.shouldCancel(sessionId)) {
        await this.assistantStore.markRunCancelled(sessionId);
        return { cancelled: true };
      }

      const responseJson = await this.callOpenAi({ input, previousResponseId });
      previousResponseId = responseJson.id || previousResponseId;
      if (responseJson.id) {
        await this.assistantStore.updateOpenAiConversationId(sessionId, responseJson.id);
      }
      const usage = responseJson.usage || {};
      await this.assistantStore.addTokenUsage(sessionId, {
        prompt: usage.input_tokens || 0,
        completion: usage.output_tokens || 0,
        total: usage.total_tokens || 0
      });

      const assistantText = extractAssistantText(responseJson);
      if (assistantText) {
        await this.assistantStore.createMessage({
          id: uuidv4(),
          sessionId,
          role: 'assistant',
          content: assistantText,
          contentType: 'text',
          openaiResponseId: responseJson.id || null,
          tokenUsagePrompt: usage.input_tokens ?? null,
          tokenUsageCompletion: usage.output_tokens ?? null,
          tokenUsageTotal: usage.total_tokens ?? null
        });
      }

      const functionCalls = extractFunctionCalls(responseJson);
      if (functionCalls.length === 0) {
        await this.assistantStore.markRunSucceeded(sessionId);
        return { cancelled: false };
      }

      const toolOutputs = [];
      for (const call of functionCalls) {
        const parsedArgs = parseJsonArgs(call.arguments);
        let toolResult;

        if (parsedArgs === null) {
          toolResult = {
            error: 'INVALID_TOOL_ARGUMENTS',
            message: 'Tool arguments must be valid JSON'
          };
        } else {
          try {
            toolResult = await this.executeTool(call.name, parsedArgs);
          } catch (error) {
            toolResult = {
              error: 'TOOL_EXECUTION_FAILED',
              message: error.message
            };
          }
        }

        await this.assistantStore.createMessage({
          id: uuidv4(),
          sessionId,
          role: 'tool',
          content: JSON.stringify(
            {
              name: call.name,
              args: parsedArgs === null ? call.arguments : parsedArgs,
              result: toolResult
            },
            null,
            2
          ),
          contentType: 'json',
          openaiResponseId: responseJson.id || null,
          toolName: call.name || null,
          toolCallId: call.id || null,
          toolArgsJson: parsedArgs === null ? call.arguments : JSON.stringify(parsedArgs),
          toolResultJson: JSON.stringify(toolResult)
        });

        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.id,
          output: JSON.stringify(toolResult)
        });
      }

      input = toolOutputs;
      if (await this.shouldCancel(sessionId)) {
        await this.assistantStore.markRunCancelled(sessionId);
        return { cancelled: true };
      }
    }

    throw new Error(`Assistant tool loop exceeded maximum rounds (${MAX_TOOL_ROUNDS})`);
  }

  async send(queryId, prompt) {
    this.ensureConfigured();

    return this.lockManager.runWithLock(`assistant:${queryId}`, async () => {
      const query = await this.queryStore.getById(queryId);
      if (!query) {
        return { error: 'QUERY_NOT_FOUND' };
      }

      const { session } = await this.getOrCreateSession(query);
      if (session.runStatus === 'RUNNING' || session.runStatus === 'CANCELLING') {
        return { error: 'RUN_ACTIVE', session };
      }

      const started = await this.assistantStore.markRunStarted(session.id);
      if (!started) {
        const latestSession = await this.assistantStore.getSessionById(session.id);
        if (latestSession && (latestSession.runStatus === 'RUNNING' || latestSession.runStatus === 'CANCELLING')) {
          return { error: 'RUN_ACTIVE', session: latestSession };
        }
        return { error: 'RUN_START_FAILED' };
      }

      await this.assistantStore.createMessage({
        id: uuidv4(),
        sessionId: session.id,
        role: 'user',
        content: prompt,
        contentType: 'text'
      });

      setImmediate(() => {
        this.runAssistantLoop(session.id, prompt).catch(async (error) => {
          this.logger.error('Assistant run failed', {
            queryId,
            sessionId: session.id,
            error: error.message
          });
          await this.assistantStore.markRunFailed(session.id, error.message);
        });
      });

      const current = await this.assistantStore.getSessionById(session.id);
      return {
        accepted: true,
        sessionId: session.id,
        runStatus: current.runStatus,
        runStartedAt: current.runStartedAt
      };
    });
  }

  async getStatus(queryId) {
    const query = await this.queryStore.getById(queryId);
    if (!query) {
      return { error: 'QUERY_NOT_FOUND' };
    }

    const session = await this.assistantStore.getSessionByQueryId(queryId);
    if (!session) {
      return {
        queryId,
        sessionExists: false,
        runStatus: 'IDLE'
      };
    }

    return {
      queryId,
      sessionExists: true,
      sessionId: session.id,
      runStatus: session.runStatus,
      runStartedAt: session.runStartedAt,
      runFinishedAt: session.runFinishedAt,
      cancelRequestedAt: session.cancelRequestedAt,
      lastErrorMessage: session.lastErrorMessage
    };
  }

  async cancel(queryId) {
    return this.lockManager.runWithLock(`assistant:${queryId}`, async () => {
      const query = await this.queryStore.getById(queryId);
      if (!query) {
        return { error: 'QUERY_NOT_FOUND' };
      }

      const session = await this.assistantStore.getSessionByQueryId(queryId);
      if (!session) {
        return { error: 'NO_ACTIVE_RUN' };
      }

      if (session.runStatus === 'RUNNING') {
        const updated = await this.assistantStore.requestCancel(session.id);
        if (!updated) {
          return { error: 'NO_ACTIVE_RUN' };
        }
        const latest = await this.assistantStore.getSessionById(session.id);
        return {
          queryId,
          sessionId: latest.id,
          runStatus: latest.runStatus,
          cancelRequestedAt: latest.cancelRequestedAt
        };
      }

      if (session.runStatus === 'CANCELLING') {
        return {
          queryId,
          sessionId: session.id,
          runStatus: session.runStatus,
          cancelRequestedAt: session.cancelRequestedAt
        };
      }

      return { error: 'NO_ACTIVE_RUN' };
    });
  }

  async listMessages(queryId) {
    const query = await this.queryStore.getById(queryId);
    if (!query) {
      return { error: 'QUERY_NOT_FOUND' };
    }

    const session = await this.assistantStore.getSessionByQueryId(queryId);
    if (!session) {
      return {
        queryId,
        sessionExists: false,
        messages: []
      };
    }

    const messages = await this.assistantStore.listMessagesBySessionId(session.id);
    return {
      queryId,
      sessionExists: true,
      sessionId: session.id,
      messages
    };
  }
}

module.exports = {
  AssistantService
};
