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

  get mode() {
    return this.authConfig.mode || 'oidc';
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

  async initialize() {
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

    let existing = await this.userStore.findUserByIdentity('google', providerSubject);
    if (!existing) {
      const user = await this.userStore.createUser({
        email: userInfo.email || null,
        firstName: userInfo.given_name || null,
        lastName: userInfo.family_name || null,
        status: 'ACTIVE'
      });

      const identity = await this.userStore.createIdentity({
        userId: user.id,
        provider: 'google',
        providerSubject,
        providerEmail: userInfo.email || null,
        providerFirstName: userInfo.given_name || null,
        providerLastName: userInfo.family_name || null,
        providerProfileJson: JSON.stringify(userInfo)
      });

      existing = { user, identity };
      this.logger.info('Created local user from Google identity', {
        userId: user.id,
        provider: 'google'
      });
    } else {
      await this.userStore.updateIdentitySnapshot('google', providerSubject, {
        providerEmail: userInfo.email || null,
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
    req.session.oidc = null;
    await this.saveSession(req);
    return existing.user;
  }

  async getCurrentAuth(req) {
    if (this.mode === 'disabled') {
      const user = await this.getOrCreateDevUser();
      return {
        isAuthenticated: true,
        user,
        roles: user.roles || [],
        mode: 'disabled'
      };
    }

    const userId = req.session?.userId;
    if (!userId) {
      return {
        isAuthenticated: false,
        user: null,
        roles: []
      };
    }

    const user = await this.userStore.getById(userId);
    if (!user || user.status !== 'ACTIVE') {
      await this.destroySession(req);
      return {
        isAuthenticated: false,
        user: null,
        roles: []
      };
    }

    return {
      isAuthenticated: true,
      user,
      roles: user.roles || [],
      mode: 'oidc'
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
