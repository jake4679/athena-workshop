const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/services/authService');
const { updateUserHandler } = require('../src/routes/userHandlers');
const {
  INVALID_PASSWORD_HASH_OIDC,
  hashPassword
} = require('../src/auth/passwords');
const { createLoggerStub, createResponseStub } = require('./helpers/serviceHarness');

function createSessionStub() {
  return {
    userId: null,
    authProvider: null,
    oidc: null,
    regenerate(callback) {
      callback(null);
    },
    save(callback) {
      callback(null);
    },
    destroy(callback) {
      callback(null);
    }
  };
}

test('local login authenticates with email and password when enabled', async () => {
  const passwordHash = await hashPassword('s3cret', 'pepper-value');
  const authService = new AuthService({
    userStore: {
      async getAuthByEmail(email) {
        assert.equal(email, 'user@example.com');
        return {
          id: 'user-1',
          email,
          firstName: 'Local',
          lastName: 'User',
          status: 'ACTIVE',
          roles: ['viewer'],
          passwordHash
        };
      },
      async getById(id) {
        assert.equal(id, 'user-1');
        return {
          id,
          email: 'user@example.com',
          firstName: 'Local',
          lastName: 'User',
          status: 'ACTIVE',
          roles: ['viewer']
        };
      }
    },
    config: {
      auth: {
        mode: 'enabled',
        local: {
          enabled: true,
          passwordPepper: 'pepper-value'
        },
        google: {
          enabled: false
        }
      }
    },
    logger: createLoggerStub()
  });

  const req = { session: createSessionStub() };
  const user = await authService.loginWithLocalPassword(req, 'user@example.com', 's3cret');

  assert.equal(user.id, 'user-1');
  assert.equal(req.session.userId, 'user-1');
  assert.equal(req.session.authProvider, 'local');
});

test('changeOwnPassword rejects OIDC-only accounts for self-service password setup', async () => {
  const authService = new AuthService({
    userStore: {
      async getAuthById(id) {
        assert.equal(id, 'user-oidc');
        return {
          id,
          email: 'oidc@example.com',
          status: 'ACTIVE',
          passwordHash: INVALID_PASSWORD_HASH_OIDC,
          roles: ['viewer']
        };
      }
    },
    config: {
      auth: {
        mode: 'enabled',
        local: {
          enabled: true
        },
        google: {
          enabled: true
        }
      }
    },
    logger: createLoggerStub()
  });

  await assert.rejects(
    authService.changeOwnPassword('user-oidc', 'old-pass', 'new-pass'),
    (error) => error.code === 'LOCAL_PASSWORD_UNAVAILABLE'
  );
});

test('PUT /users/:id requires currentPassword for self-service password changes', async () => {
  const handler = updateUserHandler({
    services: {
      userStore: {
        async updateUserProfile() {
          throw new Error('should not update profile');
        }
      },
      authService: {
        async changeOwnPassword() {
          throw new Error('should not change password');
        },
        async setUserPassword() {
          throw new Error('should not set password');
        }
      }
    }
  });

  const req = {
    params: { id: 'user-1' },
    auth: {
      user: { id: 'user-1' },
      roles: ['viewer']
    },
    targetUser: {
      id: 'user-1',
      email: 'user@example.com',
      firstName: 'User',
      lastName: 'One',
      status: 'ACTIVE',
      roles: ['viewer']
    },
    body: {
      password: 'new-pass'
    }
  };
  const { res, output } = createResponseStub();

  await handler(req, res);

  assert.equal(output.statusCode, 400);
  assert.equal(output.body.error, 'INVALID_REQUEST');
});

test('PUT /users/:id allows admins to set another user password without currentPassword', async () => {
  let setPasswordCalls = 0;
  const handler = updateUserHandler({
    services: {
      userStore: {
        async updateUserProfile() {
          throw new Error('should not update profile');
        }
      },
      authService: {
        async setUserPassword(userId, password) {
          setPasswordCalls += 1;
          assert.equal(userId, 'user-2');
          assert.equal(password, 'admin-set-pass');
          return {
            id: 'user-2',
            email: 'other@example.com',
            firstName: 'Other',
            lastName: 'User',
            status: 'ACTIVE',
            roles: ['viewer'],
            createdAt: '2026-03-01T00:00:00.000Z',
            updatedAt: '2026-03-02T00:00:00.000Z'
          };
        },
        async changeOwnPassword() {
          throw new Error('should not call self-service password change');
        }
      }
    }
  });

  const req = {
    params: { id: 'user-2' },
    auth: {
      user: { id: 'admin-1' },
      roles: ['admin']
    },
    targetUser: {
      id: 'user-2'
    },
    body: {
      password: 'admin-set-pass'
    }
  };
  const { res, output } = createResponseStub();

  await handler(req, res);

  assert.equal(setPasswordCalls, 1);
  assert.equal(output.statusCode, 200);
  assert.equal(output.body.user.id, 'user-2');
});
