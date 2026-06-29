# PATCHER.md

This file helps the autopatcher understand how this fork diverges from the upstream repository and how to maintain it.

## Repositories

**Upstream:** https://github.com/coddingtonbear/obsidian-local-rest-api
**Fork:** https://github.com/auto-patcher/obsidian-local-rest-api (local copy at `/home/eva/sources/obsidian-local-rest-api`)

## Upstream Baseline

**Last patched:** v4.1.3

The fork is kept in sync with upstream releases. The autopatcher periodically pulls upstream changes and resolves any conflicts.

## Purpose

This fork serves as a local development environment for the Obsidian Local REST API plugin. It provides:
- Full REST API for vault access (read, write, patch, delete, search)
- Built-in MCP (Model Context Protocol) server for AI agent integration
- Secure authentication with API key support
- Surgical patching via heading, block reference, or frontmatter targeting

Key use cases:
- Local development and testing of API endpoints
- Integration testing against real Obsidian plugin behavior
- MCP server testing with Claude Code and other AI agents
- Extending the API with custom routes via extension interface

## Character

**Architecture:** Obsidian TypeScript plugin + Express.js REST API server

**Node.js + TypeScript focus:**
- esbuild-based bundler for plugin distribution
- Jest for unit and integration testing
- ESLint for code quality
- TypeScript for type safety across REST/MCP surfaces

**Key philosophy:**
- One code base, two protocol interfaces (REST + MCP)
- Surgical targeting (heading/block/frontmatter level edits)
- Secure by default (API key auth, self-signed TLS)
- Extensible via plugin extension interface

## Architecture

**Core structure:**
- `src/main.ts` — Obsidian plugin entry point
- `src/api.ts` — REST API endpoints
- `src/mcpHandler.ts` — MCP server implementation
- `src/vaultOperations.ts` — Core vault read/write logic
- `src/integration/` — Integration test suite

**Key flows:**
1. REST request → `requestHandler.ts` → `vaultOperations.ts` → response
2. MCP request → `mcpHandler.ts` → same `vaultOperations.ts` → MCP response
3. Vault operations (create, patch, delete) use shared validation and type guards

**Testing layers:**
- Unit tests in `src/*.test.ts` for individual functions
- Integration tests in `src/integration/*.test.ts` exercising full request flows
- Test utilities and fixtures in `src/integration/fixtures.ts` and `src/integration/client.ts`

## Style

**Code patterns:**
- Async/await for I/O operations
- Strict TypeScript mode (`strictNullChecks`, `noImplicitAny`)
- Request validation via `typeGuards.ts` predicates
- Server timeout management via `serverTimeouts.ts`

**REST conventions:**
- HTTPS with self-signed certs by default
- Bearer token authentication on all routes except `GET /`
- Custom headers for targeting (`Target-Type`, `Target`, `Operation`)
- URL path segments as alternate targeting syntax (`/vault/{path}/{target-type}/{target}`)

**MCP conventions:**
- Resource URIs for OpenAPI spec access (`obsidian://local-rest-api/openapi.yaml`)
- Tool signatures following MCP standard
- Streamable HTTP transport with Authorization header

**Documentation:**
- Interactive API docs generated from OpenAPI spec (jsonnet-based)
- README with quick-start examples for REST and MCP
- Per-tool descriptions in `docs/src/lib/descriptions/`
- CONTRIBUTING.md for extension development

## Testing

### Unit Tests

Run unit tests (isolated function-level tests):

```bash
npm test
```

Covers:
- `mcpHandler.test.ts` — MCP message parsing and response formatting
- `requestHandler.test.ts` — HTTP request parsing
- `serverTimeouts.test.ts` — Timeout configuration

### Integration Tests

Run integration tests (full request flow against test fixtures):

```bash
npm run test:integration
```

Covers:
- `active.test.ts` — Active file read/write operations
- `vault.test.ts` — Full vault CRUD
- `search.test.ts` — Search via simple and JsonLogic queries
- `patch.test.ts` — Surgical patching at heading/block/frontmatter level
- `periodic.test.ts` — Periodic note resolution and operations
- `commands.test.ts` — Command listing and execution
- `tags.test.ts` — Tag enumeration and usage counts
- `security.test.ts` — Auth enforcement and API key validation
- `meta.test.ts` — Server status and metadata endpoints
- `mcp.test.ts` — MCP protocol compliance

### Build

```bash
npm run build
```

Generates `main.js` and `main.css` for Obsidian plugin distribution.

### Smoke Tests

Manual verification checklist:
1. Install plugin in Obsidian, enable Local REST API setting
2. Copy API key from settings
3. Test REST endpoints: `curl -k -H "Authorization: Bearer $KEY" https://127.0.0.1:27124/vault/`
4. Test MCP: Connect Claude Code via `claude mcp add --transport http obsidian https://127.0.0.1:27124/mcp/ --header "Authorization: Bearer $KEY"`
5. Verify vault operations (read, write, patch, search) via each protocol

### Subagent Testing

When making changes affecting the MCP interface or tool definitions:
1. Generate updated OpenAPI spec: `npm run build-docs`
2. Validate MCP tools against resource spec in `docs/openapi.yaml`
3. Test with Claude agents to ensure tool use signatures work end-to-end
4. Document any tool signature changes in CHANGELOG
