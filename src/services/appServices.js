const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

function createServices({ queryStore, assistantService, athenaService, lockManager, logger, userStore, authService }) {
  async function createQuery(queryText, databaseName, createdByUserId = null) {
    const id = uuidv4();
    const submitted = await athenaService.submitQuery(queryText, databaseName);

    const created = await queryStore.create({
      id,
      name: id,
      createdByUserId,
      databaseName: submitted.databaseName,
      queryText,
      athenaQueryExecutionId: submitted.athenaQueryExecutionId,
      status: 'RUNNING'
    });

    logger.info('Query submitted', {
      id,
      athenaQueryExecutionId: submitted.athenaQueryExecutionId,
      databaseName: submitted.databaseName
    });
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

      const submitted = await athenaService.submitQuery(existing.queryText, existing.databaseName);
      const refreshed = await queryStore.resetForRefresh(id, submitted.athenaQueryExecutionId);

      if (existing.resultPath && fs.existsSync(existing.resultPath)) {
        fs.unlinkSync(existing.resultPath);
      }

      logger.info('Query refreshed', {
        id,
        athenaQueryExecutionId: submitted.athenaQueryExecutionId,
        databaseName: submitted.databaseName
      });
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

  async function listDatabases() {
    return athenaService.listDatabases();
  }

  async function listTables(databaseName) {
    return athenaService.listTables(databaseName);
  }

  async function getTableSchema(databaseName, tableName) {
    return athenaService.getTableSchema(databaseName, tableName);
  }

  async function validateQuery(queryText, databaseName) {
    return athenaService.validateQuery(queryText, { databaseName });
  }

  async function sendAssistantPrompt(queryId, prompt) {
    return assistantService.send(queryId, prompt);
  }

  async function getAssistantStatus(queryId) {
    return assistantService.getStatus(queryId);
  }

  async function cancelAssistantRun(queryId) {
    return assistantService.cancel(queryId);
  }

  async function listAssistantMessages(queryId) {
    return assistantService.listMessages(queryId);
  }

  async function compactAssistantSession(queryId, mode) {
    return assistantService.compact(queryId, mode);
  }

  return {
    queryStore,
    userStore,
    authService,
    assistantService,
    createQuery,
    refreshQuery,
    cancelQuery,
    deleteQuery,
    listDatabases,
    listTables,
    getTableSchema,
    validateQuery,
    sendAssistantPrompt,
    getAssistantStatus,
    cancelAssistantRun,
    listAssistantMessages,
    compactAssistantSession,
    pollRunningQueries
  };
}

module.exports = {
  createServices
};
