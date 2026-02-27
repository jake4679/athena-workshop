const fs = require('fs');

function parseIntOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num)) {
    return null;
  }
  return num;
}

function normalizeRows(resultRows, columns) {
  if (!Array.isArray(resultRows)) {
    return [];
  }

  if (
    Array.isArray(columns) &&
    columns.length > 0 &&
    resultRows.length > 0 &&
    Array.isArray(resultRows[0]) &&
    resultRows[0].length === columns.length &&
    resultRows[0].every((value, index) => value === columns[index])
  ) {
    return resultRows.slice(1);
  }

  return resultRows;
}

function rowsToObjects(rows, columns) {
  return rows.map((row) => {
    const obj = {};
    columns.forEach((columnName, index) => {
      obj[`c${index}`] = Array.isArray(row) ? row[index] ?? null : null;
    });
    return obj;
  });
}

function buildValidationMarkers(errorMessage) {
  if (!errorMessage) {
    return [];
  }

  const lineColonMatch = errorMessage.match(/line\\s+(\\d+)\\s*:\\s*(\\d+)/i);
  if (lineColonMatch) {
    return [
      {
        message: errorMessage,
        line: Number(lineColonMatch[1]),
        column: Number(lineColonMatch[2]) + 1,
        severity: 'error'
      }
    ];
  }

  const lineColumnMatch = errorMessage.match(/line\\s+(\\d+)\\s*,\\s*column\\s+(\\d+)/i);
  if (lineColumnMatch) {
    return [
      {
        message: errorMessage,
        line: Number(lineColumnMatch[1]),
        column: Number(lineColumnMatch[2]),
        severity: 'error'
      }
    ];
  }

  return [
    {
      message: errorMessage,
      line: 1,
      column: 1,
      severity: 'error'
    }
  ];
}

function notFoundResponse(res, id) {
  return res.status(404).json({
    error: 'QUERY_NOT_FOUND',
    message: `Unknown query identifier: ${id}`
  });
}

function createQueryHandler({ services, logger }) {
  return async function createQuery(req, res) {
    const queryText = req.body?.query;
    const databaseName = req.body?.database;
    if (!queryText || typeof queryText !== 'string') {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Request body must include string field: query'
      });
    }

    if (databaseName !== undefined && (typeof databaseName !== 'string' || databaseName.trim() === '')) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'database must be a non-empty string when provided'
      });
    }

    try {
      const created = await services.createQuery(queryText, databaseName);
      return res.status(202).json({
        id: created.id,
        name: created.name,
        database: created.databaseName,
        status: created.status,
        submittedAt: created.submittedAt
      });
    } catch (error) {
      logger.error('Failed to create query', { error: error.message });
      return res.status(500).json({
        error: 'CREATE_FAILED',
        message: 'Failed to submit query'
      });
    }
  };
}

function getQueryStatusHandler({ services }) {
  return async function getQueryStatus(req, res) {
    try {
      const id = req.params.id;
      const query = await services.queryStore.getById(id);

      if (!query) {
        return notFoundResponse(res, id);
      }

      return res.status(200).json({
        id: query.id,
        name: query.name,
        database: query.databaseName,
        status: query.status,
        query: query.queryText,
        submittedAt: query.submittedAt,
        updatedAt: query.updatedAt,
        completedAt: query.completedAt,
        cancelledAt: query.cancelledAt,
        resultReceivedAt: query.resultReceivedAt,
        errorMessage: query.errorMessage
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'STATUS_LOOKUP_FAILED',
        message: 'Failed to lookup query status'
      });
    }
  };
}

function getQueryListHandler({ services }) {
  return async function getQueryList(_req, res) {
    try {
      const queries = await services.queryStore.listAll();
      return res.status(200).json({
        queries: queries.map((query) => ({
          id: query.id,
          name: query.name,
          database: query.databaseName,
          status: query.status,
          query: query.queryText,
          submittedAt: query.submittedAt,
          updatedAt: query.updatedAt,
          completedAt: query.completedAt,
          cancelledAt: query.cancelledAt,
          resultReceivedAt: query.resultReceivedAt
        }))
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'QUERY_LIST_FAILED',
        message: 'Failed to list queries'
      });
    }
  };
}

