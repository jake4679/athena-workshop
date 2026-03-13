const { v4: uuidv4 } = require('uuid');
const {
  INVALID_PASSWORD_HASH_LOCAL_DISABLED,
  isPasswordHashUsable
} = require('../auth/passwords');

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function fromUserRow(row, roles = []) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email || null,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    roles
  };
}

function fromIdentityRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerSubject: row.provider_subject,
    providerEmail: row.provider_email || null,
    providerFirstName: row.provider_first_name || null,
    providerLastName: row.provider_last_name || null,
    providerProfileJson: row.provider_profile_json || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function fromAuthUserRow(row, roles = []) {
  const user = fromUserRow(row, roles);
  if (!user) {
    return null;
  }

  return {
    ...user,
    passwordHash: row.password_hash || null,
    hasLocalPassword: isPasswordHashUsable(row.password_hash)
  };
}

class UserStore {
  constructor(pool) {
    this.pool = pool;
  }

  async getRolesForUser(userId) {
    const [rows] = await this.pool.execute(
      `SELECT r.name
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.name ASC`,
      [userId]
    );
    return rows.map((row) => row.name);
  }

  async getById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows[0]) {
      return null;
    }
    const roles = await this.getRolesForUser(id);
    return fromUserRow(rows[0], roles);
  }

  async getByEmail(email) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows[0]) {
      return null;
    }
    const roles = await this.getRolesForUser(rows[0].id);
    return fromUserRow(rows[0], roles);
  }

  async getAuthById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows[0]) {
      return null;
    }
    const roles = await this.getRolesForUser(id);
    return fromAuthUserRow(rows[0], roles);
  }

  async getAuthByEmail(email) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows[0]) {
      return null;
    }
    const roles = await this.getRolesForUser(rows[0].id);
    return fromAuthUserRow(rows[0], roles);
  }

  async getIdentity(provider, providerSubject) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM user_identities WHERE provider = ? AND provider_subject = ?',
      [provider, providerSubject]
    );
    return fromIdentityRow(rows[0]);
  }

  async createUser(record) {
    const now = new Date();
    const id = record.id || uuidv4();
    await this.pool.execute(
      `INSERT INTO users (
        id, email, first_name, last_name, password_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.email || null,
        record.firstName || null,
        record.lastName || null,
        record.passwordHash || INVALID_PASSWORD_HASH_LOCAL_DISABLED,
        record.status || 'ACTIVE',
        now,
        now
      ]
    );
    return this.getById(id);
  }

  async createIdentity(record) {
    const now = new Date();
    const id = record.id || uuidv4();
    await this.pool.execute(
      `INSERT INTO user_identities (
        id, user_id, provider, provider_subject, provider_email, provider_first_name, provider_last_name,
        provider_profile_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.userId,
        record.provider,
        record.providerSubject,
        record.providerEmail || null,
        record.providerFirstName || null,
        record.providerLastName || null,
        record.providerProfileJson || null,
        now,
        now
      ]
    );
    return this.getIdentity(record.provider, record.providerSubject);
  }

  async updateIdentitySnapshot(provider, providerSubject, updates = {}) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE user_identities
      SET provider_email = COALESCE(?, provider_email),
          provider_first_name = COALESCE(?, provider_first_name),
          provider_last_name = COALESCE(?, provider_last_name),
          provider_profile_json = COALESCE(?, provider_profile_json),
          updated_at = ?
      WHERE provider = ?
        AND provider_subject = ?`,
      [
        updates.providerEmail ?? null,
        updates.providerFirstName ?? null,
        updates.providerLastName ?? null,
        updates.providerProfileJson ?? null,
        now,
        provider,
        providerSubject
      ]
    );
  }

  async findUserByIdentity(provider, providerSubject) {
    const identity = await this.getIdentity(provider, providerSubject);
    if (!identity) {
      return null;
    }
    const user = await this.getById(identity.userId);
    if (!user) {
      return null;
    }
    return {
      user,
      identity
    };
  }

  async listUsers() {
    const [rows] = await this.pool.execute('SELECT * FROM users ORDER BY created_at DESC');
    const users = [];
    for (const row of rows) {
      const roles = await this.getRolesForUser(row.id);
      users.push(fromUserRow(row, roles));
    }
    return users;
  }

  async updateUserProfile(id, updates = {}) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE users
      SET email = COALESCE(?, email),
          first_name = COALESCE(?, first_name),
          last_name = COALESCE(?, last_name),
          status = COALESCE(?, status),
          updated_at = ?
      WHERE id = ?`,
      [
        updates.email ?? null,
        updates.firstName ?? null,
        updates.lastName ?? null,
        updates.status ?? null,
        now,
        id
      ]
    );
    return this.getById(id);
  }

  async setStatus(id, status) {
    return this.updateUserProfile(id, { status });
  }

  async setPasswordHash(id, passwordHash) {
    const now = new Date();
    await this.pool.execute(
      `UPDATE users
      SET password_hash = ?,
          updated_at = ?
      WHERE id = ?`,
      [passwordHash, now, id]
    );
    return this.getById(id);
  }

  async assignRole(userId, roleName) {
    await this.pool.execute(
      `INSERT IGNORE INTO user_roles (user_id, role_id, created_at)
      SELECT ?, r.id, ?
      FROM roles r
      WHERE r.name = ?`,
      [userId, new Date(), roleName]
    );
    return this.getById(userId);
  }

  async removeRole(userId, roleName) {
    await this.pool.execute(
      `DELETE ur
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
        AND r.name = ?`,
      [userId, roleName]
    );
    return this.getById(userId);
  }
}

module.exports = {
  UserStore
};
