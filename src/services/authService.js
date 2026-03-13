const {
  INVALID_PASSWORD_HASH_OIDC,
  INVALID_PASSWORD_HASH_LOCAL_DISABLED,
  hashPassword,
  isPasswordHashUsable,
  resolvePasswordPepper,
  verifyPassword
} = require('../auth/passwords');

class AuthService {
  constructor({ userStore, config, logger }) {
    this.userStore = userStore;
    this.config = config;
    this.logger = logger;
    this.oidc = null;
    this.oidcConfig = null;
  }

  get authConfig() {
    return this.config.auth || {};
  }

  get googleConfig() {
    return this.authConfig.google || {};
  }

  get localConfig() {
    return this.authConfig.local || {};
  }

  get mode() {
    return this.authConfig.mode || 'enabled';
  }

  get devUserConfig() {
    return this.authConfig.devUser || {};
  }

  get issuerUrl() {
    return this.googleConfig.issuer || 'https://accounts.google.com';
  }

  get callbackUrl() {
    return `${String(this.authConfig.baseURL || '').replace(/\/+$/, '')}/auth/google/callback`;
  }

  get googleEnabled() {
    return this.mode === 'enabled' && this.googleConfig.enabled === true;
  }

  get localEnabled() {
    return this.mode === 'enabled' && this.localConfig.enabled === true;
  }

  get passwordPepper() {
    return resolvePasswordPepper(this.authConfig);
  }

  get availableProviders() {
    return {
      google: this.googleEnabled,
      local: this.localEnabled
    };
  }

  ensureModeIsSupported() {
    if (!['disabled', 'enabled'].includes(this.mode)) {
      throw new Error('auth.mode must be one of: disabled, enabled');
    }
  }

  async initialize() {
    this.ensureModeIsSupported();

    if (this.mode === 'disabled') {
      const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
      if (nodeEnv === 'production') {
        throw new Error('auth.mode=disabled is not allowed when NODE_ENV=production');
      }
      if (!this.devUserConfig.id) {
        throw new Error('auth.devUser.id is required when auth.mode=disabled');
      }
      this.logger.warn('Authentication is running in disabled development mode', {
        mode: this.mode,
        devUserId: this.devUserConfig.id,
        devUserRoles: this.devUserConfig.roles || []
      });
      return;
    }

    if (!this.googleEnabled && !this.localEnabled) {
      throw new Error('auth.mode=enabled requires at least one enabled auth provider');
    }

    if (!this.googleEnabled) {
      return;
    }

    if (this.oidc && this.oidcConfig) {
      return;
    }

    if (!this.authConfig.baseURL) {
      throw new Error('auth.baseURL is required');
    }
    if (!this.googleConfig.clientId) {
      throw new Error('auth.google.clientId is required');
    }
    if (!this.googleConfig.clientSecret) {
      throw new Error('auth.google.clientSecret is required');
    }

    this.oidc = await import('openid-client');
    this.oidcConfig = await this.oidc.discovery(
      new URL(this.issuerUrl),
      this.googleConfig.clientId,
      this.googleConfig.clientSecret
    );
  }

  async beginGoogleLogin(req) {
    if (this.mode === 'disabled') {
      req.session.userId = this.devUserConfig.id;
      await this.saveSession(req);
      return '/';
    }

    if (!this.googleEnabled) {
      const error = new Error('Google sign-in is disabled');
      error.code = 'AUTH_PROVIDER_DISABLED';
      throw error;
    }

    await this.initialize();

    const codeVerifier = this.oidc.randomPKCECodeVerifier();
    const codeChallenge = await this.oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = this.oidc.randomState();
    const nonce = this.oidc.randomNonce();

    req.session.oidc = {
      provider: 'google',
      codeVerifier,
      state,
      nonce
    };

    const url = this.oidc.buildAuthorizationUrl(this.oidcConfig, {
      redirect_uri: this.callbackUrl,
      scope: 'openid profile email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce
    });

    await this.saveSession(req);
    return url.href;
  }