function listDatabasesHandler({ services, logger }) {
  return async function listDatabases(_req, res) {
    logger.info('Athena database list requested');
    try {
      const databases = await services.listDatabases();
      logger.info('Athena database list succeeded', {
        databaseCount: databases.length
      });
      return res.status(200).json({ databases });
    } catch (error) {
      logger.error('Athena database list failed', {
        error: error.message
      });
      return res.status(500).json({
        error: 'DATABASE_LIST_FAILED',
        message: 'Failed to list Athena databases'
      });
    }
  };
}

function listTablesHandler({ services, logger }) {
  return async function listTables(req, res) {
    const database = req.params.database;
    if (!database || typeof database !== 'string' || database.trim() === '') {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'database identifier must be a non-empty string'
      });
    }

    logger.info('Athena table list requested', { database });
    try {
      const result = await services.listTables(database);
      logger.info('Athena table list succeeded', {
        database: result.database,
        tableCount: Array.isArray(result.tables) ? result.tables.length : 0
      });
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Athena table list failed', {
        database,
        error: error.message
      });
      return res.status(500).json({
        error: 'TABLE_LIST_FAILED',
        message: 'Failed to list Athena tables'
      });
    }
  };
}

function getTableSchemaHandler({ services, logger }) {
  return async function getTableSchema(req, res) {
    const database = req.params.database;
    const table = req.params.table;
    if (!database || typeof database !== 'string' || database.trim() === '') {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'database identifier must be a non-empty string'
      });
    }
    if (!table || typeof table !== 'string' || table.trim() === '') {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'table identifier must be a non-empty string'
      });
    }

    logger.info('Athena table schema requested', { database, table });
    try {
      const schema = await services.getTableSchema(database, table);
      logger.info('Athena table schema succeeded', {
        database: schema.database,
        table: schema.table,
        columnCount: Array.isArray(schema.columns) ? schema.columns.length : 0
      });
      return res.status(200).json(schema);
    } catch (error) {
      if (error && error.code === 'TABLE_NOT_FOUND') {
        return res.status(404).json({
          error: 'TABLE_NOT_FOUND',
          message: `Unknown table identifier: ${table}`
        });
      }

      logger.error('Athena table schema failed', {
        database,
        table,
        error: error.message
      });
      return res.status(500).json({
        error: 'TABLE_SCHEMA_LOOKUP_FAILED',
        message: 'Failed to fetch Athena table schema'
      });
    }
  };
}

function validateQueryHandler({ services }) {
  return async function validateQuery(req, res) {
    try {
      const queryText = req.body?.query;
      const databaseName = req.body?.database;
      if (!queryText || typeof queryText !== 'string') {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'Request body must include string field: query'
        });
      }

      if (databaseName !== undefined && (typeof databaseName !== 'string' || databaseName.trim() === '')) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'database must be a non-empty string when provided'
        });
      }

      const validation = await services.validateQuery(queryText, databaseName);
      if (validation.valid) {
        return res.status(200).json({
          valid: true,
          markers: [],
          athenaQueryExecutionId: validation.athenaQueryExecutionId,
          database: validation.databaseName || null
        });
      }

      const markers = buildValidationMarkers(validation.error);
      return res.status(200).json({
        valid: false,
        markers,
        error: validation.error || 'Validation failed',
        athenaQueryExecutionId: validation.athenaQueryExecutionId,
        database: validation.databaseName || null
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'QUERY_VALIDATE_FAILED',
        message: 'Failed to validate query'
      });
    }
  };
}

