function toIsoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function toDbDateOrNull(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function fromRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    queryText: row.query_text,
    athenaQueryExecutionId: row.athena_query_execution_id,
    status: row.status,
    submittedAt: new Date(row.submitted_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: toIsoOrNull(row.completed_at),
    cancelledAt: toIsoOrNull(row.cancelled_at),
    resultPath: row.result_path,
    resultReceivedAt: toIsoOrNull(row.result_received_at),
    errorMessage: row.error_message
  };
}

class QueryStore {
  constructor(pool) {
    this.pool = pool;
  }

  async create(record) {
    const now = new Date();
    await this.pool.execute(
      `INSERT INTO queries (
        id, query_text, athena_query_execution_id, status, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.queryText,
        record.athenaQueryExecutionId,
        record.status,
        now,
        now
      ]
    );

    return this.getById(record.id);
  }

  async getById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM queries WHERE id = ?', [id]);
    return fromRow(rows[0]);
  }

  async listRunning() {
    const [rows] = await this.pool.execute('SELECT * FROM queries WHERE status = ?', ['RUNNING']);
    return rows.map(fromRow);
  }

  async updateStatus(id, status, extra = {}) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE queries SET
        status = ?,
        updated_at = ?,
        completed_at = COALESCE(?, completed_at),
        cancelled_at = COALESCE(?, cancelled_at),
        result_path = COALESCE(?, result_path),
        result_received_at = COALESCE(?, result_received_at),
        error_message = COALESCE(?, error_message)
      WHERE id = ?`,
      [
        status,
        now,
        toDbDateOrNull(extra.completedAt),
        toDbDateOrNull(extra.cancelledAt),
        extra.resultPath || null,
        toDbDateOrNull(extra.resultReceivedAt),
        extra.errorMessage || null,
        id
      ]
    );

    return this.getById(id);
  }

  async resetForRefresh(id, newAthenaQueryExecutionId) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE queries SET
        athena_query_execution_id = ?,
        status = 'RUNNING',
        updated_at = ?,
        completed_at = NULL,
        cancelled_at = NULL,
        result_path = NULL,
        result_received_at = NULL,
        error_message = NULL
      WHERE id = ?`,
      [newAthenaQueryExecutionId, now, id]
    );
    return this.getById(id);
  }
}

module.exports = {
  QueryStore
};
