const { v4: uuidv4 } = require('uuid');
const { TOOL_NAMES, assistantToolDefinitions } = require('../assistant/tools');
const { OpenAIProvider } = require('../assistant/providers/openaiProvider');
const { AnthropicProvider } = require('../assistant/providers/anthropicProvider');
const { rewriteReadQueryWithHardLimit } = require('../assistant/readQueryGuard');

const MAX_SCHEMA_TABLES = 50;
const MAX_COLUMNS_PER_TABLE = 50;
const DEFAULT_MAX_TOOL_ROUNDS = 1000;
const MAX_READ_QUERY_TOOL_CALLS = 5;
const READ_QUERY_ROW_LIMIT = 500;
const DEFAULT_READ_QUERY_MAX_COLUMNS = 30;
const MAX_READ_QUERY_COLUMNS = 50;
const DEFAULT_SEED_INSTRUCTION =
  'You are a SQL assistant for AWS Athena. Provide concise, practical guidance and valid Athena SQL.';

function resolveApiKey({ provider, assistantConfig, legacyOpenAiConfig }) {
  const envVarName =
    assistantConfig.apiKeyEnvVar ||
    legacyOpenAiConfig.apiKeyEnvVar ||
    (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');

  const envValue =
    typeof envVarName === 'string' && envVarName.trim() !== '' ? process.env[envVarName.trim()] : null;
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    return envValue.trim();
  }

  const configKey = assistantConfig.apiKey || legacyOpenAiConfig.apiKey;
  if (typeof configKey === 'string' && configKey.trim() !== '') {
    return configKey.trim();
  }

  return null;
}

function resolveAssistantRuntimeConfig(config = {}) {
  const assistantConfig = config.assistant || {};
  const providersConfig = config.providers || {};
  const legacyOpenAiConfig = config.openai || {};

  const providerRaw = assistantConfig.provider || 'openai';
  const provider = String(providerRaw).trim().toLowerCase();

  const assistantSeedInstruction =
    assistantConfig.assistantSeedInstruction ||
    legacyOpenAiConfig.assistantSeedInstruction ||
    DEFAULT_SEED_INSTRUCTION;

  const apiKey = resolveApiKey({ provider, assistantConfig, legacyOpenAiConfig });

  const openaiProviderConfig = {
    model: providersConfig.openai?.model || legacyOpenAiConfig.model || 'gpt-5',
    baseURL: providersConfig.openai?.baseURL || legacyOpenAiConfig.baseURL || 'https://api.openai.com/v1'
  };

  const anthropicProviderConfig = {
    model: providersConfig.anthropic?.model || 'claude-sonnet-4-5',
    baseURL: providersConfig.anthropic?.baseURL || 'https://api.anthropic.com',
    version: providersConfig.anthropic?.version || '2023-06-01',
    maxTokens: providersConfig.anthropic?.maxTokens || 2048
  };

  return {
    provider,
    apiKey,
    assistantSeedInstruction,
    openaiProviderConfig,
    anthropicProviderConfig
  };
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

function mapStoredMessagesToOpenAiInput(messages, userPrompt) {
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
    content: [{ type: 'input_text', text: String(userPrompt || '').trim() }]
  });

  return input;
}

function mapStoredMessagesToAnthropicContext(messages, userPrompt) {
  const seed = messages.find((message) => message.role === 'system');
  const system = seed && typeof seed.content === 'string' ? seed.content.trim() : '';
  const promptText = String(userPrompt || '').trim();

  const mappedMessages = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: String(message.content || '') }]
    }));

  const last = mappedMessages[mappedMessages.length - 1];
  if (last && last.role === 'user') {
    const lastText = String(last.content?.[0]?.text || '').trim();
    if (lastText === promptText) {
      mappedMessages.pop();
    }
  }

  mappedMessages.push({
    role: 'user',
    content: [{ type: 'text', text: promptText }]
  });

  return {
    system,
    messages: mappedMessages
  };
}

function summarizeForLog(value, maxLength = 800) {
  if (value === null || value === undefined) {
    return null;
  }

  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch (_error) {
      text = String(value);
    }
  }

  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text;
}

function isMissingToolOutputError(error) {
  const msg = String(error?.message || '');
  return /No tool output found for function call/i.test(msg);
}

function isToolLoopExceededError(error) {
  const msg = String(error?.message || '');
  return /Assistant tool loop exceeded maximum rounds/i.test(msg);
}

