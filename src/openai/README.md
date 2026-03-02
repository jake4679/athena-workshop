# OpenAI Assistant Tool Schemas

This folder contains OpenAI function-tool schema definitions and exports used by assistant runtime code.

Current scope:
- Tool names/constants.
- Strict JSON schema function definitions for assistant query support.

Implemented outside this folder:
- OpenAI Responses API client flow (see `src/services/assistantService.js`).
- Tool execution handlers (`list_databases`, `list_tables`, `get_table_schema`, `validate_query`, `get_query`).
- Query-scoped assistant session orchestration and persistence.