function updateQueryHandler({ services }) {
  return async function updateQuery(req, res) {
    try {
      const id = req.params.id;
      const existing = await services.queryStore.getById(id);
      if (!existing) {
        return notFoundResponse(res, id);
      }

      const nextName = req.body?.name;
      const nextQuery = req.body?.query;
      const nextDatabase = req.body?.database;
      const hasName = nextName !== undefined;
      const hasQuery = nextQuery !== undefined;
      const hasDatabase = nextDatabase !== undefined;

      if (!hasName && !hasQuery && !hasDatabase) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'Request body must include at least one of: name, query, database'
        });
      }

      if (hasName && (typeof nextName !== 'string' || nextName.trim() === '')) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'name must be a non-empty string'
        });
      }

      if (hasQuery && (typeof nextQuery !== 'string' || nextQuery.trim() === '')) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'query must be a non-empty string'
        });
      }

      if (hasDatabase && (typeof nextDatabase !== 'string' || nextDatabase.trim() === '')) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'database must be a non-empty string'
        });
      }

      const updated = await services.queryStore.updateQueryDetails(id, {
        name: hasName ? nextName.trim() : undefined,
        databaseName: hasDatabase ? nextDatabase.trim() : undefined,
        queryText: hasQuery ? nextQuery : undefined
      });

      return res.status(200).json({
        id: updated.id,
        name: updated.name,
        database: updated.databaseName,
        status: updated.status,
        query: updated.queryText,
        submittedAt: updated.submittedAt,
        updatedAt: updated.updatedAt
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'QUERY_UPDATE_FAILED',
        message: 'Failed to update query'
      });
    }
  };
}

function getQueryResultsHandler({ services }) {
  return async function getQueryResults(req, res) {
    try {
      const id = req.params.id;
      const query = await services.queryStore.getById(id);

      if (!query) {
        return notFoundResponse(res, id);
      }

      if (query.status === 'RUNNING') {
        return res.status(409).json({
          error: 'QUERY_RUNNING',
          message: 'Query is still running',
          id: query.id,
          status: query.status
        });
      }

      if (query.status === 'CANCELLED') {
        return res.status(409).json({
          error: 'QUERY_CANCELLED',
          message: 'Query has been cancelled',
          id: query.id,
          status: query.status
        });
      }

      if (query.status !== 'SUCCEEDED' || !query.resultPath) {
        return res.status(409).json({
          error: 'RESULTS_NOT_AVAILABLE',
          message: 'No results available for this query',
          id: query.id,
          status: query.status
        });
      }

      const raw = fs.readFileSync(query.resultPath, 'utf-8');
      const result = JSON.parse(raw);
      const columns = Array.isArray(result.columns) ? result.columns : [];
      const normalizedRows = normalizeRows(result.rows, columns);

      const parsedLimit = parseIntOrNull(req.query.limit ?? req.query.size);
      const parsedOffset = parseIntOrNull(req.query.offset);
      const parsedPage = parseIntOrNull(req.query.page);
      const invalidLimitProvided =
        (req.query.limit !== undefined || req.query.size !== undefined) && parsedLimit === null;
      const invalidOffsetProvided = req.query.offset !== undefined && parsedOffset === null;
      const invalidPageProvided = req.query.page !== undefined && parsedPage === null;
      const wantsPagination =
        req.query.limit !== undefined ||
        req.query.offset !== undefined ||
        req.query.page !== undefined ||
        req.query.size !== undefined;

      if (wantsPagination) {
        if (invalidLimitProvided || invalidOffsetProvided || invalidPageProvided) {
          return res.status(400).json({
            error: 'INVALID_PAGINATION',
            message: 'limit/size, offset, and page must be valid integers'
          });
        }

        const limit = parsedLimit === null ? 25 : parsedLimit;
        if (limit <= 0) {
          return res.status(400).json({
            error: 'INVALID_PAGINATION',
            message: 'limit/size must be a positive integer'
          });
        }

        if (parsedOffset !== null && parsedOffset < 0) {
          return res.status(400).json({
            error: 'INVALID_PAGINATION',
            message: 'offset must be a non-negative integer'
          });
        }

        if (parsedPage !== null && parsedPage <= 0) {
          return res.status(400).json({
            error: 'INVALID_PAGINATION',
            message: 'page must be a positive integer'
          });
        }

        const offset = parsedOffset !== null ? parsedOffset : parsedPage ? (parsedPage - 1) * limit : 0;
        const totalRows = normalizedRows.length;
        const pagedRows = normalizedRows.slice(offset, offset + limit);
        const page = Math.floor(offset / limit) + 1;
        const lastPage = Math.max(1, Math.ceil(totalRows / limit));

        return res.status(200).json({
          id: query.id,
          name: query.name,
          database: query.databaseName,
          status: query.status,
          resultReceivedAt: query.resultReceivedAt,
          results: {
            queryId: result.queryId || query.id,
            athenaQueryExecutionId: result.athenaQueryExecutionId || query.athenaQueryExecutionId,
            fetchedAt: result.fetchedAt || query.resultReceivedAt,
            columns,
            rows: pagedRows,
            totalRows,
            limit,
            offset,
            page,
            hasMore: offset + pagedRows.length < totalRows
          },
          // Tabulator remote pagination compatibility.
          last_page: lastPage,
          data: rowsToObjects(pagedRows, columns),
          columns
        });
      }

      return res.status(200).json({
        id: query.id,
        name: query.name,
        database: query.databaseName,
        status: query.status,
        resultReceivedAt: query.resultReceivedAt,
        results: {
          ...result,
          columns,
          rows: normalizedRows
        }
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'RESULTS_RETRIEVAL_FAILED',
        message: 'Failed to retrieve query results'
      });
    }
  };
}

