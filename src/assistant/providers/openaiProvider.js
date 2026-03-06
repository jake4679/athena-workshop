const { v4: uuidv4 } = require('uuid');
const { toOpenAiTools } = require('../tools');

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
      argumentsRaw: typeof item.arguments === 'string' ? item.arguments : '{}',
      argumentsJson: parseJsonArgs(typeof item.arguments === 'string' ? item.arguments : '{}')
    }));
}

class OpenAIProvider {
  constructor({ apiKey, model, baseURL }) {
    this.name = 'openai';
    this.apiKey = apiKey;
    this.model = model || 'gpt-5';
    this.baseURL = (baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  ensureConfigured() {
    if (!this.apiKey) {
      const error = new Error('Assistant API key is not configured');
      error.code = 'ASSISTANT_NOT_CONFIGURED';
      error.provider = this.name;
      throw error;
    }
  }

  async send({ input, previousResponseId, tools }) {
    const response = await fetch(`${this.baseURL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input,
        tools: toOpenAiTools(tools),
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {})
      })
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMessage = json?.error?.message || `OpenAI request failed with HTTP ${response.status}`;
      const error = new Error(errMessage);
      error.code = 'PROVIDER_REQUEST_FAILED';
      error.provider = this.name;
      throw error;
    }

    const usage = json.usage || {};
    return {
      provider: this.name,
      providerConversationId: json.id || previousResponseId || null,
      providerResponseId: json.id || null,
      assistantText: extractAssistantText(json),
      toolCalls: extractFunctionCalls(json),
      usage: {
        prompt: usage.input_tokens || 0,
        completion: usage.output_tokens || 0,
        total: usage.total_tokens || 0
      }
    };
  }
}

module.exports = {
  OpenAIProvider
};
