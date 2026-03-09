async function createSessionMiddleware({ pool, config }) {
  const session = require('express-session');
  const MySQLStoreFactory = require('express-mysql-session');
  const MySQLStore = MySQLStoreFactory(session);
  const authConfig = config.auth || {};
  if (authConfig.mode === 'disabled') {
    return null;
  }
  const baseURL = String(authConfig.baseURL || '');
  const cookieMaxAgeMs = Number(authConfig.sessionMaxAgeMs || 7 * 24 * 60 * 60 * 1000);
  const secureCookies =
    authConfig.secureCookies === undefined
      ? baseURL.startsWith('https://')
      : Boolean(authConfig.secureCookies);

  if (!authConfig.sessionSecret) {
    throw new Error('auth.sessionSecret is required');
  }

  const store = new MySQLStore(
    {
      schema: {
        tableName: 'user_sessions',
        columnNames: {
          session_id: 'session_id',
          expires: 'expires',
          data: 'data'
        }
      },
      createDatabaseTable: false
    },
    pool
  );

  return session({
    name: authConfig.sessionCookieName || 'athena.sid',
    secret: authConfig.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: cookieMaxAgeMs
    }
  });
}

module.exports = {
  createSessionMiddleware
};
