function toIsoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function toDbDateOrNull(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function fromSessionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    queryId: row.query_id,
    mode: row.mode,
    provider: row.provider,
    providerConversationId: row.provider_conversation_id || row.openai_conversation_id || null,
    openaiConversationId: row.openai_conversation_id || null,
    model: row.model || null,
    status: row.status,
    runStatus: row.run_status || 'IDLE',
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastUsedAt: toIsoOrNull(row.last_used_at),
    runStartedAt: toIsoOrNull(row.run_started_at),
    runFinishedAt: toIsoOrNull(row.run_finished_at),
    cancelRequestedAt: toIsoOrNull(row.cancel_requested_at),
    seedQueryHash: row.seed_query_hash || null,
    seedDatabaseName: row.seed_database_name || null,
    tokenUsagePrompt: Number(row.token_usage_prompt || 0),
    tokenUsageCompletion: Number(row.token_usage_completion || 0),
    tokenUsageTotal: Number(row.token_usage_total || 0),
    lastErrorMessage: row.last_error_message || null
  };
}

function fromMessageRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    queryId: row.query_id || null,
    role: row.role,
    content: row.content,
    contentType: row.content_type,
    providerResponseId: row.provider_response_id || row.openai_response_id || null,
    openaiResponseId: row.openai_response_id || null,
    toolName: row.tool_name || null,
    toolCallId: row.tool_call_id || null,
    toolArgsJson: row.tool_args_json || null,
    toolResultJson: row.tool_result_json || null,
    tokenUsagePrompt: row.token_usage_prompt === null ? null : Number(row.token_usage_prompt),
    tokenUsageCompletion: row.token_usage_completion === null ? null : Number(row.token_usage_completion),
    tokenUsageTotal: row.token_usage_total === null ? null : Number(row.token_usage_total),
    createdAt: new Date(row.created_at).toISOString()
  };
}

class AssistantStore {
  constructor(pool) {
    this.pool = pool;
  }

