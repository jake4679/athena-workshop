const express = require('express');
const {
  createQueryHandler,
  getQueryStatusHandler,
  getQueryResultsHandler,
  refreshQueryHandler,
  cancelQueryHandler
} = require('./queryHandlers');

function authMiddleware(_req, _res, next) {
  // Placeholder for future authn/authz checks.
  next();
}

function buildRouter(context) {
  const router = express.Router();
  router.use(authMiddleware);

  router.post('/query', createQueryHandler(context));
  router.get('/query/:id/status', getQueryStatusHandler(context));
  router.get('/query/:id/results', getQueryResultsHandler(context));
  router.post('/query/:id/refresh', refreshQueryHandler(context));
  router.post('/query/:id/cancel', cancelQueryHandler(context));

  return router;
}

module.exports = {
  buildRouter
};
