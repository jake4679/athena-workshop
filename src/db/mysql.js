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
}

module.exports = {
  createPool,
  initSchema
};
