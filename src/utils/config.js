const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--config') {
      args.configPath = argv[i + 1];
      i += 1;
    } else if (token === '--port') {
      args.port = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function loadConfig(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.configPath) {
    throw new Error('Missing required --config <path> argument');
  }

  const absolutePath = path.resolve(process.cwd(), args.configPath);
  const fileContents = fs.readFileSync(absolutePath, 'utf-8');
  const config = JSON.parse(fileContents);

  if (Number.isFinite(args.port)) {
    config.server = config.server || {};
    config.server.port = args.port;
  }

  return {
    config,
    configPath: absolutePath
  };
}

module.exports = {
  loadConfig
};
