const express = require('express');
const {
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
  deleteQueryHandler,
  sendAssistantPromptHandler,
  getAssistantStatusHandler,
  cancelAssistantRunHandler,
  getAssistantMessagesHandler
} = require('./queryHandlers');

function authMiddleware(_req, _res, next) {
  // Placeholder for future authn/authz checks.
  next();
}

function buildRouter(context) {
  const router = express.Router();
  router.use(authMiddleware);

  router.get('/database', listDatabasesHandler(context));
  router.get('/database/:database/tables', listTablesHandler(context));
  router.get('/database/:database/:table/schema', getTableSchemaHandler(context));
  router.post('/query', createQueryHandler(context));
  router.post('/query/validate', validateQueryHandler(context));
  router.get('/query', getQueryListHandler(context));
  router.put('/query/:id', updateQueryHandler(context));
  router.get('/query/:id/status', getQueryStatusHandler(context));
  router.get('/query/:id/results', getQueryResultsHandler(context));
  router.delete('/query/:id', deleteQueryHandler(context));
  router.post('/query/:id/refresh', refreshQueryHandler(context));
  router.post('/query/:id/cancel', cancelQueryHandler(context));
  router.post('/query/:id/assistant/send', sendAssistantPromptHandler(context));
  router.get('/query/:id/assistant/status', getAssistantStatusHandler(context));
  router.post('/query/:id/assistant/cancel', cancelAssistantRunHandler(context));
  router.get('/query/:id/assistant/messages', getAssistantMessagesHandler(context));

  return router;
}

module.exports = {
  buildRouter
};
