const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadConfig } = require('./utils/config');
const logger = require('./utils/logger');
const { createPool, initSchema } = require('./db/mysql');
const { QueryStore } = require('./services/queryStore');
const { AssistantStore } = require('./services/assistantStore');
const { AthenaService } = require('./services/athenaService');
const { AssistantService } = require('./services/assistantService');
const { LockManager } = require('./services/lockManager');
const { createServices } = require('./services/appServices');
const { buildApp } = require('./app');

function runAwsCliIdentityProbe(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(
      'aws',
      ['sts', 'get-caller-identity', '--output', 'json'],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr && String(stderr).trim() ? String(stderr).trim() : error.message;
          reject(new Error(detail));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (_parseError) {
          reject(new Error('Failed to parse aws cli identity response'));
        }
      }
    );
  });
}

function configureAwsCredentialEnvironment(config) {
  const awsConfig = config.aws || {};
  const hadEnvAccessKey = Boolean(process.env.AWS_ACCESS_KEY_ID);
  const hadEnvSessionToken = Boolean(process.env.AWS_SESSION_TOKEN || process.env.AWS_SECURITY_TOKEN);

  if (typeof awsConfig.profile === 'string' && awsConfig.profile.trim() !== '') {
    process.env.AWS_PROFILE = awsConfig.profile.trim();

    // Environment credentials take precedence over profile credentials in SDK resolution.
    // Clear them when profile is explicitly configured so stale session tokens do not override profile auth.
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_SECURITY_TOKEN;
  }

  if (!process.env.AWS_SDK_LOAD_CONFIG) {
    process.env.AWS_SDK_LOAD_CONFIG = '1';
  }

  logger.info('AWS credential environment configured for server process', {
    profile: process.env.AWS_PROFILE || null,
    sdkLoadConfig: process.env.AWS_SDK_LOAD_CONFIG || null,
    configFile: process.env.AWS_CONFIG_FILE || null,
    sharedCredentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE || null,
    home: process.env.HOME || null,
    hadEnvAccessKey,
    hadEnvSessionToken
  });
}

async function logAwsSecurityContext(athenaService) {
  try {
    const provider = athenaService?.client?.config?.credentials;
    if (typeof provider === 'function') {
      const creds = await provider();
      logger.info('Resolved AWS SDK credentials for Athena client', {
        accessKeyIdSuffix: creds?.accessKeyId ? creds.accessKeyId.slice(-4) : null,
        hasSessionToken: Boolean(creds?.sessionToken),
        expiration: creds?.expiration ? new Date(creds.expiration).toISOString() : null
      });
    } else {
      logger.warn('Athena client credentials provider is not a function');
    }
  } catch (error) {
    logger.warn('Failed to resolve AWS SDK credentials for Athena client', {
      error: error.message
    });
  }

  try {
    const identity = await runAwsCliIdentityProbe();
    logger.info('AWS caller identity (aws cli)', {
      account: identity?.Account || null,
      arn: identity?.Arn || null,
      userId: identity?.UserId || null
    });
  } catch (error) {
    logger.warn('Failed to resolve AWS caller identity via aws cli', {
      error: error.message
    });
  }
}

async function startServer() {
  const { config, configPath } = loadConfig();
  configureAwsCredentialEnvironment(config);
  const resultsDir = path.resolve(process.cwd(), config.server.resultsDir);
  fs.mkdirSync(resultsDir, { recursive: true });

  const pool = await createPool(config.mysql);
  await initSchema(pool, { defaultAthenaDatabase: config.aws?.database || null });

  const queryStore = new QueryStore(pool);
  const athenaService = new AthenaService(config);
  const lockManager = new LockManager();
  const assistantStore = new AssistantStore(pool);
  const assistantService = new AssistantService({
    assistantStore,
    queryStore,
    athenaService,
    lockManager,
    config,
    logger
  });
  const services = createServices({ queryStore, assistantService, athenaService, lockManager, logger });
  await logAwsSecurityContext(athenaService);

  const app = buildApp({ services, logger });

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
