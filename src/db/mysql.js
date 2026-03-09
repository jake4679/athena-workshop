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
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NULL,
      first_name VARCHAR(255) NULL,
      last_name VARCHAR(255) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY uq_users_email (email),
      INDEX idx_users_status (status)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_identities (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      provider VARCHAR(64) NOT NULL,
      provider_subject VARCHAR(255) NOT NULL,
      provider_email VARCHAR(255) NULL,
      provider_first_name VARCHAR(255) NULL,
      provider_last_name VARCHAR(255) NULL,
      provider_profile_json LONGTEXT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      CONSTRAINT fk_user_identities_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE,
      UNIQUE KEY uq_user_identities_provider_subject (provider, provider_subject),
      INDEX idx_user_identities_user_id (user_id)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY uq_roles_name (name)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id VARCHAR(36) NOT NULL,
      role_id INT NOT NULL,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (user_id, role_id),
      CONSTRAINT fk_user_roles_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_user_roles_role
        FOREIGN KEY (role_id) REFERENCES roles(id)
        ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_id VARCHAR(128) NOT NULL PRIMARY KEY,
      expires BIGINT UNSIGNED NOT NULL,
      data MEDIUMTEXT NULL,
      INDEX idx_user_sessions_expires (expires)
    )
  `);

  const now = new Date();
  for (const roleName of ['admin', 'querier', 'viewer']) {
    await pool.execute(
      `
        INSERT INTO roles (name, created_at, updated_at)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)
      `,
      [roleName, now, now]
    );
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS queries (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_by_user_id VARCHAR(36) NULL,
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
      error_message TEXT NULL,
      CONSTRAINT fk_queries_created_by_user
        FOREIGN KEY (created_by_user_id) REFERENCES users(id)
        ON DELETE SET NULL,
      INDEX idx_queries_created_by_user_id (created_by_user_id)
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

  const [createdByUserColumnRows] = await pool.execute(
    `
      SELECT COUNT(*) AS column_count
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'queries'
        AND column_name = 'created_by_user_id'
    `
  );

  const hasCreatedByUserColumn = Number(createdByUserColumnRows[0]?.column_count || 0) > 0;
  if (!hasCreatedByUserColumn) {
    await pool.execute(`
      ALTER TABLE queries
      ADD COLUMN created_by_user_id VARCHAR(36) NULL
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
      provider_conversation_id VARCHAR(255) NULL,
      openai_conversation_id VARCHAR(255) NULL,
      model VARCHAR(64) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
      run_status VARCHAR(32) NOT NULL DEFAULT 'IDLE',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      last_used_at DATETIME NULL,
      run_started_at DATETIME NULL,
      run_finished_at DATETIME NULL,
      cancel_requested_at DATETIME NULL,
      token_usage_prompt BIGINT NOT NULL DEFAULT 0,
      token_usage_completion BIGINT NOT NULL DEFAULT 0,
      token_usage_total BIGINT NOT NULL DEFAULT 0,
      last_error_message TEXT NULL,
      CONSTRAINT fk_assistant_sessions_query
        FOREIGN KEY (query_id) REFERENCES queries(id)
        ON DELETE CASCADE,
      INDEX idx_assistant_sessions_query_id (query_id),
      INDEX idx_assistant_sessions_status (status),
      INDEX idx_assistant_sessions_run_status (run_status),
      INDEX idx_assistant_sessions_provider_conv (provider_conversation_id),
      INDEX idx_assistant_sessions_openai_conv (openai_conversation_id),
      INDEX idx_assistant_sessions_last_used_at (last_used_at)
    )
  `);

  const sessionColumnsToEnsure = [
    {
      name: 'provider_conversation_id',
      ddl: 'ALTER TABLE assistant_sessions ADD COLUMN provider_conversation_id VARCHAR(255) NULL'
    },
    { name: 'run_status', ddl: "ALTER TABLE assistant_sessions ADD COLUMN run_status VARCHAR(32) NOT NULL DEFAULT 'IDLE'" },
    { name: 'run_started_at', ddl: 'ALTER TABLE assistant_sessions ADD COLUMN run_started_at DATETIME NULL' },
    { name: 'run_finished_at', ddl: 'ALTER TABLE assistant_sessions ADD COLUMN run_finished_at DATETIME NULL' },
    { name: 'cancel_requested_at', ddl: 'ALTER TABLE assistant_sessions ADD COLUMN cancel_requested_at DATETIME NULL' }
  ];

  for (const column of sessionColumnsToEnsure) {
    const [rows] = await pool.execute(
      `
        SELECT COUNT(*) AS column_count
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'assistant_sessions'
          AND column_name = ?
      `,
      [column.name]
    );

    const hasColumn = Number(rows[0]?.column_count || 0) > 0;
    if (!hasColumn) {
      await pool.execute(column.ddl);
    }
  }

  await pool.execute(`
    UPDATE assistant_sessions
    SET run_status = 'IDLE'
    WHERE run_status IS NULL OR run_status = ''
  `);

  await pool.execute(`
    UPDATE assistant_sessions
    SET provider_conversation_id = openai_conversation_id
    WHERE (provider_conversation_id IS NULL OR provider_conversation_id = '')
      AND openai_conversation_id IS NOT NULL
      AND openai_conversation_id <> ''
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id VARCHAR(36) PRIMARY KEY,
      session_id VARCHAR(36) NOT NULL,
      role VARCHAR(16) NOT NULL,
      content LONGTEXT NOT NULL,
      content_type VARCHAR(32) NOT NULL DEFAULT 'text',
      provider_response_id VARCHAR(255) NULL,
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

  const messageColumnsToEnsure = [
    {
      name: 'provider_response_id',
      ddl: 'ALTER TABLE assistant_messages ADD COLUMN provider_response_id VARCHAR(255) NULL'
    }
  ];

  for (const column of messageColumnsToEnsure) {
    const [rows] = await pool.execute(
      `
        SELECT COUNT(*) AS column_count
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'assistant_messages'
          AND column_name = ?
      `,
      [column.name]
    );

    const hasColumn = Number(rows[0]?.column_count || 0) > 0;
    if (!hasColumn) {
      await pool.execute(column.ddl);
    }
  }

  await pool.execute(`
    UPDATE assistant_messages
    SET provider_response_id = openai_response_id
    WHERE (provider_response_id IS NULL OR provider_response_id = '')
      AND openai_response_id IS NOT NULL
      AND openai_response_id <> ''
  `);
}

module.exports = {
  createPool,
  initSchema
};
