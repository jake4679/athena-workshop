const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  const payload = input.trim() ? JSON.parse(input) : null;
  fs.mkdirSync(process.env.TOOL_WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.TOOL_WORKSPACE_DIR, 'last-call.txt'), payload?.message || '');

  process.stdout.write(
    JSON.stringify({
      ok: true,
      echoedArgs: payload,
      env: {
        QUERY_DIR: process.env.QUERY_DIR || null,
        RESULT_PATH: process.env.RESULT_PATH || null,
        TOOL_WORKSPACE_DIR: process.env.TOOL_WORKSPACE_DIR || null,
        TOOL_TMP_DIR: process.env.TOOL_TMP_DIR || null,
        TOOL_RUN_DIR: process.env.TOOL_RUN_DIR || null,
        AWS_REGION: process.env.AWS_REGION || null,
        LOG_BUCKET: process.env.LOG_BUCKET || null
      }
    })
  );
});
