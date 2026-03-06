const { v4: uuidv4 } = require('uuid');
const { toAnthropicTools } = require('../tools');

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

function extractTextBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean);
}

function extractToolCalls(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((item) => item?.type === 'tool_use' && typeof item.name === 'string')
    .map((item) => {
      const input = item.input && typeof item.input === 'object' ? item.input : {};
      const serialized = JSON.stringify(input);
      return {
        id: item.id || uuidv4(),
        name: item.name,
        argumentsRaw: serialized,
        argumentsJson: parseJsonArgs(serialized)
      };
    });
}

class AnthropicProvider {
  constructor({ apiKey, model, baseURL, version, maxTokens }) {
    this.name = 'anthropic';
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-4-5';
    this.baseURL = (baseURL || 'https://api.anthropic.com').replace(/\/$/, '');
    this.version = version || '2023-06-01';
    this.maxTokens = Number(maxTokens || 2048);
  }

  ensureConfigured() {
    if (!this.apiKey) {
      const error = new Error('Assistant API key is not configured');
      error.code = 'ASSISTANT_NOT_CONFIGURED';
      error.provider = this.name;
      throw error;
    }
  }

  async send({ messages, system, tools }) {
    const response = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.version,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(system ? { system } : {}),
        messages,
        tools: toAnthropicTools(tools)
      })
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMessage = json?.error?.message || `Anthropic request failed with HTTP ${response.status}`;
      const error = new Error(errMessage);
      error.code = 'PROVIDER_REQUEST_FAILED';
      error.provider = this.name;
      throw error;
    }

    const content = Array.isArray(json.content) ? json.content : [];
    const assistantText = extractTextBlocks(content).join('\n').trim();
    const toolCalls = extractToolCalls(content);
    const usage = json.usage || {};

    return {
      provider: this.name,
      providerConversationId: null,
      providerResponseId: json.id || null,
      assistantText,
      toolCalls,
      usage: {
        prompt: usage.input_tokens || 0,
        completion: usage.output_tokens || 0,
        total: (usage.input_tokens || 0) + (usage.output_tokens || 0)
      },
      assistantContentBlocks: content
    };
  }
}

module.exports = {
  AnthropicProvider
};
