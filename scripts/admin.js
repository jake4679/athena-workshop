#!/usr/bin/env node

const { loadConfig } = require('../src/utils/config');
const { createPool, initSchema } = require('../src/db/mysql');
const { UserStore } = require('../src/services/userStore');
const { QueryStore } = require('../src/services/queryStore');

function parseArgs(argv) {
  const args = {
    positionals: [],
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      args[key] = argv[index + 1];
      index += 1;
      continue;
    }
    args.positionals.push(token);
  }

  return args;
}

function printOutput(value, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      process.stdout.write('No records found.\n');
      return;
    }
    console.table(value);
    return;
  }

  console.log(value);
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const command = cliArgs.positionals[0];

  if (!command) {
    throw new Error('Missing command. Expected one of: list-users, list-queries, list-unowned-queries, assign-query, grant-role, remove-role, disable-user, enable-user');
  }

  const { config } = loadConfig(process.argv.slice(2));
  const pool = await createPool(config.mysql);
  await initSchema(pool, { defaultAthenaDatabase: config.aws?.database || null });
  const userStore = new UserStore(pool);
  const queryStore = new QueryStore(pool);

  try {
    switch (command) {
      case 'list-users': {
        const users = await userStore.listUsers();
        printOutput(
          users.map((user) => ({
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            status: user.status,
            roles: user.roles.join(',')
          })),
          cliArgs.json
        );
        break;
      }
      case 'list-queries': {
        const userId = cliArgs.userId ? String(cliArgs.userId).trim() : null;
        const queries = await queryStore.listAll({ userId: userId || null });
        printOutput(
          queries.map((query) => ({
            id: query.id,
            name: query.name,
            createdByUserId: query.createdByUserId,
            database: query.databaseName,
            status: query.status,
            submittedAt: query.submittedAt
          })),
          cliArgs.json
        );
        break;
      }
      case 'list-unowned-queries': {
        const queries = await queryStore.listUnowned();
        printOutput(
          queries.map((query) => ({
            id: query.id,
            name: query.name,
            database: query.databaseName,
            status: query.status,
            submittedAt: query.submittedAt
          })),
          cliArgs.json
        );
        break;
      }
      case 'assign-query': {
        const queryId = String(cliArgs.queryId || '').trim();
        const userId = String(cliArgs.userId || '').trim();
        const email = String(cliArgs.email || '').trim();
        if (!queryId) {
          throw new Error('assign-query requires --queryId');
        }

        const existingQuery = await queryStore.getById(queryId);
        if (!existingQuery) {
          throw new Error(`Unknown query id: ${queryId}`);
        }

        let targetUser = null;
        if (userId) {
          targetUser = await userStore.getById(userId);
        } else if (email) {
          targetUser = await userStore.getByEmail(email);
        } else {
          throw new Error('assign-query requires either --userId or --email');
        }

        if (!targetUser) {
          throw new Error('Target user not found for assign-query');
        }

        const updated = await queryStore.assignOwner(queryId, targetUser.id);
        printOutput(
          {
            id: updated.id,
            name: updated.name,
            createdByUserId: updated.createdByUserId,
            database: updated.databaseName,
            status: updated.status,
            updatedAt: updated.updatedAt
          },
          cliArgs.json
        );
        break;
      }
      case 'grant-role': {
        const email = String(cliArgs.email || '').trim();
        const role = String(cliArgs.role || '').trim();
        if (!email || !role) {
          throw new Error('grant-role requires --email and --role');
        }
        const user = await userStore.getByEmail(email);
        if (!user) {
          throw new Error(`Unknown user email: ${email}`);
        }
        const updated = await userStore.assignRole(user.id, role);
        printOutput(updated, cliArgs.json);
        break;
      }
      case 'remove-role': {
        const email = String(cliArgs.email || '').trim();
        const role = String(cliArgs.role || '').trim();
        if (!email || !role) {
          throw new Error('remove-role requires --email and --role');
        }
        const user = await userStore.getByEmail(email);
        if (!user) {
          throw new Error(`Unknown user email: ${email}`);
        }
        const updated = await userStore.removeRole(user.id, role);
        printOutput(updated, cliArgs.json);
        break;
      }
      case 'disable-user':
      case 'enable-user': {
        const email = String(cliArgs.email || '').trim();
        const id = String(cliArgs.id || '').trim();
        let user = null;
        if (email) {
          user = await userStore.getByEmail(email);
        } else if (id) {
          user = await userStore.getById(id);
        }
        if (!user) {
          throw new Error('disable-user/enable-user requires a valid --email or --id');
        }
        const updated = await userStore.setStatus(user.id, command === 'disable-user' ? 'DISABLED' : 'ACTIVE');
        printOutput(updated, cliArgs.json);
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
