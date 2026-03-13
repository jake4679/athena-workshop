const path = require('path');
const express = require('express');
const { buildRouter } = require('./routes/router');

function buildApp({
  services,
  logger,
  sessionMiddleware,
  staticDir = path.resolve(__dirname, '../public'),
  monacoStaticDir = path.resolve(__dirname, '../node_modules/monaco-editor/min')
}) {
  const app = express();
  if (sessionMiddleware) {
    app.use(sessionMiddleware);
  }
  app.use(express.json());
  app.use('/vendor/monaco', express.static(monacoStaticDir));
  app.use(express.static(staticDir));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(buildRouter({ services, logger }));

  app.use((err, _req, res, _next) => {
    logger.error('Unhandled request error', { error: err.message });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected server error' });
  });

  return app;
}

module.exports = {
  buildApp
};
