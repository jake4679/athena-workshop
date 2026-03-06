const MAX_READ_QUERY_ROWS = 500;

const FORBIDDEN_KEYWORDS = new Set([
  'ALTER',
  'ANALYZE',
  'CALL',
  'CREATE',
  'DELETE',
  'DROP',
  'EXECUTE',
  'GRANT',
  'INSERT',
  'MERGE',
  'MSCK',
  'OPTIMIZE',
  'PREPARE',
  'REPAIR',
  'REVOKE',
  'SET',
  'TRUNCATE',
  'UNLOAD',
  'UPDATE',
  'USE',
  'VACUUM'
]);

function stripTrailingSemicolons(sql) {
  return String(sql || '').trim().replace(/;+$/g, '').trim();
}

function hasMultipleStatements(sql) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let depth = 0;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (ch === '-' && next === '-') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
    }

    if (!inDoubleQuote && !inBacktick && ch === '\'' && sql[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && !inBacktick && ch === '"' && sql[i - 1] !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktick) {
      continue;
    }

    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (ch === ';' && depth === 0) {
      const tail = sql.slice(i + 1).trim();
      if (tail) {
        return true;
      }
    }
  }

  return false;
}

function tokenizeTopLevel(sql) {
  const tokens = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  function flush() {
    const token = current.trim();
    if (token) {
      tokens.push(token.toUpperCase());
    }
    current = '';
  }

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (ch === '-' && next === '-') {
        flush();
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        flush();
        inBlockComment = true;
        i += 1;
        continue;
      }
    }

    if (!inDoubleQuote && !inBacktick && ch === '\'' && sql[i - 1] !== '\\') {
      flush();
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && !inBacktick && ch === '"' && sql[i - 1] !== '\\') {
      flush();
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && ch === '`') {
      flush();
      inBacktick = !inBacktick;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktick) {
      continue;
    }

    if (/[\s(),]/.test(ch)) {
      flush();
      continue;
    }

    current += ch;
  }

  flush();
  return tokens;
}

function hasDangerousTruncateUsage(sql) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (ch === '-' && next === '-') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
    }

    if (!inDoubleQuote && !inBacktick && ch === '\'' && sql[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && !inBacktick && ch === '"' && sql[i - 1] !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktick) {
      continue;
    }

    const isWordStart = /[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]));
    if (!isWordStart) {
      continue;
    }

    let end = i + 1;
    while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) {
      end += 1;
    }
    const word = sql.slice(i, end).toUpperCase();
    if (word === 'TRUNCATE') {
      let lookahead = end;
      while (lookahead < sql.length && /\s/.test(sql[lookahead])) {
        lookahead += 1;
      }
      if (sql[lookahead] !== '(') {
        return true;
      }
    }
    i = end - 1;
  }

  return false;
}

function validateReadQuery(sqlText) {
  const normalized = stripTrailingSemicolons(sqlText);
  if (!normalized) {
    return { valid: false, reason: 'query is required' };
  }

  if (hasMultipleStatements(normalized)) {
    return { valid: false, reason: 'multiple SQL statements are not allowed' };
  }

  const tokens = tokenizeTopLevel(normalized);
  if (tokens.length === 0) {
    return { valid: false, reason: 'query is empty after parsing' };
  }

  const first = tokens[0];
  const isReadStart = first === 'SELECT' || first === 'WITH' || first === 'EXPLAIN';
  if (!isReadStart) {
    return { valid: false, reason: 'only SELECT-style read queries are allowed' };
  }

  for (const token of tokens) {
    if (token === 'TRUNCATE') {
      // Allow TRUNCATE(...) numeric function usage in SELECT-style queries.
      continue;
    }
    if (FORBIDDEN_KEYWORDS.has(token)) {
      return {
        valid: false,
        reason: `disallowed SQL keyword detected: ${token}`
      };
    }
  }

  if (hasDangerousTruncateUsage(normalized)) {
    return {
      valid: false,
      reason: 'disallowed SQL keyword detected: TRUNCATE'
    };
  }

  if (first === 'EXPLAIN') {
    const hasSelectLike = tokens.includes('SELECT') || tokens.includes('WITH');
    if (!hasSelectLike) {
      return { valid: false, reason: 'EXPLAIN must target a SELECT-style query' };
    }
  }

  return {
    valid: true,
    normalizedQuery: normalized
  };
}

function rewriteReadQueryWithHardLimit(sqlText, maxRows = MAX_READ_QUERY_ROWS) {
  const validated = validateReadQuery(sqlText);
  if (!validated.valid) {
    return validated;
  }

  const safeLimit = Math.max(1, Math.min(MAX_READ_QUERY_ROWS, Number(maxRows) || MAX_READ_QUERY_ROWS));
  const rewrittenQuery =
    `SELECT *\n` + `FROM (\n${validated.normalizedQuery}\n) AS assistant_read_query\nLIMIT ${safeLimit}`;

  return {
    valid: true,
    normalizedQuery: validated.normalizedQuery,
    rewrittenQuery,
    enforcedRowLimit: safeLimit
  };
}

module.exports = {
  MAX_READ_QUERY_ROWS,
  validateReadQuery,
  rewriteReadQueryWithHardLimit
};
