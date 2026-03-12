const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const crypto = require('node:crypto');
const { TOOL_NAMES } = require('../assistant/tools');
const { buildAssistantToolRegistry } = require('../assistant/toolRegistry');
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

function mapStoredMessagesToOpenAiInput(messages) {
  const seed = messages.find((message) => message.role === 'system');
  const input = [];

  if (seed && typeof seed.content === 'string' && seed.content.trim() !== '') {
    input.push({
      role: 'system',
      content: [{ type: 'input_text', text: seed.content }]
    });
  }

  const conversational = messages.filter((message) => message.role === 'user' || message.role === 'assistant');
  conversational.forEach((message) => {
    const text = String(message.content || '').trim();
    if (!text) {
      return;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const contentType = role === 'assistant' ? 'output_text' : 'input_text';
    input.push({
      role,
      content: [{ type: contentType, text }]
    });
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

function normalizeDatabaseName(databaseName) {
  return typeof databaseName === 'string' && databaseName.trim() !== '' ? databaseName.trim() : null;
}

function buildQueryContextSnapshot(query) {
  const normalizedDatabaseName = normalizeDatabaseName(query?.databaseName);
  const queryText = typeof query?.queryText === 'string' ? query.queryText : '';
  const seedQueryHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ databaseName: normalizedDatabaseName, queryText }))
    .digest('hex');

  return {
    seedQueryHash,
    seedDatabaseName: normalizedDatabaseName
  };
}

function isMissingToolOutputError(error) {
  const msg = String(error?.message || '');
  return /No tool output found for function call/i.test(msg);
}

function isToolLoopExceededError(error) {
  const msg = String(error?.message || '');
  return /Assistant tool loop exceeded maximum rounds/i.test(msg);
}

function buildSearchToolEntry(tool, includeSchema) {
  const entry = {
    name: tool.name,
    description: tool.description,
    tags: Array.isArray(tool.tags) ? tool.tags : []
  };

  if (includeSchema) {
    entry.inputSchema = tool.inputSchema;
  }

  return entry;
}

function writeArtifact(filePath, value) {
  if (value === undefined || value === null) {
    return;
  }

  const contents =
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2);
  fs.writeFileSync(filePath, contents);
}

