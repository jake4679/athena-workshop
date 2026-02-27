const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StopQueryExecutionCommand,
  ListTableMetadataCommand,
  ListDatabasesCommand,
  GetTableMetadataCommand
} = require('@aws-sdk/client-athena');

class AthenaService {
  constructor(config) {
    this.client = new AthenaClient({ region: config.aws.region });
    this.database = config.aws.database || null;
    this.catalog = config.aws.catalog || 'AwsDataCatalog';
    this.outputLocation = config.aws.outputLocation;
    this.workGroup = config.aws.workGroup;
    this.resultsDir = path.resolve(process.cwd(), config.server.resultsDir);

    fs.mkdirSync(this.resultsDir, { recursive: true });
  }

  async resolveDatabaseName(databaseName) {
    if (typeof databaseName === 'string' && databaseName.trim() !== '') {
      return databaseName.trim();
    }

    if (this.database) {
      return this.database;
    }

    const databases = await this.listDatabases();
    if (!Array.isArray(databases) || databases.length === 0) {
      throw new Error('No Athena databases available');
    }

    return databases[0];
  }

  async submitQuery(queryText, databaseName) {
    const resolvedDatabase = await this.resolveDatabaseName(databaseName);
    const cmd = new StartQueryExecutionCommand({
      QueryString: queryText,
      QueryExecutionContext: {
        Database: resolvedDatabase
      },
      ResultConfiguration: {
        OutputLocation: this.outputLocation
      },
      WorkGroup: this.workGroup
    });

    const res = await this.client.send(cmd);
    return {
      athenaQueryExecutionId: res.QueryExecutionId,
      databaseName: resolvedDatabase
    };
  }

  async getExecutionState(athenaQueryExecutionId) {
    const cmd = new GetQueryExecutionCommand({
      QueryExecutionId: athenaQueryExecutionId
    });
    const res = await this.client.send(cmd);

    const state = res.QueryExecution?.Status?.State || 'UNKNOWN';
    const reason = res.QueryExecution?.Status?.StateChangeReason || null;

    return { state, reason };
  }

  async cancelQuery(athenaQueryExecutionId) {
    const cmd = new StopQueryExecutionCommand({
      QueryExecutionId: athenaQueryExecutionId
    });
    await this.client.send(cmd);
  }