class AssistantService {
  constructor({ assistantStore, queryStore, athenaService, lockManager, config, logger }) {
    this.assistantStore = assistantStore;
    this.queryStore = queryStore;
    this.athenaService = athenaService;
    this.lockManager = lockManager;
    this.logger = logger;

    const runtimeConfig = resolveAssistantRuntimeConfig(config);
    this.providerName = runtimeConfig.provider;
    this.assistantSeedInstruction = runtimeConfig.assistantSeedInstruction;
    this.toolDefinitions = assistantToolDefinitions;
    this.maxToolRounds = Math.max(1, Number(config.assistant?.maxToolRounds || DEFAULT_MAX_TOOL_ROUNDS));

    if (this.providerName === 'openai') {
      this.provider = new OpenAIProvider({
        apiKey: runtimeConfig.apiKey,
        model: runtimeConfig.openaiProviderConfig.model,
        baseURL: runtimeConfig.openaiProviderConfig.baseURL
      });
      this.model = runtimeConfig.openaiProviderConfig.model;
    } else if (this.providerName === 'anthropic') {
      this.provider = new AnthropicProvider({
        apiKey: runtimeConfig.apiKey,
        model: runtimeConfig.anthropicProviderConfig.model,
        baseURL: runtimeConfig.anthropicProviderConfig.baseURL,
        version: runtimeConfig.anthropicProviderConfig.version,
        maxTokens: runtimeConfig.anthropicProviderConfig.maxTokens
      });
      this.model = runtimeConfig.anthropicProviderConfig.model;
    } else {
      const error = new Error(`Unsupported assistant provider: ${this.providerName}`);
      error.code = 'ASSISTANT_PROVIDER_UNSUPPORTED';
      throw error;
    }
  }

  ensureConfigured() {
    this.provider.ensureConfigured();
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
      instruction: this.assistantSeedInstruction,
      selectedDatabase: databaseName,
      currentQueryText: query.queryText || null,
      schema: schemaSummary
    };