function runConfiguredToolProcess({ command, cwd, env, input, timeoutMs, maxStdoutBytes, maxStderrBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let stdoutLimitExceeded = false;
    let stderrLimitExceeded = false;
    let forceKillTimer = null;

    function requestStop() {
      if (!child.killed) {
        child.kill('SIGTERM');
      }

      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
        forceKillTimer.unref();
      }
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (maxStdoutBytes !== null && stdoutBytes > maxStdoutBytes) {
        stdoutLimitExceeded = true;
        requestStop();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (maxStderrBytes !== null && stderrBytes > maxStderrBytes) {
        stderrLimitExceeded = true;
        requestStop();
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (timedOut) {
        const error = new Error(`Tool timed out after ${timeoutMs}ms`);
        error.code = 'TOOL_TIMEOUT';
        error.stdout = stdout;
        error.stderr = stderr;
        error.stdoutBytes = stdoutBytes;
        error.stderrBytes = stderrBytes;
        reject(error);
        return;
      }

      if (stdoutLimitExceeded) {
        const error = new Error(`Tool stdout exceeded configured limit of ${maxStdoutBytes} bytes`);
        error.code = 'TOOL_STDOUT_LIMIT_EXCEEDED';
        error.stdout = stdout;
        error.stderr = stderr;
        error.stdoutBytes = stdoutBytes;
        error.stderrBytes = stderrBytes;
        reject(error);
        return;
      }

      if (stderrLimitExceeded) {
        const error = new Error(`Tool stderr exceeded configured limit of ${maxStderrBytes} bytes`);
        error.code = 'TOOL_STDERR_LIMIT_EXCEEDED';
        error.stdout = stdout;
        error.stderr = stderr;
        error.stdoutBytes = stdoutBytes;
        error.stderrBytes = stderrBytes;
        reject(error);
        return;
      }

      if (code !== 0) {
        const error = new Error(
          stderr && stderr.trim() ? stderr.trim() : `Tool exited with code ${code}${signal ? ` (${signal})` : ''}`
        );
        error.code = 'TOOL_EXIT_NONZERO';
        error.exitCode = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        error.stdoutBytes = stdoutBytes;
        error.stderrBytes = stderrBytes;
        reject(error);
        return;
      }

      let parsedOutput;
      try {
        parsedOutput = JSON.parse(stdout || 'null');
      } catch (_error) {
        const error = new Error('Tool stdout must be valid JSON');
        error.code = 'TOOL_INVALID_JSON';
        error.stdout = stdout;
        error.stderr = stderr;
        error.stdoutBytes = stdoutBytes;
        error.stderrBytes = stderrBytes;
        reject(error);
        return;
      }

      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        output: parsedOutput
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

class AssistantService {
  constructor({ assistantStore, queryStore, athenaService, lockManager, config, logger }) {
    this.assistantStore = assistantStore;
    this.queryStore = queryStore;
    this.athenaService = athenaService;
    this.lockManager = lockManager;
    this.logger = logger;

    const runtimeConfig = resolveAssistantRuntimeConfig(config);
    const toolRegistry = buildAssistantToolRegistry(config);
    this.providerName = runtimeConfig.provider;
    this.assistantSeedInstruction = runtimeConfig.assistantSeedInstruction;
    this.searchableTools = toolRegistry.searchableTools;
    this.toolDefinitions = toolRegistry.toolDefinitions;
    this.userToolsByName = toolRegistry.userToolsByName;
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

  async createSessionSeedMessage(query, options = {}) {
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
    if (typeof options.previousConversationSummary === 'string' && options.previousConversationSummary.trim() !== '') {
      seedPayload.previousConversationSummary = options.previousConversationSummary.trim();
    }

    return JSON.stringify(seedPayload, null, 2);
  }

  async createSessionForQuery(query, options = {}) {
    const snapshot = buildQueryContextSnapshot(query);
    const session = await this.assistantStore.createSession({
      id: uuidv4(),
      queryId: query.id,
      mode: 'query_assistant',
      provider: this.providerName,
      model: this.model,
      seedQueryHash: snapshot.seedQueryHash,
      seedDatabaseName: snapshot.seedDatabaseName
    });

    const seedMessage = await this.createSessionSeedMessage(query, options);
    await this.assistantStore.createMessage({
      id: uuidv4(),
      sessionId: session.id,
      role: 'system',
      content: seedMessage,
      contentType: 'text'
    });

    if (
      typeof options.visibleSummaryMessage === 'string' &&
      options.visibleSummaryMessage.trim() !== ''
    ) {
      await this.assistantStore.createMessage({
        id: uuidv4(),
        sessionId: session.id,
        role: 'assistant',
        content: options.visibleSummaryMessage.trim(),
        contentType: 'text'
      });
    }

    return session;
  }

  async getOrCreateSession(query) {
    let session = await this.assistantStore.getSessionByQueryIdAndProvider(query.id, this.providerName);
    if (session) {
      return { session, created: false };
    }

    session = await this.createSessionForQuery(query);

    return { session, created: true };
  }

  hasSessionQueryDrift(session, query) {
    const snapshot = buildQueryContextSnapshot(query);
    return (
      session.seedQueryHash !== snapshot.seedQueryHash ||
      normalizeDatabaseName(session.seedDatabaseName) !== snapshot.seedDatabaseName
    );
  }

  async rolloverSessionForQueryChange(query, previousSession) {
    const messages = await this.assistantStore.listMessagesBySessionId(previousSession.id);
    const summaryText = await this.summarizeConversation(messages, query);
    const session = await this.createSessionForQuery(query, {
      previousConversationSummary: summaryText,
      visibleSummaryMessage: `Conversation compacted from prior session after query update. Summary:\n\n${summaryText}`
    });
    return { session, created: true, rolledOver: true, summaryIncluded: Boolean(summaryText) };
  }

  async summarizeConversation(messages, query) {
    this.ensureConfigured();

    const transcript = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
      .map((message) => `${String(message.role || 'unknown').toUpperCase()}:\n${String(message.content || '')}`)
      .join('\n\n');

    const trimmedTranscript = transcript.length > 16000 ? transcript.slice(-16000) : transcript;
    const prompt = [
      'Summarize this SQL assistant conversation so a new session can continue seamlessly.',
      'Focus on:',
      '- user goals and constraints',
      '- useful schema/query findings',
      '- failed approaches and why they failed',
      '- current best SQL candidates and next recommended steps',
      '',
      `Query id: ${query.id}`,
      `Selected database: ${query.databaseName || '(not set)'}`,
      '',
      'Conversation transcript:',
      trimmedTranscript || '(empty)'
    ].join('\n');

    if (this.providerName === 'openai') {
      const response = await this.provider.send({
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: prompt }]
          }
        ],
        previousResponseId: null,
        tools: []
      });
      const summary = String(response.assistantText || '').trim();
      if (!summary) {
        throw new Error('Provider returned empty summary while compacting session');
      }
      return summary;
    }

    const response = await this.provider.send({
      system: 'You are a concise technical conversation summarizer.',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }]
        }
      ],
      tools: []
    });
    const summary = String(response.assistantText || '').trim();
    if (!summary) {
      throw new Error('Provider returned empty summary while compacting session');
    }
    return summary;
  }

  searchTools(args = {}) {
    const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
    const includeSchema = Boolean(args?.includeSchema);
    const requestedLimit =
      args?.limit === undefined || args?.limit === null || args?.limit === ''
        ? 20
        : Math.max(1, Math.min(100, Number(args.limit) || 20));

    const matchingTools = this.searchableTools.filter((tool) => {
      if (!query) {
        return true;
      }

      const haystack = [tool.name, tool.description].concat(Array.isArray(tool.tags) ? tool.tags : []);
      return haystack.some((value) => String(value || '').toLowerCase().includes(query));
    });

    return {
      totalTools: this.searchableTools.length,
      returnedTools: Math.min(requestedLimit, matchingTools.length),
      tools: matchingTools.slice(0, requestedLimit).map((tool) => buildSearchToolEntry(tool, includeSchema))
    };
  }

  buildConfiguredToolEnv(configuredTool, runtimePaths) {
    const env = {};

    if (process.env.PATH) {
      env.PATH = process.env.PATH;
    }
    if (process.env.LANG) {
      env.LANG = process.env.LANG;
    }
    if (process.env.TZ) {
      env.TZ = process.env.TZ;
    }

    Object.assign(env, configuredTool.credentialEnv || {}, configuredTool.runner.env || {});

    env.QUERY_DIR = runtimePaths.queryDir;
    env.RESULT_PATH = runtimePaths.resultPath;
    env.TOOL_WORKSPACE_DIR = runtimePaths.workspaceDir;
    env.TOOL_TMP_DIR = runtimePaths.tmpDir;
    env.TOOL_RUN_DIR = runtimePaths.runDir;
    env.TMPDIR = runtimePaths.tmpDir;

    return env;
  }

  async executeConfiguredTool(configuredTool, args, toolContext = {}) {
    const queryId = toolContext.queryId || null;
    const sessionId = toolContext.sessionId || null;
    const toolCallId = toolContext.toolCallId || null;
    const usage = toolContext.usage || {};
    const toolCallsByName = usage.toolCallsByName || (usage.toolCallsByName = {});
    const currentCallCount = Number(toolCallsByName[configuredTool.name] || 0);
    const maxCallsPerRun = Number(configuredTool.runner.maxCallsPerRun || 1);

    if (!queryId || !sessionId || !toolCallId) {
      return {
        error: 'TOOL_CONTEXT_MISSING',
        message: 'configured tool execution requires queryId, sessionId, and toolCallId'
      };
    }

    if (currentCallCount >= maxCallsPerRun) {
      return {
        error: 'TOOL_CALL_LIMIT_REACHED',
        message: `${configuredTool.name} may only be called ${maxCallsPerRun} times per assistant run`
      };
    }

    toolCallsByName[configuredTool.name] = currentCallCount + 1;

    const runtimePaths = this.athenaService.ensureToolRuntimePaths(queryId, sessionId, toolCallId);
    const env = this.buildConfiguredToolEnv(configuredTool, runtimePaths);
    const inputPayload = JSON.stringify(args ?? {});

    writeArtifact(path.join(runtimePaths.runDir, 'input.json'), args ?? {});

    this.logger.info('Configured assistant tool execution started', {
      queryId,
      sessionId,
      toolCallId,
      toolName: configuredTool.name,
      cwd: configuredTool.runner.cwd,
      command: configuredTool.runner.command,
      timeoutMs: configuredTool.runner.timeoutMs,
      maxStdoutBytes: configuredTool.runner.maxStdoutBytes,
      maxStderrBytes: configuredTool.runner.maxStderrBytes,
      callCount: toolCallsByName[configuredTool.name],
      maxCallsPerRun
    });

    try {
      const execution = await runConfiguredToolProcess({
        command: configuredTool.runner.command,
        cwd: configuredTool.runner.cwd,
        env,
        input: inputPayload,
        timeoutMs: configuredTool.runner.timeoutMs,
        maxStdoutBytes: configuredTool.runner.maxStdoutBytes,
        maxStderrBytes: configuredTool.runner.maxStderrBytes
      });

      writeArtifact(path.join(runtimePaths.runDir, 'stdout.json'), execution.stdout);
      writeArtifact(path.join(runtimePaths.runDir, 'stderr.txt'), execution.stderr);
      writeArtifact(path.join(runtimePaths.runDir, 'result.json'), execution.output);
      writeArtifact(path.join(runtimePaths.runDir, 'execution.json'), {
        exitCode: execution.exitCode,
        signal: execution.signal,
        stdoutBytes: execution.stdoutBytes,
        stderrBytes: execution.stderrBytes
      });

      return execution.output;
    } catch (error) {
      writeArtifact(path.join(runtimePaths.runDir, 'stdout.partial.txt'), error.stdout || '');
      writeArtifact(path.join(runtimePaths.runDir, 'stderr.partial.txt'), error.stderr || '');
      writeArtifact(path.join(runtimePaths.runDir, 'execution-error.json'), {
        code: error.code || null,
        message: error.message,
        stdoutBytes: error.stdoutBytes || 0,
        stderrBytes: error.stderrBytes || 0
      });
      throw error;
    }
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

    if (toolName === TOOL_NAMES.SEARCH_TOOLS) {
      return this.searchTools(args);
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

    const configuredTool = this.userToolsByName.get(toolName);
    if (configuredTool) {
      return this.executeConfiguredTool(configuredTool, args, toolContext);
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
      : mapStoredMessagesToOpenAiInput(messages);

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
          input = mapStoredMessagesToOpenAiInput(messages);
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
            toolResult = await this.executeTool(call.name, parsedArgs, {
              ...runContext,
              toolCallId: call.id || null
            });
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
            toolResult = await this.executeTool(call.name, parsedArgs, {
              ...runContext,
              toolCallId: call.id || null
            });
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
      let nextSession = session;
      if (session.runStatus === 'RUNNING' || session.runStatus === 'CANCELLING') {
        return { error: 'RUN_ACTIVE', session };
      }

      if (this.hasSessionQueryDrift(session, query)) {
        this.logger.info('Assistant session rolled over after query context changed', {
          queryId,
          previousSessionId: session.id,
          provider: this.providerName
        });
        const rolled = await this.rolloverSessionForQueryChange(query, session);
        nextSession = rolled.session;
      }

      const started = await this.assistantStore.markRunStarted(nextSession.id);
      if (!started) {
        const latestSession = await this.assistantStore.getSessionById(nextSession.id);
        if (latestSession && (latestSession.runStatus === 'RUNNING' || latestSession.runStatus === 'CANCELLING')) {
          return { error: 'RUN_ACTIVE', session: latestSession };
        }
        return { error: 'RUN_START_FAILED' };
      }

      await this.assistantStore.createMessage({
        id: uuidv4(),
        sessionId: nextSession.id,
        role: 'user',
        content: prompt,
        contentType: 'text'
      });

      setImmediate(() => {
        this.runAssistantLoop(nextSession.id, prompt, {
          queryId,
          sessionId: nextSession.id,
          usage: {
            readQueryCalls: 0,
            toolCallsByName: {}
          }
        }).catch(async (error) => {
          if (isMissingToolOutputError(error) || isToolLoopExceededError(error)) {
            await this.assistantStore.updateProviderConversationId(nextSession.id, null);
          }
          this.logger.error('Assistant run failed', {
            queryId,
            sessionId: nextSession.id,
            provider: this.providerName,
            error: error.message
          });
          await this.assistantStore.markRunFailed(nextSession.id, error.message);
        });
      });

      const current = await this.assistantStore.getSessionById(nextSession.id);
      return {
        accepted: true,
        sessionId: nextSession.id,
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
        runStatus: 'IDLE',
        model: this.model,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        }
      };
    }

    return {
      queryId,
      provider: this.providerName,
      sessionExists: true,
      sessionId: session.id,
      model: session.model || this.model,
      runStatus: session.runStatus,
      runStartedAt: session.runStartedAt,
      runFinishedAt: session.runFinishedAt,
      cancelRequestedAt: session.cancelRequestedAt,
      lastErrorMessage: session.lastErrorMessage,
      usage: {
        promptTokens: session.tokenUsagePrompt,
        completionTokens: session.tokenUsageCompletion,
        totalTokens: session.tokenUsageTotal
      }
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

    const messages = await this.assistantStore.listMessagesByQueryId(queryId);
    return {
      queryId,
      provider: this.providerName,
      sessionExists: true,
      sessionId: session.id,
      messages
    };
  }

  async compact(queryId, mode) {
    return this.lockManager.runWithLock(`assistant:${queryId}`, async () => {
      const query = await this.queryStore.getById(queryId);
      if (!query) {
        return { error: 'QUERY_NOT_FOUND' };
      }

      const compactMode = String(mode || 'empty').trim().toLowerCase();
      if (compactMode !== 'empty' && compactMode !== 'summarize') {
        return { error: 'INVALID_MODE' };
      }

      const activeSession = await this.assistantStore.getActiveSessionByQueryId(query.id);
      if (activeSession) {
        return { error: 'RUN_ACTIVE', session: activeSession };
      }

      const previousSession = await this.assistantStore.getSessionByQueryIdAndProvider(query.id, this.providerName);
      let summaryText = null;
      if (compactMode === 'summarize' && previousSession) {
        const messages = await this.assistantStore.listMessagesBySessionId(previousSession.id);
        summaryText = await this.summarizeConversation(messages, query);
      }

      const nextSession = await this.createSessionForQuery(query, {
        previousConversationSummary: summaryText,
        visibleSummaryMessage: summaryText
          ? `Conversation compacted from prior session. Summary:\n\n${summaryText}`
          : null
      });
      const current = await this.assistantStore.getSessionById(nextSession.id);

      return {
        queryId: query.id,
        provider: this.providerName,
        mode: compactMode,
        previousSessionId: previousSession?.id || null,
        sessionId: current.id,
        runStatus: current.runStatus,
        runStartedAt: current.runStartedAt,
        runFinishedAt: current.runFinishedAt,
        usage: {
          promptTokens: current.tokenUsagePrompt,
          completionTokens: current.tokenUsageCompletion,
          totalTokens: current.tokenUsageTotal
        },
        summaryIncluded: Boolean(summaryText)
      };
    });
  }
}

module.exports = {
  AssistantService
};
