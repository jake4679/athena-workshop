const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AthenaService } = require('../src/services/athenaService');

test('AthenaService stores cached results under results/<query-id>/result.json and deletes query artifacts as a tree', async () => {
  const resultsDir = './results/test-athena-storage';
  const absoluteResultsDir = path.resolve(process.cwd(), resultsDir);
  fs.rmSync(absoluteResultsDir, { recursive: true, force: true });

  const service = new AthenaService({
    aws: {
      region: 'us-east-1',
      outputLocation: 's3://unit-test-results/prefix/',
      workGroup: 'primary'
    },
    server: {
      resultsDir
    }
  });

  service.client.send = async () => ({
    ResultSet: {
      ResultSetMetadata: {
        ColumnInfo: [{ Name: 'value' }]
      },
      Rows: [
        { Data: [{ VarCharValue: 'value' }] },
        { Data: [{ VarCharValue: '1' }] }
      ]
    }
  });

  const downloaded = await service.downloadResults('athena-qe-1', 'query-storage-1');
  const queryDir = path.join(absoluteResultsDir, 'query-storage-1');
  const resultPath = path.join(queryDir, 'result.json');

  assert.equal(downloaded.filePath, resultPath);
  assert.equal(fs.existsSync(resultPath), true);

  service.ensureToolRuntimePaths('query-storage-1', 'session-1', 'tool-call-1');
  assert.equal(fs.existsSync(path.join(queryDir, 'tools', 'workspace')), true);

  service.deleteQueryArtifacts('query-storage-1', downloaded.filePath);
  assert.equal(fs.existsSync(queryDir), false);
});
