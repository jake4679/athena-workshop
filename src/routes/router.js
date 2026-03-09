const express = require('express');
const {
  authenticateRequest,
  requireAuthenticated,
  requireAnyRole,
  loadQuery,
  requireQueryReadAccess,
  requireOwnedQueryMutation,
  requireOwnedAssistantMutation,
  requireQueryDeletePermission,
  loadTargetUser,
  requireSelfOrAdmin
} = require('../auth/middleware');
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
  downloadQueryResultsHandler,
  refreshQueryHandler,
  cancelQueryHandler,
  deleteQueryHandler,
  sendAssistantPromptHandler,
  getAssistantStatusHandler,
  cancelAssistantRunHandler,
  getAssistantMessagesHandler,
  compactAssistantSessionHandler
} = require('./queryHandlers');
const {
  getAuthMeHandler,
  googleLoginHandler,
  googleCallbackHandler,
  logoutHandler
} = require('./authHandlers');
const {
  listUsersHandler,
  getUserHandler,
  updateUserHandler,
  disableUserHandler
} = require('./userHandlers');

function buildRouter(context) {
  const router = express.Router();
  const authn = authenticateRequest(context);
  const queryLoader = loadQuery(context);
  const userLoader = loadTargetUser(context);

  router.use(authn);

  router.get('/auth/me', getAuthMeHandler(context));
  router.get('/auth/login/google', googleLoginHandler(context));
  router.get('/auth/google/callback', googleCallbackHandler(context));
  router.post('/auth/logout', logoutHandler(context));

  router.get('/users', requireAnyRole(['admin']), listUsersHandler(context));
  router.get('/users/:id', userLoader, requireSelfOrAdmin(), getUserHandler(context));
  router.put('/users/:id', userLoader, requireSelfOrAdmin(), updateUserHandler(context));
  router.delete('/users/:id', requireAnyRole(['admin']), userLoader, disableUserHandler(context));

  router.get('/database', requireAnyRole(['viewer', 'querier', 'admin']), listDatabasesHandler(context));
  router.get(
    '/database/:database/tables',
    requireAnyRole(['viewer', 'querier', 'admin']),
    listTablesHandler(context)
  );
  router.get(
    '/database/:database/:table/schema',
    requireAnyRole(['viewer', 'querier', 'admin']),
    getTableSchemaHandler(context)
  );

  router.post('/query', requireAnyRole(['querier']), createQueryHandler(context));
  router.post('/query/validate', requireAnyRole(['querier']), validateQueryHandler(context));
  router.get('/query', requireAnyRole(['viewer', 'querier', 'admin']), getQueryListHandler(context));

  router.put('/query/:id', queryLoader, requireOwnedQueryMutation(), updateQueryHandler(context));
  router.get('/query/:id/status', queryLoader, requireQueryReadAccess(), getQueryStatusHandler(context));
  router.get('/query/:id/results', queryLoader, requireQueryReadAccess(), getQueryResultsHandler(context));
  router.get(
    '/query/:id/results/download',
    queryLoader,
    requireQueryReadAccess(),
    downloadQueryResultsHandler(context)
  );
  router.delete('/query/:id', queryLoader, requireQueryDeletePermission(), deleteQueryHandler(context));
  router.post('/query/:id/refresh', queryLoader, requireOwnedQueryMutation(), refreshQueryHandler(context));
  router.post('/query/:id/cancel', queryLoader, requireOwnedQueryMutation(), cancelQueryHandler(context));
  router.post(
    '/query/:id/assistant/send',
    queryLoader,
    requireOwnedAssistantMutation(),
    sendAssistantPromptHandler(context)
  );
  router.get(
    '/query/:id/assistant/status',
    queryLoader,
    requireQueryReadAccess(),
    getAssistantStatusHandler(context)
  );
  router.post(
    '/query/:id/assistant/cancel',
    queryLoader,
    requireOwnedAssistantMutation(),
    cancelAssistantRunHandler(context)
  );
  router.get(
    '/query/:id/assistant/messages',
    queryLoader,
    requireQueryReadAccess(),
    getAssistantMessagesHandler(context)
  );
  router.post(
    '/query/:id/assistant/compact',
    queryLoader,
    requireOwnedAssistantMutation(),
    compactAssistantSessionHandler(context)
  );

  return router;
}

module.exports = {
  buildRouter
};
