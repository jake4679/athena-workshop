const { TOOL_NAMES, assistantToolDefinitions, toOpenAiTools } = require('../assistant/tools');

const assistantTools = toOpenAiTools(assistantToolDefinitions);

const listDatabasesTool = assistantTools.find((tool) => tool.name === TOOL_NAMES.LIST_DATABASES);
const listTablesTool = assistantTools.find((tool) => tool.name === TOOL_NAMES.LIST_TABLES);
const getTableSchemaTool = assistantTools.find((tool) => tool.name === TOOL_NAMES.GET_TABLE_SCHEMA);
const validateQueryTool = assistantTools.find((tool) => tool.name === TOOL_NAMES.VALIDATE_QUERY);
const getQueryTool = assistantTools.find((tool) => tool.name === TOOL_NAMES.GET_QUERY);

module.exports = {
  TOOL_NAMES,
  assistantTools,
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  validateQueryTool,
  getQueryTool
};
