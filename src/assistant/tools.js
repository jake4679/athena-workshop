const TOOL_NAMES = {
  LIST_DATABASES: 'list_databases',
  LIST_TABLES: 'list_tables',
  GET_TABLE_SCHEMA: 'get_table_schema',
  VALIDATE_QUERY: 'validate_query',
  GET_QUERY: 'get_query',
  RUN_READ_QUERY: 'run_read_query',
  SEARCH_TOOLS: 'search_tools'
};

const assistantToolDefinitions = [
  {
    name: TOOL_NAMES.LIST_DATABASES,
    description: 'List Athena databases available to the current user context.',
    tags: ['athena', 'database', 'schema'],
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
    tags: ['athena', 'database', 'table', 'schema'],
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
    tags: ['athena', 'table', 'schema', 'columns'],
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
    tags: ['athena', 'sql', 'validate'],
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
    tags: ['query', 'metadata'],
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
    tags: ['athena', 'sql', 'query', 'read'],
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
  },
  {
    name: TOOL_NAMES.SEARCH_TOOLS,
    description: 'Search the available tools by name, description, or tags and optionally include input schemas.',
    tags: ['tools', 'discovery'],
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional free-text search query.'
        },
        includeSchema: {
          type: 'boolean',
          description: 'Whether to include the tool input schema in the response.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of tools to return.',
          minimum: 1,
          maximum: 100
        }
      },
      required: [],
      additionalProperties: false
    }
  }
];

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasNullVariant(schemas = []) {
  return schemas.some((schema) => {
    if (!schema || typeof schema !== 'object') {
      return false;
    }

    if (schema.type === 'null') {
      return true;
    }

    if (Array.isArray(schema.type) && schema.type.includes('null')) {
      return true;
    }

    return false;
  });
}

function makeSchemaNullable(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  if (typeof schema.type === 'string') {
    if (schema.type !== 'null') {
      schema.type = [schema.type, 'null'];
    }
    return schema;
  }

  if (Array.isArray(schema.type)) {
    if (!schema.type.includes('null')) {
      schema.type = schema.type.concat('null');
    }
    return schema;
  }

  if (Array.isArray(schema.anyOf)) {
    if (!hasNullVariant(schema.anyOf)) {
      schema.anyOf = schema.anyOf.concat({ type: 'null' });
    }
    return schema;
  }

  if (Array.isArray(schema.oneOf)) {
    if (!hasNullVariant(schema.oneOf)) {
      schema.oneOf = schema.oneOf.concat({ type: 'null' });
    }
    return schema;
  }

  return {
    anyOf: [schema, { type: 'null' }]
  };
}

function normalizeOpenAiStrictSchemaNode(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const propertyNames = Object.keys(schema.properties);
    const originalRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    const normalizedProperties = {};

    propertyNames.forEach((propertyName) => {
      const normalizedProperty = normalizeOpenAiStrictSchemaNode(schema.properties[propertyName]);
      normalizedProperties[propertyName] = originalRequired.has(propertyName)
        ? normalizedProperty
        : makeSchemaNullable(normalizedProperty);
    });

    schema.properties = normalizedProperties;
    schema.required = propertyNames;
  }

  if (schema.items) {
    if (Array.isArray(schema.items)) {
      schema.items = schema.items.map((item) => normalizeOpenAiStrictSchemaNode(item));
    } else {
      schema.items = normalizeOpenAiStrictSchemaNode(schema.items);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf = schema.anyOf.map((item) => normalizeOpenAiStrictSchemaNode(item));
  }

  if (Array.isArray(schema.oneOf)) {
    schema.oneOf = schema.oneOf.map((item) => normalizeOpenAiStrictSchemaNode(item));
  }

  if (Array.isArray(schema.allOf)) {
    schema.allOf = schema.allOf.map((item) => normalizeOpenAiStrictSchemaNode(item));
  }

  return schema;
}

function toOpenAiStrictSchema(inputSchema) {
  return normalizeOpenAiStrictSchemaNode(deepClone(inputSchema));
}

function toOpenAiTools(definitions = assistantToolDefinitions) {
  return definitions.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    strict: true,
    parameters: toOpenAiStrictSchema(tool.inputSchema)
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
