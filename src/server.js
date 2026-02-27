const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { loadConfig } = require('./utils/config');
const logger = require('./utils/logger');
const { createPool, initSchema } = require('./db/mysql');
const { QueryStore } = require('./services/queryStore');
const { AthenaService } = require('./services/athenaService');
const { LockManager } = require('./services/lockManager');
const { buildRouter } = require('./routes/router');

function createServices({ queryStore, athenaService, lockManager }) {
  async function createQuery(queryText) {
    const id = uuidv4();
    const athenaQueryExecutionId = await athenaService.submitQuery(queryText);

    const created = await queryStore.create({
      id,
      name: id,
      queryText,
      athenaQueryExecutionId,
      status: 'RUNNING'
    });

    logger.info('Query submitted', { id, athenaQueryExecutionId });
    return created;
  }

  async function refreshQuery(id) {
    return lockManager.runWithLock(id, async () => {
      const existing = await queryStore.getById(id);
      if (!existing) {
        return { error: 'NOT_FOUND' };
      }

      if (existing.status === 'RUNNING') {
        return { error: 'RUNNING' };
      }

      const athenaQueryExecutionId = await athenaService.submitQuery(existing.queryText);
      const refreshed = await queryStore.resetForRefresh(id, athenaQueryExecutionId);

      if (existing.resultPath && fs.existsSync(existing.resultPath)) {
        fs.unlinkSync(existing.resultPath);
      }

      logger.info('Query refreshed', { id, athenaQueryExecutionId });
      return refreshed;
    });
  }

  async function cancelQuery(id) {
    return lockManager.runWithLock(id, async () => {
      const existing = await queryStore.getById(id);
      if (!existing) {
        return { error: 'NOT_FOUND' };
      }

      if (existing.status === 'CANCELLED') {
        return { error: 'ALREADY_CANCELLED' };
      }

      if (existing.status === 'SUCCEEDED' || existing.status === 'FAILED') {
        return { error: 'ALREADY_COMPLETED' };
      }

      try {
        await athenaService.cancelQuery(existing.athenaQueryExecutionId);
      } catch (error) {
        logger.warn('Athena cancel request failed', {
          id,
          athenaQueryExecutionId: existing.athenaQueryExecutionId,
          error: error.message
        });
      }

      const cancelled = await queryStore.updateStatus(id, 'CANCELLED', {
        cancelledAt: new Date()
      });

      logger.info('Query cancelled', { id });
      return cancelled;
    });
  }

  async function deleteQuery(id) {
    return lockManager.runWithLock(id, async () => {
      const existing = await queryStore.getById(id);
      if (!existing) {
        return { error: 'NOT_FOUND' };
      }

      if (existing.status === 'RUNNING') {
        try {
          await athenaService.cancelQuery(existing.athenaQueryExecutionId);
        } catch (error) {
          logger.warn('Athena cancel before delete failed', {
            id,
            athenaQueryExecutionId: existing.athenaQueryExecutionId,
            error: error.message
          });
        }
      }

      if (existing.resultPath && fs.existsSync(existing.resultPath)) {
        fs.unlinkSync(existing.resultPath);
      }

      await queryStore.deleteById(id);
      logger.info('Query deleted', { id });
      return { id };
    });
  }

  async function pollRunningQueries() {
    const running = await queryStore.listRunning();
    if (running.length === 0) {
      return;
    }

    logger.info('Poll cycle started', { runningQueryCount: running.length });

    const pollResults = await Promise.allSettled(
      running.map((query) =>
        lockManager.runWithLock(query.id, async () => {
          const latest = await queryStore.getById(query.id);
          if (!latest || latest.status !== 'RUNNING') {
            logger.debug('Skipping query during poll cycle', {
              id: query.id,
              reason: 'NOT_RUNNING_ANYMORE'
            });
            return;
          }

          const execution = await athenaService.getExecutionState(latest.athenaQueryExecutionId);
          logger.info('Polled Athena query state', {
            id: latest.id,
            athenaQueryExecutionId: latest.athenaQueryExecutionId,
            state: execution.state
          });

          if (execution.state === 'RUNNING' || execution.state === 'QUEUED') {
            return;
          }

          if (execution.state === 'CANCELLED') {
            await queryStore.updateStatus(latest.id, 'CANCELLED', {
              cancelledAt: new Date(),
              errorMessage: execution.reason || null
            });
            logger.info('Query marked cancelled by Athena', { id: latest.id });
            return;
          }

          if (execution.state === 'FAILED') {
            await queryStore.updateStatus(latest.id, 'FAILED', {
              completedAt: new Date(),
              errorMessage: execution.reason || 'Athena query failed'
            });
            logger.warn('Query failed in Athena', { id: latest.id, reason: execution.reason });
            return;
          }

          if (execution.state === 'SUCCEEDED') {
            const downloaded = await athenaService.downloadResults(
              latest.athenaQueryExecutionId,
              latest.id
            );

            await queryStore.updateStatus(latest.id, 'SUCCEEDED', {
              completedAt: new Date(),
              resultPath: downloaded.filePath,
              resultReceivedAt: new Date(downloaded.fetchedAt)
            });

            logger.info('Query succeeded and results downloaded', {
              id: latest.id,
              resultPath: downloaded.filePath
            });
          }
        })
      )
    );

    pollResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const failedQuery = running[index];
        logger.error('Poll processing failed for query', {
          id: failedQuery ? failedQuery.id : 'unknown',
          error: result.reason ? result.reason.message : 'Unknown error'
        });
      }
    });

    logger.info('Poll cycle finished', { checkedQueryCount: running.length });
  }

  async function getSchema() {
    return athenaService.listTableSchema();
  }

  async function validateQuery(queryText) {
    return athenaService.validateQuery(queryText);
  }

  return {
    queryStore,
    createQuery,
    refreshQuery,
    cancelQuery,
    deleteQuery,
    getSchema,
    validateQuery,
    pollRunningQueries
  };
}

async function startServer() {
  const { config, configPath } = loadConfig();
  const resultsDir = path.resolve(process.cwd(), config.server.resultsDir);
  fs.mkdirSync(resultsDir, { recursive: true });

  const pool = await createPool(config.mysql);
  await initSchema(pool);

  const queryStore = new QueryStore(pool);
  const athenaService = new AthenaService(config);
  const lockManager = new LockManager();
  const services = createServices({ queryStore, athenaService, lockManager });

  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve(__dirname, "../public")));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(buildRouter({ services, logger }));

  app.use((err, _req, res, _next) => {
    logger.error('Unhandled request error', { error: err.message });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected server error' });
  });

  const interval = setInterval(async () => {
    try {
      await services.pollRunningQueries();
    } catch (error) {
      logger.error('Polling cycle failed', { error: error.message });
    }
  }, config.server.pollIntervalMs || 3000);

  interval.unref();

  const port = config.server.port || 3000;
  app.listen(port, () => {
    logger.info('Server started', { port, configPath, resultsDir });
  });
}

startServer().catch((error) => {
  logger.error('Failed to start server', { error: error.message });
  process.exit(1);
});
