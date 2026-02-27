const mysql = require('mysql2/promise');

async function createPool(mysqlConfig) {
  return mysql.createPool({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
    waitForConnections: true,
    connectionLimit: mysqlConfig.connectionLimit || 10,
    queueLimit: 0
  });
}

async function initSchema(pool, options = {}) {
  const defaultAthenaDatabase = options.defaultAthenaDatabase || null;

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS queries (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      database_name VARCHAR(255) NULL,
      query_text TEXT NOT NULL,
      athena_query_execution_id VARCHAR(128) NOT NULL,
      status VARCHAR(32) NOT NULL,
      submitted_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      completed_at DATETIME NULL,
      cancelled_at DATETIME NULL,
      result_path TEXT NULL,
      result_received_at DATETIME NULL,
      error_message TEXT NULL
    )
  `);

  const [columnRows] = await pool.execute(
    `
      SELECT COUNT(*) AS column_count
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'queries'
        AND column_name = 'name'
    `
  );

  const hasNameColumn = Number(columnRows[0]?.column_count || 0) > 0;
  if (!hasNameColumn) {
    await pool.execute(`
      ALTER TABLE queries
      ADD COLUMN name VARCHAR(255) NOT NULL DEFAULT ''
    `);
  }

  await pool.execute(`
    UPDATE queries
    SET name = id
    WHERE name IS NULL OR name = ''
  `);

  const [databaseColumnRows] = await pool.execute(
    `
      SELECT COUNT(*) AS column_count
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'queries'
        AND column_name = 'database_name'
    `
  );

  const hasDatabaseColumn = Number(databaseColumnRows[0]?.column_count || 0) > 0;
  if (!hasDatabaseColumn) {
    await pool.execute(`
      ALTER TABLE queries
      ADD COLUMN database_name VARCHAR(255) NULL
    `);
  }

  if (defaultAthenaDatabase) {
    await pool.execute(
      `
        UPDATE queries
        SET database_name = ?
        WHERE database_name IS NULL OR database_name = ''
      `,
      [defaultAthenaDatabase]
    );
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS assistant_sessions (
      id VARCHAR(36) PRIMARY KEY,
      query_id VARCHAR(36) NOT NULL,
      mode VARCHAR(32) NOT NULL,
      provider VARCHAR(32) NOT NULL DEFAULT 'openai',
      openai_conversation_id VARCHAR(255) NULL,
      model VARCHAR(64) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      last_used_at DATETIME NULL,
      token_usage_prompt BIGINT NOT NULL DEFAULT 0,
      token_usage_completion BIGINT NOT NULL DEFAULT 0,
      token_usage_total BIGINT NOT NULL DEFAULT 0,
      last_error_message TEXT NULL,
      CONSTRAINT fk_assistant_sessions_query
        FOREIGN KEY (query_id) REFERENCES queries(id)
        ON DELETE CASCADE,
      INDEX idx_assistant_sessions_query_id (query_id),
      INDEX idx_assistant_sessions_status (status),
      INDEX idx_assistant_sessions_openai_conv (openai_conversation_id),
      INDEX idx_assistant_sessions_last_used_at (last_used_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id VARCHAR(36) PRIMARY KEY,
      session_id VARCHAR(36) NOT NULL,
      role VARCHAR(16) NOT NULL,
      content LONGTEXT NOT NULL,
      content_type VARCHAR(32) NOT NULL DEFAULT 'text',
      openai_response_id VARCHAR(255) NULL,
      tool_name VARCHAR(128) NULL,
      tool_call_id VARCHAR(128) NULL,
      tool_args_json LONGTEXT NULL,
      tool_result_json LONGTEXT NULL,
      token_usage_prompt INT NULL,
      token_usage_completion INT NULL,
      token_usage_total INT NULL,
      created_at DATETIME NOT NULL,
      CONSTRAINT fk_assistant_messages_session
        FOREIGN KEY (session_id) REFERENCES assistant_sessions(id)
        ON DELETE CASCADE,
      INDEX idx_assistant_messages_session_created (session_id, created_at),
      INDEX idx_assistant_messages_role (role),
      INDEX idx_assistant_messages_tool_call (tool_call_id)
    )
  `);
}

module.exports = {
  createPool,
  initSchema
};