  async handleGoogleCallback(req) {
    if (this.mode === 'disabled') {
      return this.getOrCreateDevUser();
    }

    if (!this.googleEnabled) {
      const error = new Error('Google sign-in is disabled');
      error.code = 'AUTH_PROVIDER_DISABLED';
      throw error;
    }

    await this.initialize();

    const oidcSession = req.session?.oidc;
    if (!oidcSession || oidcSession.provider !== 'google') {
      const error = new Error('Missing OIDC session state');
      error.code = 'OIDC_SESSION_MISSING';
      throw error;
    }

    const currentUrl = new URL(
      `${this.authConfig.baseURL.replace(/\/+$/, '')}${req.originalUrl}`
    );

    const tokens = await this.oidc.authorizationCodeGrant(this.oidcConfig, currentUrl, {
      pkceCodeVerifier: oidcSession.codeVerifier,
      expectedState: oidcSession.state,
      expectedNonce: oidcSession.nonce
    });

    const claims = typeof tokens.claims === 'function' ? tokens.claims() : {};
    const userInfo = await this.oidc.fetchUserInfo(
      this.oidcConfig,
      tokens.access_token,
      claims?.sub || this.oidc.skipSubjectCheck
    );

    const providerSubject = userInfo.sub || claims?.sub;
    if (!providerSubject) {
      const error = new Error('Missing provider subject from Google profile');
      error.code = 'OIDC_PROFILE_INVALID';
      throw error;
    }

    const normalizedEmail = typeof userInfo.email === 'string' && userInfo.email.trim() !== '' ? userInfo.email.trim() : null;
    const emailVerified = userInfo.email_verified !== false;
    let existing = await this.userStore.findUserByIdentity('google', providerSubject);
    if (!existing) {
      let user = null;
      if (normalizedEmail && emailVerified) {
        user = await this.userStore.getByEmail(normalizedEmail);
      }

      if (user && user.status !== 'ACTIVE') {
        const error = new Error('User account is disabled');
        error.code = 'USER_DISABLED';
        throw error;
      }

      if (!user) {
        user = await this.userStore.createUser({
          email: normalizedEmail,
          firstName: userInfo.given_name || null,
          lastName: userInfo.family_name || null,
          passwordHash: INVALID_PASSWORD_HASH_OIDC,
          status: 'ACTIVE'
        });
        this.logger.info('Created local user from Google identity', {
          userId: user.id,
          provider: 'google'
        });
      }

      const identity = await this.userStore.createIdentity({
        userId: user.id,
        provider: 'google',
        providerSubject,
        providerEmail: normalizedEmail,
        providerFirstName: userInfo.given_name || null,
        providerLastName: userInfo.family_name || null,
        providerProfileJson: JSON.stringify(userInfo)
      });

      existing = { user, identity };
    } else {
      await this.userStore.updateIdentitySnapshot('google', providerSubject, {
        providerEmail: normalizedEmail,
        providerFirstName: userInfo.given_name || null,
        providerLastName: userInfo.family_name || null,
        providerProfileJson: JSON.stringify(userInfo)
      });
    }

    if (existing.user.status !== 'ACTIVE') {
      const error = new Error('User account is disabled');
      error.code = 'USER_DISABLED';
      throw error;
    }

    await this.regenerateSession(req);
    req.session.userId = existing.user.id;
    req.session.authProvider = 'google';
    req.session.oidc = null;
    await this.saveSession(req);
    return existing.user;
  }

  async loginWithLocalPassword(req, email, password) {
    if (this.mode !== 'enabled' || !this.localEnabled) {
      const error = new Error('Local sign-in is disabled');
      error.code = 'AUTH_PROVIDER_DISABLED';
      throw error;
    }

    const normalizedEmail = typeof email === 'string' ? email.trim() : '';
    if (!normalizedEmail) {
      const error = new Error('email is required');
      error.code = 'INVALID_LOCAL_LOGIN';
      throw error;
    }
    if (typeof password !== 'string' || password.length === 0) {
      const error = new Error('password is required');
      error.code = 'INVALID_LOCAL_LOGIN';
      throw error;
    }

    const authUser = await this.userStore.getAuthByEmail(normalizedEmail);
    if (!authUser) {
      const error = new Error('Invalid email or password');
      error.code = 'INVALID_CREDENTIALS';
      throw error;
    }

    if (authUser.status !== 'ACTIVE') {
      const error = new Error('User account is disabled');
      error.code = 'USER_DISABLED';
      throw error;
    }

    const passwordMatches = await verifyPassword(password, authUser.passwordHash, this.passwordPepper);
    if (!passwordMatches) {
      const error = new Error('Invalid email or password');
      error.code = 'INVALID_CREDENTIALS';
      throw error;
    }

    await this.regenerateSession(req);
    req.session.userId = authUser.id;
    req.session.authProvider = 'local';
    req.session.oidc = null;
    await this.saveSession(req);
    return this.userStore.getById(authUser.id);
  }

