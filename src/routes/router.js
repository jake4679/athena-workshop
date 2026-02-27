const express = require('express');
const {
  createQueryHandler,
  updateQueryHandler,
  getSchemaHandler,
  getQueryListHandler,
  getQueryStatusHandler,
  getQueryResultsHandler,
  refreshQueryHandler,
  cancelQueryHandler,
  deleteQueryHandler
} = require('./queryHandlers');

function authMiddleware(_req, _res, next) {
  // Placeholder for future authn/authz checks.
  next();
}

function buildRouter(context) {
  const router = express.Router();
  router.use(authMiddleware);

  router.get('/schema', getSchemaHandler(context));
  router.post('/query', createQueryHandler(context));
  router.get('/query', getQueryListHandler(context));
  router.put('/query/:id', updateQueryHandler(context));
  router.get('/query/:id/status', getQueryStatusHandler(context));
  router.get('/query/:id/results', getQueryResultsHandler(context));
  router.delete('/query/:id', deleteQueryHandler(context));
  router.post('/query/:id/refresh', refreshQueryHandler(context));
  router.post('/query/:id/cancel', cancelQueryHandler(context));

  return router;
}

module.exports = {
  buildRouter
};
