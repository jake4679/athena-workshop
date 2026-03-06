const path = require('path');
const express = require('express');
const { buildRouter } = require('./routes/router');

function buildApp({ services, logger, staticDir = path.resolve(__dirname, '../public') }) {
  const app = express();
  app.use(express.json());
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
