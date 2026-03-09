function unauthorized(res) {
  return res.status(401).json({
    error: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication is required'
  });
}

function forbidden(res, message = 'You do not have permission to perform this action') {
  return res.status(403).json({
    error: 'FORBIDDEN',
    message
  });
}

function queryNotFound(res, id) {
  return res.status(404).json({
    error: 'QUERY_NOT_FOUND',
    message: `Unknown query identifier: ${id}`
  });
}

function userNotFound(res, id) {
  return res.status(404).json({
    error: 'USER_NOT_FOUND',
    message: `Unknown user identifier: ${id}`
  });
}

function hasAnyRole(auth, allowedRoles = []) {
  if (!auth?.isAuthenticated) {
    return false;
  }
  const roleSet = new Set(auth.roles || []);
  return allowedRoles.some((role) => roleSet.has(role));
}

function authenticateRequest({ services }) {
  return async function authnMiddleware(req, res, next) {
    try {
      req.auth = await services.authService.getCurrentAuth(req);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireAuthenticated() {
  return function authRequired(req, res, next) {
    if (!req.auth?.isAuthenticated) {
      return unauthorized(res);
    }
    return next();
  };
}

function requireAnyRole(roles) {
  return function roleRequired(req, res, next) {
    if (!req.auth?.isAuthenticated) {
      return unauthorized(res);
    }
    if (!hasAnyRole(req.auth, roles)) {
      return forbidden(res);
    }
    return next();
  };
}

function loadQuery({ services }) {
  return async function queryLoader(req, res, next) {
    try {
      const query = await services.queryStore.getById(req.params.id);
      if (!query) {
        return queryNotFound(res, req.params.id);
      }
      req.queryRecord = query;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireQueryReadAccess() {
  return function queryReadAccess(req, res, next) {
    if (!req.auth?.isAuthenticated) {
      return unauthorized(res);
    }
    if (!hasAnyRole(req.auth, ['viewer', 'querier', 'admin'])) {
      return forbidden(res);
    }
    return next();
  };
}

function requireOwnedQueryMutation() {
  return function ownedQueryMutation(req, res, next) {
    if (!req.auth?.isAuthenticated) {
      return unauthorized(res);
    }
    if (!hasAnyRole(req.auth, ['querier'])) {
      return forbidden(res);
    }
    if (!req.queryRecord?.createdByUserId || req.queryRecord.createdByUserId !== req.auth.user.id) {
      return forbidden(res);
    }
    return next();
  };
}

function requireOwnedAssistantMutation() {
  return requireOwnedQueryMutation();
}

function requireQueryDeletePermission() {
  return function queryDeletePermission(req, res, next) {
    if (!req.auth?.isAuthenticated) {
      return unauthorized(res);
    }

    if (hasAnyRole(req.auth, ['admin'])) {
      return next();
    }

    if (!hasAnyRole(req.auth, ['querier'])) {
      return forbidden(res);
    }

    if (!req.queryRecord?.createdByUserId || req.queryRecord.createdByUserId !== req.auth.user.id) {
      return forbidden(res);
    }

    return next();
  };
}

function loadTargetUser({ services }) {
  return async function targetUserLoader(req, res, next) {
    try {
      const user = await services.userStore.getById(req.params.id);
      if (!user) {
        return userNotFound(res, req.params.id);
      }
      req.targetUser = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireSelfOrAdmin() {
  return function selfOrAdmin(req, res, next) {
    if (!req.auth?.isAuthenticated) {
      return unauthorized(res);
    }
    if (hasAnyRole(req.auth, ['admin'])) {
      return next();
    }
    if (req.auth.user.id !== req.params.id) {
      return forbidden(res);
    }
    return next();
  };
}

module.exports = {
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
};
