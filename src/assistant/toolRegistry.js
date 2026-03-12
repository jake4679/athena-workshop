const path = require('path');
const { assistantToolDefinitions } = require('./tools');

const DEFAULT_TOOL_TIMEOUT_MS = 10000;
const DEFAULT_MAX_CALLS_PER_RUN = 3;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveBaseDir(config = {}) {
  if (typeof config.__configPath === 'string' && config.__configPath.trim() !== '') {
    return path.dirname(config.__configPath);
  }

  return process.cwd();
}

function normalizePositiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function normalizeOptionalPositiveInteger(value, label) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return normalizePositiveInteger(value, label);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    )
  );
}

function normalizeEnvMap(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    if (!normalizedKey) {
      throw new Error(`${label} contains an invalid environment variable name`);
    }

    if (raw === undefined || raw === null) {
      continue;
    }

    output[normalizedKey] = String(raw);
  }

  return output;
}

function normalizeCredentialSets(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error('tools.credentialSets must be an object');
  }

  const output = {};
  for (const [name, envMap] of Object.entries(value)) {
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (!normalizedName) {
      throw new Error('tools.credentialSets contains an invalid credential set name');
    }
    output[normalizedName] = normalizeEnvMap(envMap, `tools.credentialSets.${normalizedName}`);
  }

  return output;
}

function normalizeInputSchema(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return deepClone(value);
}

function normalizeUserTool(rawTool, index, context) {
  if (!isPlainObject(rawTool)) {
    throw new Error(`tools.userSupplied[${index}] must be an object`);
  }

  const name = typeof rawTool.name === 'string' ? rawTool.name.trim() : '';
  if (!name) {
    throw new Error(`tools.userSupplied[${index}].name is required`);
  }

  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`tools.userSupplied[${index}].name must match ^[A-Za-z][A-Za-z0-9_-]*$`);
  }

  if (context.seenNames.has(name)) {
    throw new Error(`Duplicate assistant tool name: ${name}`);
  }

  const description = typeof rawTool.description === 'string' ? rawTool.description.trim() : '';
  if (!description) {
    throw new Error(`tools.userSupplied[${index}].description is required`);
  }

  const runner = isPlainObject(rawTool.runner) ? rawTool.runner : null;
  if (!runner) {
    throw new Error(`tools.userSupplied[${index}].runner is required`);
  }

  const runnerType = typeof runner.type === 'string' ? runner.type.trim() : 'exec';
  if (runnerType !== 'exec') {
    throw new Error(`tools.userSupplied[${index}].runner.type must be "exec"`);
  }

  const command = Array.isArray(runner.command)
    ? runner.command.map((part) => (typeof part === 'string' ? part.trim() : ''))
    : [];
  if (command.length === 0 || command.some((part) => !part)) {
    throw new Error(`tools.userSupplied[${index}].runner.command must be a non-empty string array`);
  }

  const credentialSetName =
    typeof runner.credentialSet === 'string' && runner.credentialSet.trim() !== ''
      ? runner.credentialSet.trim()
      : null;
  if (credentialSetName && !context.credentialSets[credentialSetName]) {
    throw new Error(
      `tools.userSupplied[${index}].runner.credentialSet references unknown credential set: ${credentialSetName}`
    );
  }

  const cwd =
    typeof runner.cwd === 'string' && runner.cwd.trim() !== ''
      ? path.resolve(context.baseDir, runner.cwd.trim())
      : context.baseDir;

  const timeoutMs =
    runner.timeoutMs !== undefined
      ? normalizePositiveInteger(runner.timeoutMs, `tools.userSupplied[${index}].runner.timeoutMs`)
      : context.defaults.defaultTimeoutMs;

  const maxStdoutBytes =
    runner.maxStdoutBytes !== undefined
      ? normalizeOptionalPositiveInteger(
          runner.maxStdoutBytes,
          `tools.userSupplied[${index}].runner.maxStdoutBytes`
        )
      : context.defaults.defaultMaxStdoutBytes;

  const maxStderrBytes =
    runner.maxStderrBytes !== undefined
      ? normalizeOptionalPositiveInteger(
          runner.maxStderrBytes,
          `tools.userSupplied[${index}].runner.maxStderrBytes`
        )
      : context.defaults.defaultMaxStderrBytes;

  const maxCallsPerRun =
    runner.maxCallsPerRun !== undefined
      ? normalizePositiveInteger(
          runner.maxCallsPerRun,
          `tools.userSupplied[${index}].runner.maxCallsPerRun`
        )
      : context.defaults.defaultMaxCallsPerRun;

  const normalized = {
    name,
    description,
    tags: normalizeStringArray(rawTool.tags),
    inputSchema: normalizeInputSchema(rawTool.inputSchema, `tools.userSupplied[${index}].inputSchema`),
    runner: {
      type: 'exec',
      command,
      cwd,
      credentialSet: credentialSetName,
      env: normalizeEnvMap(runner.env, `tools.userSupplied[${index}].runner.env`),
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      maxCallsPerRun
    },
    credentialEnv: credentialSetName ? context.credentialSets[credentialSetName] : {}
  };

  context.seenNames.add(name);
  return normalized;
}

function buildAssistantToolRegistry(config = {}) {
  const toolsConfig = isPlainObject(config.tools) ? config.tools : {};
  const baseDir = resolveBaseDir(config);
  const defaults = {
    defaultTimeoutMs:
      toolsConfig.defaultTimeoutMs !== undefined
        ? normalizePositiveInteger(toolsConfig.defaultTimeoutMs, 'tools.defaultTimeoutMs')
        : DEFAULT_TOOL_TIMEOUT_MS,
    defaultMaxCallsPerRun:
      toolsConfig.defaultMaxCallsPerRun !== undefined
        ? normalizePositiveInteger(toolsConfig.defaultMaxCallsPerRun, 'tools.defaultMaxCallsPerRun')
        : DEFAULT_MAX_CALLS_PER_RUN,
    defaultMaxStdoutBytes: normalizeOptionalPositiveInteger(
      toolsConfig.defaultMaxStdoutBytes,
      'tools.defaultMaxStdoutBytes'
    ),
    defaultMaxStderrBytes: normalizeOptionalPositiveInteger(
      toolsConfig.defaultMaxStderrBytes,
      'tools.defaultMaxStderrBytes'
    )
  };

  const credentialSets = normalizeCredentialSets(toolsConfig.credentialSets);
  const seenNames = new Set(assistantToolDefinitions.map((tool) => tool.name));
  const rawUserTools = Array.isArray(toolsConfig.userSupplied) ? toolsConfig.userSupplied : [];

  const userTools = rawUserTools.map((tool, index) =>
    normalizeUserTool(tool, index, {
      baseDir,
      defaults,
      credentialSets,
      seenNames
    })
  );

  const toolDefinitions = assistantToolDefinitions.concat(
    userTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      tags: tool.tags,
      inputSchema: deepClone(tool.inputSchema)
    }))
  );

  const userToolsByName = new Map(userTools.map((tool) => [tool.name, tool]));
  const searchableTools = toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    tags: normalizeStringArray(tool.tags),
    inputSchema: deepClone(tool.inputSchema)
  }));

  return {
    defaults,
    credentialSets,
    searchableTools,
    toolDefinitions,
    userToolsByName
  };
}

module.exports = {
  buildAssistantToolRegistry
};