  async getSessionById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM assistant_sessions WHERE id = ?', [id]);
    return fromSessionRow(rows[0]);
  }

  async getSessionByQueryId(queryId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM assistant_sessions WHERE query_id = ? ORDER BY created_at DESC LIMIT 1',
      [queryId]
    );
    return fromSessionRow(rows[0]);
  }

  async getSessionByQueryIdAndProvider(queryId, provider) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM assistant_sessions WHERE query_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1',
      [queryId, provider]
    );
    return fromSessionRow(rows[0]);
  }

  async getActiveSessionByQueryId(queryId) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM assistant_sessions
      WHERE query_id = ?
        AND run_status IN ('RUNNING', 'CANCELLING')
      ORDER BY created_at DESC
      LIMIT 1`,
      [queryId]
    );
    return fromSessionRow(rows[0]);
  }

  async createSession(record) {
    const now = new Date();
    await this.pool.execute(
      `INSERT INTO assistant_sessions (
        id, query_id, mode, provider, provider_conversation_id, openai_conversation_id, model, status, run_status,
        created_at, updated_at, last_used_at, run_started_at, run_finished_at, cancel_requested_at,
        seed_query_hash, seed_database_name,
        token_usage_prompt, token_usage_completion, token_usage_total, last_error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'IDLE', ?, ?, ?, NULL, NULL, NULL, ?, ?, 0, 0, 0, NULL)`,
      [
        record.id,
        record.queryId,
        record.mode || 'query_assistant',
        record.provider || 'openai',
        record.providerConversationId || record.openaiConversationId || null,
        record.openaiConversationId || null,
        record.model || null,
        now,
        now,
        now,
        record.seedQueryHash || null,
        record.seedDatabaseName || null
      ]
    );

    return this.getSessionById(record.id);
  }

  async markRunStarted(sessionId) {
    const now = new Date();
    const [result] = await this.pool.execute(
      `UPDATE assistant_sessions
      SET run_status = 'RUNNING',
          run_started_at = ?,
          run_finished_at = NULL,
          cancel_requested_at = NULL,
          last_error_message = NULL,
          updated_at = ?,
          last_used_at = ?
      WHERE id = ?
        AND run_status IN ('IDLE', 'FAILED')`,
      [now, now, now, sessionId]
    );
    return Number(result.affectedRows || 0) > 0;
  }

  async requestCancel(sessionId) {
    const now = new Date();
    const [result] = await this.pool.execute(
      `UPDATE assistant_sessions
      SET run_status = 'CANCELLING',
          cancel_requested_at = ?,
          updated_at = ?,
          last_used_at = ?
      WHERE id = ?
        AND run_status = 'RUNNING'`,
      [now, now, now, sessionId]
    );
    return Number(result.affectedRows || 0) > 0;
  }

  async markRunCancelled(sessionId) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE assistant_sessions
      SET run_status = 'IDLE',
          run_finished_at = ?,
          updated_at = ?,
          last_used_at = ?
      WHERE id = ?`,
      [now, now, now, sessionId]
    );
  }

  async markRunSucceeded(sessionId) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE assistant_sessions
      SET run_status = 'IDLE',
          run_finished_at = ?,
          updated_at = ?,
          last_used_at = ?
      WHERE id = ?`,
      [now, now, now, sessionId]
    );
  }

  async markRunFailed(sessionId, errorMessage) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE assistant_sessions
      SET run_status = 'FAILED',
          run_finished_at = ?,
          updated_at = ?,
          last_used_at = ?,
          last_error_message = ?
      WHERE id = ?`,
      [now, now, now, errorMessage || null, sessionId]
    );
  }

  async updateProviderConversationId(sessionId, responseId) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE assistant_sessions
      SET provider_conversation_id = ?,
          openai_conversation_id = CASE WHEN provider = 'openai' THEN ? ELSE openai_conversation_id END,
          updated_at = ?,
          last_used_at = ?
      WHERE id = ?`,
      [responseId || null, responseId || null, now, now, sessionId]
    );
  }

  async addTokenUsage(sessionId, usage = {}) {
    const prompt = Number(usage.prompt || 0);
    const completion = Number(usage.completion || 0);
    const total = Number(usage.total || 0);
    if (prompt === 0 && completion === 0 && total === 0) {
      return;
    }

    const now = new Date();
    await this.pool.execute(
      `UPDATE assistant_sessions
      SET token_usage_prompt = token_usage_prompt + ?,
          token_usage_completion = token_usage_completion + ?,
          token_usage_total = token_usage_total + ?,
          updated_at = ?,
          last_used_at = ?
      WHERE id = ?`,
      [prompt, completion, total, now, now, sessionId]
    );
  }

  async createMessage(record) {
    const now = new Date();
    await this.pool.execute(
      `INSERT INTO assistant_messages (
        id, session_id, role, content, content_type, provider_response_id, openai_response_id, tool_name, tool_call_id,
        tool_args_json, tool_result_json, token_usage_prompt, token_usage_completion, token_usage_total, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.sessionId,
        record.role,
        record.content,
        record.contentType || 'text',
        record.providerResponseId || record.openaiResponseId || null,
        record.openaiResponseId || null,
        record.toolName || null,
        record.toolCallId || null,
        record.toolArgsJson || null,
        record.toolResultJson || null,
        record.tokenUsagePrompt ?? null,
        record.tokenUsageCompletion ?? null,
        record.tokenUsageTotal ?? null,
        now
      ]
    );
  }

  async listMessagesBySessionId(sessionId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC',
      [sessionId]
    );
    return rows.map(fromMessageRow);
  }

  async listMessagesByQueryId(queryId) {
    const [rows] = await this.pool.execute(
      `SELECT assistant_messages.*, assistant_sessions.query_id
      FROM assistant_messages
      INNER JOIN assistant_sessions ON assistant_sessions.id = assistant_messages.session_id
      WHERE assistant_sessions.query_id = ?
      ORDER BY assistant_sessions.created_at ASC, assistant_messages.created_at ASC, assistant_messages.id ASC`,
      [queryId]
    );
    return rows.map(fromMessageRow);
  }

  async countMessages(sessionId) {
    const [rows] = await this.pool.execute(
      'SELECT COUNT(*) AS message_count FROM assistant_messages WHERE session_id = ?',
      [sessionId]
    );
    return Number(rows[0]?.message_count || 0);
  }
}

module.exports = {
  AssistantStore
};
