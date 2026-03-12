const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOL_NAMES, assistantToolDefinitions, toOpenAiTools } = require('../src/assistant/tools');

test('toOpenAiTools converts optional object properties into nullable required fields for strict schemas', async () => {
  const searchTools = toOpenAiTools(assistantToolDefinitions).find((tool) => tool.name === TOOL_NAMES.SEARCH_TOOLS);

  assert.ok(searchTools);
  assert.deepEqual(searchTools.parameters.required, ['query', 'includeSchema', 'limit']);
  assert.deepEqual(searchTools.parameters.properties.query.type, ['string', 'null']);
  assert.deepEqual(searchTools.parameters.properties.includeSchema.type, ['boolean', 'null']);
  assert.deepEqual(searchTools.parameters.properties.limit.type, ['integer', 'null']);
});

test('toOpenAiTools preserves already-required fields and nullable types', async () => {
  const customTools = toOpenAiTools([
    {
      name: 'custom_tool',
      description: 'Custom tool',
      inputSchema: {
        type: 'object',
        properties: {
          requiredValue: {
            type: 'string'
          },
          optionalValue: {
            type: ['integer', 'null']
          }
        },
        required: ['requiredValue'],
        additionalProperties: false
      }
    }
  ]);

  assert.equal(customTools.length, 1);
  assert.deepEqual(customTools[0].parameters.required, ['requiredValue', 'optionalValue']);
  assert.deepEqual(customTools[0].parameters.properties.requiredValue.type, 'string');
  assert.deepEqual(customTools[0].parameters.properties.optionalValue.type, ['integer', 'null']);
});