function refreshQueryHandler({ services }) {
  return async function refreshQuery(req, res) {
    try {
      const id = req.params.id;
      const refreshed = await services.refreshQuery(id);

      if (refreshed.error === 'NOT_FOUND') {
        return notFoundResponse(res, id);
      }

      if (refreshed.error === 'RUNNING') {
        return res.status(409).json({
          error: 'QUERY_RUNNING',
          message: 'Cannot refresh while query is running',
          id
        });
      }

      return res.status(202).json({
        id,
        database: refreshed.databaseName || null,
        status: refreshed.status,
        submittedAt: refreshed.submittedAt,
        updatedAt: refreshed.updatedAt
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'REFRESH_FAILED',
        message: 'Failed to refresh query'
      });
    }
  };
}

function cancelQueryHandler({ services }) {
  return async function cancelQuery(req, res) {
    try {
      const id = req.params.id;
      const cancelled = await services.cancelQuery(id);

      if (cancelled.error === 'NOT_FOUND') {
        return notFoundResponse(res, id);
      }

      if (cancelled.error === 'ALREADY_CANCELLED') {
        return res.status(409).json({
          error: 'QUERY_ALREADY_CANCELLED',
          message: 'Query is already cancelled',
          id
        });
      }

      if (cancelled.error === 'ALREADY_COMPLETED') {
        return res.status(409).json({
          error: 'QUERY_ALREADY_COMPLETED',
          message: 'Completed query cannot be cancelled',
          id
        });
      }

      return res.status(202).json({
        id,
        status: cancelled.status,
        cancelledAt: cancelled.cancelledAt
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'CANCEL_FAILED',
        message: 'Failed to cancel query'
      });
    }
  };
}

function deleteQueryHandler({ services }) {
  return async function deleteQuery(req, res) {
    try {
      const id = req.params.id;
      const deleted = await services.deleteQuery(id);
      if (deleted.error === 'NOT_FOUND') {
        return notFoundResponse(res, id);
      }

      return res.status(200).json({
        id,
        deleted: true
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'QUERY_DELETE_FAILED',
        message: 'Failed to delete query'
      });
    }
  };
}

module.exports = {
  createQueryHandler,
  updateQueryHandler,
  listDatabasesHandler,
  listTablesHandler,
  getTableSchemaHandler,
  validateQueryHandler,
  getQueryListHandler,
  getQueryStatusHandler,
  getQueryResultsHandler,
  refreshQueryHandler,
  cancelQueryHandler,
  deleteQueryHandler
};
