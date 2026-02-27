const TOOL_NAMES = {
  LIST_DATABASES: 'list_databases',
  LIST_TABLES: 'list_tables',
  GET_TABLE_SCHEMA: 'get_table_schema',
  VALIDATE_QUERY: 'validate_query',
  GET_QUERY: 'get_query'
};

const listDatabasesTool = {
  type: 'function',
  name: TOOL_NAMES.LIST_DATABASES,
  description: 'List Athena databases available to the current user context.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  }
};

const listTablesTool = {
  type: 'function',
  name: TOOL_NAMES.LIST_TABLES,
  description: 'List table identifiers for a specific Athena database.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      database: {
        type: 'string',
        description: 'Athena database identifier.'
      }
    },
    required: ['database'],
    additionalProperties: false
  }
};

const getTableSchemaTool = {
  type: 'function',
  name: TOOL_NAMES.GET_TABLE_SCHEMA,
  description: 'Return column names and data types for one Athena table.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      database: {
        type: 'string',
        description: 'Athena database identifier.'
      },
      table: {
        type: 'string',
        description: 'Athena table identifier.'
      }
    },
    required: ['database', 'table'],
    additionalProperties: false
  }
};

const validateQueryTool = {
  type: 'function',
  name: TOOL_NAMES.VALIDATE_QUERY,
  description:
    'Validate SQL syntax for a given Athena database context and return diagnostics-ready markers.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      database: {
        type: 'string',
        description: 'Athena database identifier.'
      },
      query: {
        type: 'string',
        description: 'SQL text to validate.'
      }
    },
    required: ['database', 'query'],
    additionalProperties: false
  }
};

const getQueryTool = {
  type: 'function',
  name: TOOL_NAMES.GET_QUERY,
  description: 'Get stored query metadata and SQL text by query identifier.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      queryId: {
        type: 'string',
        description: 'Stored query identifier (UUID).'
      }
    },
    required: ['queryId'],
    additionalProperties: false
  }
};

const assistantTools = [
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  validateQueryTool,
  getQueryTool
];

module.exports = {
  TOOL_NAMES,
  assistantTools,
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  validateQueryTool,
  getQueryTool
};
