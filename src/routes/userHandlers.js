function formatUser(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    status: user.status,
    roles: user.roles || [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function listUsersHandler({ services }) {
  return async function listUsers(_req, res) {
    try {
      const users = await services.userStore.listUsers();
      return res.status(200).json({
        users: users.map(formatUser)
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'USER_LIST_FAILED',
        message: 'Failed to list users'
      });
    }
  };
}

function getUserHandler() {
  return async function getUser(req, res) {
    return res.status(200).json({
      user: formatUser(req.targetUser)
    });
  };
}

function updateUserHandler({ services }) {
  return async function updateUser(req, res) {
    try {
      const canAdminEdit = (req.auth.roles || []).includes('admin');
      const nextEmail = req.body?.email;
      const nextFirstName = req.body?.firstName;
      const nextLastName = req.body?.lastName;
      const nextStatus = req.body?.status;
      const hasStatus = nextStatus !== undefined;
      const hasEmail = nextEmail !== undefined;
      const hasFirstName = nextFirstName !== undefined;
      const hasLastName = nextLastName !== undefined;

      if (!hasEmail && !hasFirstName && !hasLastName && !hasStatus) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'Request body must include at least one of: email, firstName, lastName, status'
        });
      }

      if (hasEmail && (typeof nextEmail !== 'string' || nextEmail.trim() === '')) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'email must be a non-empty string'
        });
      }

      if (hasFirstName && (typeof nextFirstName !== 'string' || nextFirstName.trim() === '')) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'firstName must be a non-empty string'
        });
      }

      if (hasLastName && (typeof nextLastName !== 'string' || nextLastName.trim() === '')) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'lastName must be a non-empty string'
        });
      }

      if (hasStatus && !canAdminEdit) {
        return res.status(403).json({
          error: 'FORBIDDEN',
          message: 'Only admins can update user status'
        });
      }

      if (hasStatus && !['ACTIVE', 'DISABLED'].includes(nextStatus)) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'status must be one of: ACTIVE, DISABLED'
        });
      }

      const updated = await services.userStore.updateUserProfile(req.params.id, {
        email: hasEmail ? nextEmail.trim() : undefined,
        firstName: hasFirstName ? nextFirstName.trim() : undefined,
        lastName: hasLastName ? nextLastName.trim() : undefined,
        status: hasStatus ? nextStatus : undefined
      });

      return res.status(200).json({
        user: formatUser(updated)
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'USER_UPDATE_FAILED',
        message: 'Failed to update user'
      });
    }
  };
}

function disableUserHandler({ services }) {
  return async function disableUser(req, res) {
    try {
      const updated = await services.userStore.setStatus(req.params.id, 'DISABLED');
      return res.status(200).json({
        user: formatUser(updated)
      });
    } catch (_error) {
      return res.status(500).json({
        error: 'USER_DISABLE_FAILED',
        message: 'Failed to disable user'
      });
    }
  };
}

module.exports = {
  listUsersHandler,
  getUserHandler,
  updateUserHandler,
  disableUserHandler
};