  async downloadResults(athenaQueryExecutionId, queryId) {
    const rows = [];
    let nextToken;
    let columns = [];

    do {
      const cmd = new GetQueryResultsCommand({
        QueryExecutionId: athenaQueryExecutionId,
        NextToken: nextToken,
        MaxResults: 1000
      });
      const res = await this.client.send(cmd);
      nextToken = res.NextToken;

      if (columns.length === 0) {
        columns = (res.ResultSet?.ResultSetMetadata?.ColumnInfo || []).map((c) => c.Name);
      }

      const pageRows = res.ResultSet?.Rows || [];
      const normalized = pageRows.map((row) => (row.Data || []).map((cell) => cell.VarCharValue ?? null));
      rows.push(...normalized);
    } while (nextToken);

    const payload = {
      queryId,
      athenaQueryExecutionId,
      fetchedAt: new Date().toISOString(),
      columns,
      rows
    };

    const filePath = path.join(this.resultsDir, `${queryId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload));

    return {
      filePath,
      fetchedAt: payload.fetchedAt
    };
  }

  async listDatabases() {
    const names = [];
    let nextToken;

    do {
      const cmd = new ListDatabasesCommand({
        CatalogName: this.catalog,
        NextToken: nextToken,
        MaxResults: 50
      });
      const res = await this.client.send(cmd);
      nextToken = res.NextToken;

      const pageNames = (res.DatabaseList || [])
        .map((db) => db.Name)
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim());

      names.push(...pageNames);
    } while (nextToken);

    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  }

  async listTableSchema(databaseName) {
    const resolvedDatabase = await this.resolveDatabaseName(databaseName);
    logger.info('Listing Athena table schema', {
      catalog: this.catalog,
      database: resolvedDatabase
    });

    const tables = [];
    let nextToken;
    let pageCount = 0;

    try {
      do {
        const cmd = new ListTableMetadataCommand({
          CatalogName: this.catalog,
          DatabaseName: resolvedDatabase,
          NextToken: nextToken,
          MaxResults: 50
        });
        const res = await this.client.send(cmd);
        nextToken = res.NextToken;
        pageCount += 1;

        const pageTables = (res.TableMetadataList || []).map((table) => ({
          name: table.Name,
          columns: (table.Columns || []).map((column) => ({
            name: column.Name,
            type: column.Type || 'unknown'
          }))
        }));

        tables.push(...pageTables);
      } while (nextToken);
    } catch (error) {
      logger.error('Athena schema listing failed', {
        catalog: this.catalog,
        database: resolvedDatabase,
        pageCount,
        error: error.message,
        errorName: error.name || null
      });
      throw error;
    }

    tables.sort((a, b) => a.name.localeCompare(b.name));
    logger.info('Athena schema listing completed', {
      catalog: this.catalog,
      database: resolvedDatabase,
      pageCount,
      tableCount: tables.length
    });

    return {
      catalog: this.catalog,
      database: resolvedDatabase,
      tables
    };
  }

  async listTables(databaseName) {
    const resolvedDatabase = await this.resolveDatabaseName(databaseName);
    logger.info('Listing Athena tables', {
      catalog: this.catalog,
      database: resolvedDatabase
    });

    const tableNames = [];
    let nextToken;
    let pageCount = 0;

    try {
      do {
        const cmd = new ListTableMetadataCommand({
          CatalogName: this.catalog,
          DatabaseName: resolvedDatabase,
          NextToken: nextToken,
          MaxResults: 50
        });
        const res = await this.client.send(cmd);
        nextToken = res.NextToken;
        pageCount += 1;

        const names = (res.TableMetadataList || [])
          .map((table) => table.Name)
          .filter((name) => typeof name === 'string' && name.trim() !== '')
          .map((name) => name.trim());

        tableNames.push(...names);
      } while (nextToken);
    } catch (error) {
      logger.error('Athena table listing failed', {
        catalog: this.catalog,
        database: resolvedDatabase,
        pageCount,
        error: error.message,
        errorName: error.name || null
      });
      throw error;
    }

    const tables = Array.from(new Set(tableNames)).sort((a, b) => a.localeCompare(b));
    logger.info('Athena table listing completed', {
      catalog: this.catalog,
      database: resolvedDatabase,
      pageCount,
      tableCount: tables.length
    });

    return {
      catalog: this.catalog,
      database: resolvedDatabase,
      tables
    };
  }

  async getTableSchema(databaseName, tableName) {
    const resolvedDatabase = await this.resolveDatabaseName(databaseName);
    const resolvedTable = String(tableName || '').trim();
    if (!resolvedTable) {
      throw new Error('table identifier is required');
    }

    logger.info('Fetching Athena table schema', {
      catalog: this.catalog,
      database: resolvedDatabase,
      table: resolvedTable
    });

    const cmd = new GetTableMetadataCommand({
      CatalogName: this.catalog,
      DatabaseName: resolvedDatabase,
      TableName: resolvedTable
    });
    const res = await this.client.send(cmd);
    const table = res.TableMetadata;
    if (!table || !table.Name) {
      const notFoundError = new Error('Table not found');
      notFoundError.code = 'TABLE_NOT_FOUND';
      throw notFoundError;
    }

    return {
      catalog: this.catalog,
      database: resolvedDatabase,
      table: table.Name,
      columns: (table.Columns || []).map((column) => ({
        name: column.Name,
        type: column.Type || 'unknown'
      }))
    };
  }

  async validateQuery(queryText, options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    const pollIntervalMs = options.pollIntervalMs || 750;
    const databaseName = await this.resolveDatabaseName(options.databaseName);
    const explainQuery = `EXPLAIN ${queryText}`;
    const submitted = await this.submitQuery(explainQuery, databaseName);
    const athenaQueryExecutionId = submitted.athenaQueryExecutionId;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const execution = await this.getExecutionState(athenaQueryExecutionId);
      if (execution.state === 'SUCCEEDED') {
        return {
          valid: true,
          athenaQueryExecutionId,
          databaseName
        };
      }

      if (execution.state === 'FAILED' || execution.state === 'CANCELLED') {
        return {
          valid: false,
          athenaQueryExecutionId,
          databaseName,
          error: execution.reason || `Validation ended in state: ${execution.state}`
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    try {
      await this.cancelQuery(athenaQueryExecutionId);
    } catch (_error) {
      // best effort only
    }

    return {
      valid: false,
      athenaQueryExecutionId,
      databaseName,
      error: 'Validation timed out'
    };
  }
}

module.exports = {
  AthenaService
};
