const fs = require('fs');

function notFoundResponse(res, id) {
  return res.status(404).json({
    error: 'QUERY_NOT_FOUND',
    message: `Unknown query identifier: ${id}`
  });
}

function createQueryHandler({ services, logger }) {
  return async function createQuery(req, res) {
    const queryText = req.body?.query;
    if (!queryText || typeof queryText !== 'string') {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Request body must include string field: query'
      });
    }

    try {
      const created = await services.createQuery(queryText);
      return res.status(202).json({
        id: created.id,
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

      return res.status(200).json({
        id: query.id,
        status: query.status,
        resultReceivedAt: query.resultReceivedAt,
        results: result
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

module.exports = {
  createQueryHandler,
  getQueryStatusHandler,
  getQueryResultsHandler,
  refreshQueryHandler,
  cancelQueryHandler
};
