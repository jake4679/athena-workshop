function getAuthMeHandler() {
  return async function getAuthMe(req, res) {
    if (!req.auth?.isAuthenticated) {
      return res.status(200).json({
        authenticated: false,
        mode: req.auth?.mode || 'enabled',
        provider: null,
        providers: req.auth?.providers || { google: false, local: false },
        user: null,
        roles: []
      });
    }

    return res.status(200).json({
      authenticated: true,
      mode: req.auth.mode || 'enabled',
      provider: req.auth.provider || null,
      providers: req.auth.providers || { google: false, local: false },
      user: {
        id: req.auth.user.id,
        email: req.auth.user.email,
        firstName: req.auth.user.firstName,
        lastName: req.auth.user.lastName,
        status: req.auth.user.status,
        createdAt: req.auth.user.createdAt,
        updatedAt: req.auth.user.updatedAt
      },
      roles: req.auth.roles || []
    });
  };
}

function localLoginHandler({ services }) {
  return async function localLogin(req, res, next) {
    try {
      if (services.authService.mode === 'disabled' || !services.authService.localEnabled) {
        return res.status(409).json({
          error: 'AUTH_PROVIDER_DISABLED',
          message: 'Local sign-in is disabled'
        });
      }

      const email = req.body?.email;
      const password = req.body?.password;
      const user = await services.authService.loginWithLocalPassword(req, email, password);
      return res.status(200).json({
        authenticated: true,
        mode: 'enabled',
        provider: 'local',
        providers: services.authService.availableProviders,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          status: user.status,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        },
        roles: user.roles || []
      });
    } catch (error) {
      if (error.code === 'INVALID_LOCAL_LOGIN') {
        return res.status(400).json({
          error: error.code,
          message: error.message
        });
      }

      if (error.code === 'INVALID_CREDENTIALS') {
        return res.status(401).json({
          error: error.code,
          message: 'Invalid email or password'
        });
      }

      if (error.code === 'USER_DISABLED') {
        return res.status(403).json({
          error: error.code,
          message: 'User account is disabled'
        });
      }

      if (error.code === 'AUTH_PROVIDER_DISABLED') {
        return res.status(409).json({
          error: error.code,
          message: 'Local sign-in is disabled'
        });
      }

      return next(error);
    }
  };
}

function googleLoginHandler({ services }) {
  return async function googleLogin(req, res, next) {
    try {
      if (services.authService.mode === 'disabled' || !services.authService.googleEnabled) {
        return res.status(409).json({
          error: 'AUTH_PROVIDER_DISABLED',
          message: 'Google sign-in is disabled'
        });
      }
      const url = await services.authService.beginGoogleLogin(req);
      return res.redirect(url);
    } catch (error) {
      return next(error);
    }
  };
}

function googleCallbackHandler({ services, logger }) {
  return async function googleCallback(req, res) {
    try {
      if (services.authService.mode === 'disabled' || !services.authService.googleEnabled) {
        return res.redirect('/');
      }
      await services.authService.handleGoogleCallback(req);
      return res.redirect('/');
    } catch (error) {
      logger.error('Google login callback failed', { error: error.message });

      const statusCode =
        error.code === 'USER_DISABLED' || error.code === 'OIDC_SESSION_MISSING' || error.code === 'OIDC_PROFILE_INVALID'
          ? 403
          : 500;

      return res.status(statusCode).json({
        error: error.code || 'AUTH_CALLBACK_FAILED',
        message:
          error.code === 'USER_DISABLED'
            ? 'User account is disabled'
            : 'Failed to complete Google sign-in'
      });
    }
  };
}

function logoutHandler({ services }) {
  return async function logout(req, res, next) {
    try {
      await services.authService.logout(req);
      res.clearCookie(services.authService.authConfig.sessionCookieName || 'athena.sid');
      return res.status(200).json({ loggedOut: true });
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  getAuthMeHandler,
  localLoginHandler,
  googleLoginHandler,
  googleCallbackHandler,
  logoutHandler
};