    return JSON.stringify(seedPayload, null, 2);
  }

  async getOrCreateSession(query) {
    let session = await this.assistantStore.getSessionByQueryIdAndProvider(query.id, this.providerName);
    if (session) {
      return { session, created: false };
    }

    session = await this.assistantStore.createSession({
      id: uuidv4(),
      queryId: query.id,
      mode: 'query_assistant',
      provider: this.providerName,
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

  async executeTool(toolName, args, toolContext = {}) {
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

    if (toolName === TOOL_NAMES.RUN_READ_QUERY) {
      const queryId = toolContext.queryId || null;
      const sessionId = toolContext.sessionId || null;
      const usage = toolContext.usage || { readQueryCalls: 0 };

      if (usage.readQueryCalls >= MAX_READ_QUERY_TOOL_CALLS) {
        this.logger.warn('Assistant run_read_query blocked due to per-run budget', {
          queryId,
          sessionId,
          maxCalls: MAX_READ_QUERY_TOOL_CALLS
        });
        return {
          error: 'READ_QUERY_LIMIT_REACHED',
          message: `run_read_query may only be called ${MAX_READ_QUERY_TOOL_CALLS} times per assistant run`
        };
      }

      const queryText = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!queryText) {
        return {
          error: 'INVALID_REQUEST',
          message: 'query is required'
        };
      }

      const database = typeof args?.database === 'string' ? args.database.trim() : '';
      const requestedMaxColumns = Number(args?.maxColumns || DEFAULT_READ_QUERY_MAX_COLUMNS);
      const maxColumns = Math.max(1, Math.min(MAX_READ_QUERY_COLUMNS, requestedMaxColumns));

      const guarded = rewriteReadQueryWithHardLimit(queryText, READ_QUERY_ROW_LIMIT);
      if (!guarded.valid) {
        this.logger.warn('Assistant run_read_query blocked by read guard', {
          queryId,
          sessionId,
          reason: guarded.reason
        });
        return {
          error: 'READ_QUERY_BLOCKED',
          message: guarded.reason
        };
      }

      usage.readQueryCalls += 1;
      this.logger.info('Assistant run_read_query allowed', {
        queryId,
        sessionId,
        readQueryCallCount: usage.readQueryCalls,
        maxReadQueryCalls: MAX_READ_QUERY_TOOL_CALLS,
        database: database || null,
        originalQuery: guarded.normalizedQuery,
        rewrittenQuery: guarded.rewrittenQuery,
        enforcedRowLimit: guarded.enforcedRowLimit,
        maxColumns
      });

      try {
        const result = await this.athenaService.executeReadQuery(guarded.rewrittenQuery, {
          databaseName: database || null,
          maxRows: READ_QUERY_ROW_LIMIT,
          maxColumns
        });
        this.logger.info('Assistant run_read_query completed', {
          queryId,
          sessionId,
          readQueryCallCount: usage.readQueryCalls,
          athenaQueryExecutionId: result.athenaQueryExecutionId,
          rowCount: result.rowCount,
          truncatedRows: result.truncatedRows,
          truncatedColumns: result.truncatedColumns,
          dataScannedBytes: result.stats?.dataScannedBytes || 0,
          totalExecutionTimeMs: result.stats?.totalExecutionTimeMs || 0
        });

        return {
          database: result.databaseName,
          athenaQueryExecutionId: result.athenaQueryExecutionId,
          rewrittenQuery: guarded.rewrittenQuery,
          limits: {
            maxRows: READ_QUERY_ROW_LIMIT,
            maxColumns
          },
          rowCount: result.rowCount,
          truncatedRows: result.truncatedRows,
          truncatedColumns: result.truncatedColumns,
          stats: result.stats,
          columns: result.columns,
          rows: result.rows
        };
      } catch (error) {
        this.logger.error('Assistant run_read_query failed', {
          queryId,
          sessionId,
          readQueryCallCount: usage.readQueryCalls,
          message: error.message,
          code: error.code || null
        });
        return {
          error: 'READ_QUERY_EXECUTION_FAILED',
          message: error.message
        };
      }
    }

    throw new Error(`unsupported tool: ${toolName}`);
  }

  async shouldCancel(sessionId) {
    const latest = await this.assistantStore.getSessionById(sessionId);
    return latest && latest.runStatus === 'CANCELLING';
  }

  async persistModelOutput(sessionId, providerResponse) {
    if (providerResponse.providerConversationId) {
      await this.assistantStore.updateProviderConversationId(sessionId, providerResponse.providerConversationId);
    }

    await this.assistantStore.addTokenUsage(sessionId, providerResponse.usage);

    if (providerResponse.assistantText) {
      const openaiResponseId = this.providerName === 'openai' ? providerResponse.providerResponseId || null : null;
      await this.assistantStore.createMessage({
        id: uuidv4(),
        sessionId,
        role: 'assistant',
        content: providerResponse.assistantText,
        contentType: 'text',
        providerResponseId: providerResponse.providerResponseId || null,
        openaiResponseId,
        tokenUsagePrompt: providerResponse.usage.prompt ?? null,
        tokenUsageCompletion: providerResponse.usage.completion ?? null,
        tokenUsageTotal: providerResponse.usage.total ?? null
      });
    }
  }

  async runOpenAiLoop(sessionId, userPrompt, runContext = {}) {
    const session = await this.assistantStore.getSessionById(sessionId);
    const messages = await this.assistantStore.listMessagesBySessionId(sessionId);

    const failedWithDanglingTools =
      /No tool output found for function call|Assistant tool loop exceeded maximum rounds/i.test(
        String(session?.lastErrorMessage || '')
      );
    let previousResponseId =
      failedWithDanglingTools ? null : session?.providerConversationId || session?.openaiConversationId || null;
    let input = previousResponseId
      ? [
          {
            role: 'user',
            content: [{ type: 'input_text', text: String(userPrompt || '').trim() }]
          }
        ]
      : mapStoredMessagesToOpenAiInput(messages, userPrompt);

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      if (await this.shouldCancel(sessionId)) {
        await this.assistantStore.markRunCancelled(sessionId);
        return { cancelled: true };
      }

      let providerResponse;
      try {
        providerResponse = await this.provider.send({
          input,
          previousResponseId,
          tools: this.toolDefinitions
        });
      } catch (error) {
        if (isMissingToolOutputError(error) && previousResponseId) {
          this.logger.warn('Assistant OpenAI conversation desynced; resetting conversation linkage and retrying', {
            queryId: runContext.queryId || null,
            sessionId: runContext.sessionId || null,
            previousResponseId
          });
          previousResponseId = null;
          await this.assistantStore.updateProviderConversationId(sessionId, null);
          input = mapStoredMessagesToOpenAiInput(messages, userPrompt);
          providerResponse = await this.provider.send({
            input,
            previousResponseId,
            tools: this.toolDefinitions
          });
        } else {
          throw error;
        }
      }

      previousResponseId = providerResponse.providerConversationId || previousResponseId;
      await this.persistModelOutput(sessionId, providerResponse);

      if (!Array.isArray(providerResponse.toolCalls) || providerResponse.toolCalls.length === 0) {
        await this.assistantStore.markRunSucceeded(sessionId);
        return { cancelled: false };
      }

      const toolOutputs = [];
      for (const call of providerResponse.toolCalls) {
        let toolResult;
        const parsedArgs = call.argumentsJson;

        this.logger.info('Assistant tool call started', {
          queryId: runContext.queryId || null,
          sessionId: runContext.sessionId || null,
          provider: this.providerName,
          toolName: call.name || null,
          toolCallId: call.id || null,
          toolArgs: summarizeForLog(parsedArgs === null ? call.argumentsRaw : parsedArgs)
        });

        if (parsedArgs === null) {
          toolResult = {
            error: 'INVALID_TOOL_ARGUMENTS',
            message: 'Tool arguments must be valid JSON'
          };
        } else {
          try {
            toolResult = await this.executeTool(call.name, parsedArgs, runContext);
          } catch (error) {
            this.logger.warn('Assistant tool call failed', {
              queryId: runContext.queryId || null,
              sessionId: runContext.sessionId || null,
              provider: this.providerName,
              toolName: call.name || null,
              toolCallId: call.id || null,
              error: error.message
            });
            toolResult = {
              error: 'TOOL_EXECUTION_FAILED',
              message: error.message
            };
          }
        }

        this.logger.info('Assistant tool call completed', {
          queryId: runContext.queryId || null,
          sessionId: runContext.sessionId || null,
          provider: this.providerName,
          toolName: call.name || null,
          toolCallId: call.id || null,
          toolResult: summarizeForLog(toolResult)
        });

        await this.assistantStore.createMessage({
          id: uuidv4(),
          sessionId,
          role: 'tool',
          content: JSON.stringify(
            {
              name: call.name,
              args: parsedArgs === null ? call.argumentsRaw : parsedArgs,
              result: toolResult
            },
            null,
            2
          ),
          contentType: 'json',
          providerResponseId: providerResponse.providerResponseId || null,
          openaiResponseId:
            this.providerName === 'openai' ? providerResponse.providerResponseId || null : null,
          toolName: call.name || null,
          toolCallId: call.id || null,
          toolArgsJson: parsedArgs === null ? call.argumentsRaw : JSON.stringify(parsedArgs),
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

    await this.assistantStore.updateProviderConversationId(sessionId, null);
    throw new Error(`Assistant tool loop exceeded maximum rounds (${this.maxToolRounds})`);
  }

  async runAnthropicLoop(sessionId, userPrompt, runContext = {}) {
    const messages = await this.assistantStore.listMessagesBySessionId(sessionId);
    const context = mapStoredMessagesToAnthropicContext(messages, userPrompt);

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      if (await this.shouldCancel(sessionId)) {
        await this.assistantStore.markRunCancelled(sessionId);
        return { cancelled: true };
      }

      const providerResponse = await this.provider.send({
        system: context.system,
        messages: context.messages,
        tools: this.toolDefinitions
      });

      await this.persistModelOutput(sessionId, providerResponse);

      if (!Array.isArray(providerResponse.toolCalls) || providerResponse.toolCalls.length === 0) {
        await this.assistantStore.markRunSucceeded(sessionId);
        return { cancelled: false };
      }

      const assistantContentBlocks = Array.isArray(providerResponse.assistantContentBlocks)
        ? providerResponse.assistantContentBlocks
        : [];

      if (assistantContentBlocks.length > 0) {
        context.messages.push({ role: 'assistant', content: assistantContentBlocks });
      }

      const toolResultBlocks = [];
      for (const call of providerResponse.toolCalls) {
        let toolResult;
        const parsedArgs = call.argumentsJson;

        this.logger.info('Assistant tool call started', {
          queryId: runContext.queryId || null,
          sessionId: runContext.sessionId || null,
          provider: this.providerName,
          toolName: call.name || null,
          toolCallId: call.id || null,
          toolArgs: summarizeForLog(parsedArgs === null ? call.argumentsRaw : parsedArgs)
        });

        if (parsedArgs === null) {
          toolResult = {
            error: 'INVALID_TOOL_ARGUMENTS',
            message: 'Tool arguments must be valid JSON'
          };
        } else {
          try {
            toolResult = await this.executeTool(call.name, parsedArgs, runContext);
          } catch (error) {
            this.logger.warn('Assistant tool call failed', {
              queryId: runContext.queryId || null,
              sessionId: runContext.sessionId || null,
              provider: this.providerName,
              toolName: call.name || null,
              toolCallId: call.id || null,
              error: error.message
            });
            toolResult = {
              error: 'TOOL_EXECUTION_FAILED',
              message: error.message
            };
          }
        }

        this.logger.info('Assistant tool call completed', {
          queryId: runContext.queryId || null,
          sessionId: runContext.sessionId || null,
          provider: this.providerName,
          toolName: call.name || null,
          toolCallId: call.id || null,
          toolResult: summarizeForLog(toolResult)
        });

        await this.assistantStore.createMessage({
          id: uuidv4(),
          sessionId,
          role: 'tool',
          content: JSON.stringify(
            {
              name: call.name,
              args: parsedArgs === null ? call.argumentsRaw : parsedArgs,
              result: toolResult
            },
            null,
            2
          ),
          contentType: 'json',
          providerResponseId: providerResponse.providerResponseId || null,
          openaiResponseId:
            this.providerName === 'openai' ? providerResponse.providerResponseId || null : null,
          toolName: call.name || null,
          toolCallId: call.id || null,
          toolArgsJson: parsedArgs === null ? call.argumentsRaw : JSON.stringify(parsedArgs),
          toolResultJson: JSON.stringify(toolResult)
        });

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(toolResult)
        });
      }

      context.messages.push({ role: 'user', content: toolResultBlocks });

      if (await this.shouldCancel(sessionId)) {
        await this.assistantStore.markRunCancelled(sessionId);
        return { cancelled: true };
      }
    }

    throw new Error(`Assistant tool loop exceeded maximum rounds (${this.maxToolRounds})`);
  }

  async runAssistantLoop(sessionId, userPrompt, runContext = {}) {
    if (this.providerName === 'openai') {
      return this.runOpenAiLoop(sessionId, userPrompt, runContext);
    }
    return this.runAnthropicLoop(sessionId, userPrompt, runContext);
  }

  async send(queryId, prompt) {
    this.ensureConfigured();

    return this.lockManager.runWithLock(`assistant:${queryId}`, async () => {
      const query = await this.queryStore.getById(queryId);
      if (!query) {
        return { error: 'QUERY_NOT_FOUND' };
      }

      const activeSession = await this.assistantStore.getActiveSessionByQueryId(query.id);
      if (activeSession) {
        return { error: 'RUN_ACTIVE', session: activeSession };
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
        this.runAssistantLoop(session.id, prompt, {
          queryId,
          sessionId: session.id,
          usage: {
            readQueryCalls: 0
          }
        }).catch(async (error) => {
          if (isMissingToolOutputError(error) || isToolLoopExceededError(error)) {
            await this.assistantStore.updateProviderConversationId(session.id, null);
          }
          this.logger.error('Assistant run failed', {
            queryId,
            sessionId: session.id,
            provider: this.providerName,
            error: error.message
          });
          await this.assistantStore.markRunFailed(session.id, error.message);
        });
      });

      const current = await this.assistantStore.getSessionById(session.id);
      return {
        accepted: true,
        sessionId: session.id,
        provider: this.providerName,
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

    const session = await this.assistantStore.getSessionByQueryIdAndProvider(queryId, this.providerName);
    if (!session) {
      return {
        queryId,
        provider: this.providerName,
        sessionExists: false,
        runStatus: 'IDLE'
      };
    }

    return {
      queryId,
      provider: this.providerName,
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

      const session = await this.assistantStore.getActiveSessionByQueryId(queryId);
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
          provider: latest.provider,
          runStatus: latest.runStatus,
          cancelRequestedAt: latest.cancelRequestedAt
        };
      }

      if (session.runStatus === 'CANCELLING') {
        return {
          queryId,
          sessionId: session.id,
          provider: session.provider,
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

    const session = await this.assistantStore.getSessionByQueryIdAndProvider(queryId, this.providerName);
    if (!session) {
      return {
        queryId,
        provider: this.providerName,
        sessionExists: false,
        messages: []
      };
    }

    const messages = await this.assistantStore.listMessagesBySessionId(session.id);
    return {
      queryId,
      provider: this.providerName,
      sessionExists: true,
      sessionId: session.id,
      messages
    };
  }
}

module.exports = {
  AssistantService
};