  async setUserPassword(userId, nextPassword) {
    const passwordHash = await hashPassword(nextPassword, this.passwordPepper);
    return this.userStore.setPasswordHash(userId, passwordHash);
  }

  async disableLocalLogin(userId) {
    return this.userStore.setPasswordHash(userId, INVALID_PASSWORD_HASH_LOCAL_DISABLED);
  }

  async changeOwnPassword(userId, currentPassword, nextPassword) {
    const authUser = await this.userStore.getAuthById(userId);
    if (!authUser) {
      const error = new Error('Unknown user');
      error.code = 'USER_NOT_FOUND';
      throw error;
    }

    if (!isPasswordHashUsable(authUser.passwordHash)) {
      const error = new Error('Local password changes for this account require admin setup');
      error.code = 'LOCAL_PASSWORD_UNAVAILABLE';
      throw error;
    }

    const currentPasswordMatches = await verifyPassword(
      currentPassword,
      authUser.passwordHash,
      this.passwordPepper
    );
    if (!currentPasswordMatches) {
      const error = new Error('Current password is incorrect');
      error.code = 'CURRENT_PASSWORD_INVALID';
      throw error;
    }

    return this.setUserPassword(userId, nextPassword);
  }

  async getCurrentAuth(req) {
    if (this.mode === 'disabled') {
      const user = await this.getOrCreateDevUser();
      return {
        isAuthenticated: true,
        user,
        roles: user.roles || [],
        mode: 'disabled',
        provider: 'disabled',
        providers: {
          google: false,
          local: false
        }
      };
    }

    const userId = req.session?.userId;
    if (!userId) {
      return {
        isAuthenticated: false,
        user: null,
        roles: [],
        mode: 'enabled',
        provider: null,
        providers: this.availableProviders
      };
    }

    const user = await this.userStore.getById(userId);
    if (!user || user.status !== 'ACTIVE') {
      await this.destroySession(req);
      return {
        isAuthenticated: false,
        user: null,
        roles: [],
        mode: 'enabled',
        provider: null,
        providers: this.availableProviders
      };
    }

    return {
      isAuthenticated: true,
      user,
      roles: user.roles || [],
      mode: 'enabled',
      provider: req.session?.authProvider || null,
      providers: this.availableProviders
    };
  }

  async logout(req) {
    if (this.mode === 'disabled') {
      return;
    }
    await this.destroySession(req);
  }

  async getOrCreateDevUser() {
    let user = await this.userStore.getById(this.devUserConfig.id);
    if (!user) {
      user = await this.userStore.createUser({
        id: this.devUserConfig.id,
        email: this.devUserConfig.email || null,
        firstName: this.devUserConfig.firstName || null,
        lastName: this.devUserConfig.lastName || null,
        passwordHash: INVALID_PASSWORD_HASH_LOCAL_DISABLED,
        status: 'ACTIVE'
      });
    } else if (user.status !== 'ACTIVE') {
      user = await this.userStore.updateUserProfile(user.id, { status: 'ACTIVE' });
    }

    const expectedRoles = Array.isArray(this.devUserConfig.roles) ? this.devUserConfig.roles : [];
    const existingRoles = new Set(user.roles || []);
    for (const role of expectedRoles) {
      if (!existingRoles.has(role)) {
        user = await this.userStore.assignRole(user.id, role);
      }
    }
    return user;
  }

  async regenerateSession(req) {
    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async saveSession(req) {
    await new Promise((resolve, reject) => {
      req.session.save((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async destroySession(req) {
    if (!req.session) {
      return;
    }

    await new Promise((resolve, reject) => {
      req.session.destroy((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

module.exports = {
  AuthService
};
