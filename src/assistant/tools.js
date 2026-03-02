const TOOL_NAMES = {
  LIST_DATABASES: 'list_databases',
  LIST_TABLES: 'list_tables',
  GET_TABLE_SCHEMA: 'get_table_schema',
  VALIDATE_QUERY: 'validate_query',
  GET_QUERY: 'get_query',
  RUN_READ_QUERY: 'run_read_query'
};

const assistantToolDefinitions = [
  {
    name: TOOL_NAMES.LIST_DATABASES,
    description: 'List Athena databases available to the current user context.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: TOOL_NAMES.LIST_TABLES,
    description: 'List table identifiers for a specific Athena database.',
    inputSchema: {
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
  },
  {
    name: TOOL_NAMES.GET_TABLE_SCHEMA,
    description: 'Return column names and data types for one Athena table.',
    inputSchema: {
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
  },
  {
    name: TOOL_NAMES.VALIDATE_QUERY,
    description:
      'Validate SQL syntax for a given Athena database context and return diagnostics-ready markers.',
    inputSchema: {
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
  },
  {
    name: TOOL_NAMES.GET_QUERY,
    description: 'Get stored query metadata and SQL text by query identifier.',
    inputSchema: {
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
  },
  {
    name: TOOL_NAMES.RUN_READ_QUERY,
    description:
      'Execute a read-only Athena query sample. Safeguards: SELECT-style queries only, hard row cap of 500 via enforced outer LIMIT, max 5 calls per assistant run, and backend execution timeout. Use maxColumns to limit returned columns.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'SELECT-style SQL to run as read-only sample.'
        },
        database: {
          type: ['string', 'null'],
          description: 'Athena database identifier override. Set null to use default/current database.'
        },
        maxColumns: {
          type: ['integer', 'null'],
          description: 'Cap for returned column count (1-50). Set null to use backend default.',
          minimum: 1,
          maximum: 50
        }
      },
      required: ['query', 'database', 'maxColumns'],
      additionalProperties: false
    }
  }
];

function toOpenAiTools(definitions = assistantToolDefinitions) {
  return definitions.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    strict: true,
    parameters: tool.inputSchema
  }));
}

function toAnthropicTools(definitions = assistantToolDefinitions) {
  return definitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

module.exports = {
  TOOL_NAMES,
  assistantToolDefinitions,
  toOpenAiTools,
  toAnthropicTools
};
