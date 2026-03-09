function getAuthMeHandler() {
  return async function getAuthMe(req, res) {
    if (!req.auth?.isAuthenticated) {
      return res.status(200).json({
        authenticated: false,
        user: null,
        roles: []
      });
    }

    return res.status(200).json({
      authenticated: true,
      mode: req.auth.mode || 'oidc',
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

function googleLoginHandler({ services }) {
  return async function googleLogin(req, res, next) {
    try {
      if (services.authService.mode === 'disabled') {
        return res.status(409).json({
          error: 'AUTH_DISABLED',
          message: 'Google login is disabled because auth.mode=disabled'
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
      if (services.authService.mode === 'disabled') {
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
  googleLoginHandler,
  googleCallbackHandler,
  logoutHandler
};
