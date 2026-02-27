const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StopQueryExecutionCommand,
  ListTableMetadataCommand
} = require('@aws-sdk/client-athena');

class AthenaService {
  constructor(config) {
    this.client = new AthenaClient({ region: config.aws.region });
    this.database = config.aws.database;
    this.catalog = config.aws.catalog || 'AwsDataCatalog';
    this.outputLocation = config.aws.outputLocation;
    this.workGroup = config.aws.workGroup;
    this.resultsDir = path.resolve(process.cwd(), config.server.resultsDir);

    fs.mkdirSync(this.resultsDir, { recursive: true });
  }

  async submitQuery(queryText) {
    const cmd = new StartQueryExecutionCommand({
      QueryString: queryText,
      QueryExecutionContext: {
        Database: this.database
      },
      ResultConfiguration: {
        OutputLocation: this.outputLocation
      },
      WorkGroup: this.workGroup
    });

    const res = await this.client.send(cmd);
    return res.QueryExecutionId;
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

  async listTableSchema() {
    logger.info('Listing Athena table schema', {
      catalog: this.catalog,
      database: this.database
    });

    const tables = [];
    let nextToken;
    let pageCount = 0;

    try {
      do {
        const cmd = new ListTableMetadataCommand({
          CatalogName: this.catalog,
          DatabaseName: this.database,
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
        database: this.database,
        pageCount,
        error: error.message,
        errorName: error.name || null
      });
      throw error;
    }

    tables.sort((a, b) => a.name.localeCompare(b.name));
    logger.info('Athena schema listing completed', {
      catalog: this.catalog,
      database: this.database,
      pageCount,
      tableCount: tables.length
    });

    return {
      catalog: this.catalog,
      database: this.database,
      tables
    };
  }

  async validateQuery(queryText, options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    const pollIntervalMs = options.pollIntervalMs || 750;
    const explainQuery = `EXPLAIN ${queryText}`;
    const athenaQueryExecutionId = await this.submitQuery(explainQuery);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const execution = await this.getExecutionState(athenaQueryExecutionId);
      if (execution.state === 'SUCCEEDED') {
        return {
          valid: true,
          athenaQueryExecutionId
        };
      }

      if (execution.state === 'FAILED' || execution.state === 'CANCELLED') {
        return {
          valid: false,
          athenaQueryExecutionId,
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
      error: 'Validation timed out'
    };
  }
}

module.exports = {
  AthenaService
};
