import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { posix } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import express from "express";
import { TFile } from "obsidian";

import { VaultOperations } from "./vaultOperations";
import { PatchFailed, PatchOperation, PatchTargetType } from "markdown-patch";
import openapiYaml from "../docs/openapi.yaml";
import { ERROR_CODE_MESSAGES } from "./constants";
import { LocalRestApiSettings } from "./types";

const PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

// Minimal structural type for McpServer — typed as a plain interface rather than the SDK's
// McpServer class to avoid TypeScript heap OOM from evaluating ToolCallback<ZodRawShape>.
interface MinimalMcpServer {
  tool(name: string, description: string, schema: unknown, callback: (args: unknown) => Promise<CallToolResult>): { remove: () => void };
  connect(transport: StreamableHTTPServerTransport): Promise<void>;
  resource(name: string, uri: string, meta: unknown, handler: (uri: URL) => Promise<unknown>): void;
}

interface ToolSpec {
  name: string;
  description: string;
  schema: unknown;
  callback: (args: unknown) => Promise<CallToolResult>;
}

interface ResourceSpec {
  name: string;
  uri: string;
  meta: unknown;
  handler: (uri: URL) => Promise<unknown>;
}

interface SessionEntry {
  server: MinimalMcpServer;
  transport: StreamableHTTPServerTransport;
  toolHandles: Map<string, { remove: () => void }>;
}

export class McpHandler {
  private readonly sessions: Map<string, SessionEntry> = new Map();
  private readonly toolSpecs: Map<string, ToolSpec> = new Map();
  private readonly resourceSpecs: ResourceSpec[] = [];

  constructor(
    private readonly ops: VaultOperations,
    private readonly settings: LocalRestApiSettings,
  ) {
    this.registerResources();
    this.registerTools();
  }

  // Build a fresh McpServer for a single session/transport. Each transport MUST own
  // its own server: the SDK's Server.connect() binds a single _transport, so sharing
  // one server across multiple connected transports routes every response to the
  // most-recently-connected transport, hanging all older sessions.
  private buildServer(): { server: MinimalMcpServer; toolHandles: Map<string, { remove: () => void }> } {
    const server: MinimalMcpServer = new McpServer({
      name: "obsidian-local-rest-api",
      version: "1.0.0",
    });
    const toolHandles = new Map<string, { remove: () => void }>();
    for (const spec of this.resourceSpecs) {
      server.resource(spec.name, spec.uri, spec.meta, spec.handler);
    }
    for (const spec of this.toolSpecs.values()) {
      toolHandles.set(spec.name, server.tool(spec.name, spec.description, spec.schema, spec.callback));
    }
    return { server, toolHandles };
  }

  private addResourceSpec(name: string, uri: string, meta: unknown, handler: (uri: URL) => Promise<unknown>): void {
    this.resourceSpecs.push({ name, uri, meta, handler });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tool(name: string, description: string, schema: any, callback: (args: any) => Promise<CallToolResult>): { remove: () => void } {
    const spec: ToolSpec = {
      name,
      description,
      schema,
      callback: async (args: unknown) => {
        try {
          const result = await callback(args);
          if (this.settings.enableVerboseLogging) {
            console.debug(`[MCP] ${name} => ok`);
          }
          return result;
        } catch (e) {
          if (this.settings.enableVerboseLogging) {
            console.debug(`[MCP] ${name} => error`);
          }
          throw e;
        }
      },
    };
    this.toolSpecs.set(spec.name, spec);
    for (const session of this.sessions.values()) {
      session.toolHandles.set(spec.name, session.server.tool(spec.name, spec.description, spec.schema, spec.callback));
    }
    return {
      remove: () => {
        this.toolSpecs.delete(spec.name);
        for (const session of this.sessions.values()) {
          const handle = session.toolHandles.get(spec.name);
          if (handle) {
            handle.remove();
            session.toolHandles.delete(spec.name);
          }
        }
      },
    };
  }

  public registerTool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    callback: (args: Record<string, unknown>) => Promise<unknown>,
  ): () => void {
    if (this.toolSpecs.has(name)) {
      throw new Error(
        `Cannot register MCP tool "${name}" — a tool with this name is already registered.`,
      );
    }
    const registered = this.tool(name, description, schema, async (args) =>
      this.text(await callback(args as Record<string, unknown>)),
    );
    return () => registered.remove();
  }

  async handleRequest(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      const { server, toolHandles } = this.buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { server, transport, toolHandles });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
  }

  private text(data: unknown) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            typeof data === "string" ? data : JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  private getActiveFile(): TFile {
    const file = this.ops.app.workspace.getActiveFile();
    if (!file) throw new Error("No active file");
    return file;
  }

  private registerResources(): void {
    this.addResourceSpec(
      "openapi-spec",
      "obsidian://local-rest-api/openapi.yaml",
      {
        mimeType: "application/yaml",
        description:
          "Full OpenAPI specification for the Obsidian Local REST API. " +
          "Contains complete request/response schemas, parameter descriptions, " +
          "and usage examples for every endpoint.",
      },
      async (uri: URL) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/yaml",
            text: openapiYaml,
          },
        ],
      }),
    );
  }

  private registerTools(): void {
    this.tool(
      "vault_list",
      "List files and subdirectories inside a vault directory. " +
        "Returns an array of names; directory entries end with '/'. " +
        "Omit path or pass an empty string to list the vault root.",
      { path: z.string().optional().describe("Directory path relative to vault root (default: root)") },
      async ({ path }: { path?: string }) => {
        const files = await this.ops.listVaultDirectory(path ?? "");
        return this.text({ files });
      },
    );

    this.tool(
      "vault_read",
      "Read a vault file's content and metadata. " +
        "Returns a JSON object with: content (full markdown text), path, " +
        "tags (array of tag strings), frontmatter (parsed YAML front-matter as an object), " +
        "stat ({ctime, mtime, size}), " +
        "links (array of vault-relative paths this file links to), " +
        "and backlinks (array of vault-relative paths of files that link here). " +
        "Throws if the file does not exist.\n\n" +
        "When targetType and target are both provided, returns only the matched section " +
        "as a plain string (markdown) or JSON value (frontmatter) instead of the full object. " +
        "Use vault_get_document_map first to discover available targets.",
      {
        path: z.string().describe("File path relative to vault root"),
        targetType: z
          .enum(["heading", "block", "frontmatter"])
          .optional()
          .describe("Type of section to extract: 'heading', 'block' reference, or 'frontmatter' key"),
        target: z
          .string()
          .optional()
          .describe(
            "Section to extract. Heading text, block reference ID (without '^'), or frontmatter key. " +
              "Separate nested heading levels with '::' (e.g. 'Heading 1::Subheading').",
          ),
        targetDelimiter: z
          .string()
          .optional()
          .describe("Delimiter for nested heading paths (default: '::')"),
      },
      async ({
        path,
        targetType,
        target,
        targetDelimiter,
      }: {
        path: string;
        targetType?: "heading" | "block" | "frontmatter";
        target?: string;
        targetDelimiter?: string;
      }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        if ((targetType == null) !== (target == null)) {
          throw new Error("targetType and target must be provided together");
        }
        if (targetType && target) {
          const section = await this.ops.readFileSection(file, targetType, target, targetDelimiter);
          return this.text(section);
        }
        const meta = await this.ops.getFileMetadataObject(file);
        return this.text(meta);
      },
    );

    this.tool(
      "vault_write",
      "Create or overwrite a vault file with the given content. " +
        "Creates any missing parent directories automatically. " +
        "Overwrites without warning if the file already exists.",
      {
        path: z.string().describe("File path relative to vault root"),
        content: z.string().describe("Full file content (markdown text)"),
      },
      async ({ path, content }: { path: string; content: string }) => {
        await this.ops.writeFileContent(path, content);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_append",
      "Append content to the end of a vault file. " +
        "Creates the file if it does not already exist.",
      {
        path: z.string().describe("File path relative to vault root"),
        content: z.string().describe("Content to append"),
      },
      async ({ path, content }: { path: string; content: string }) => {
        await this.ops.appendFileContent(path, content);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_patch",
      "Patch a specific section of a vault file by targeting a heading, block reference, or frontmatter field.\n\n" +
        "- targetType: 'heading' targets the content beneath a markdown heading (the heading line itself is not part of the section and must not appear in the supplied content); 'block' targets a block reference (the ID after '^'); 'frontmatter' targets a YAML front-matter key.\n" +
        "- target: the heading text, block ID, or frontmatter key. For nested headings use '::' as delimiter (e.g. 'Heading 1::Subheading'); customise with targetDelimiter.\n" +
        "- operation: 'append' adds content after the section, 'prepend' adds before, 'replace' replaces entirely.\n" +
        "- contentType: 'text/markdown' (default) treats content as markdown. 'application/json' parses it as JSON — useful for setting typed frontmatter values or appending rows to a table (pass a 2-D array of row cells).\n" +
        "- createTargetIfMissing: set to true to create the heading or frontmatter key if it does not exist yet.\n" +
        "- trimTargetWhitespace: strip leading/trailing whitespace from the target section before patching.\n" +
        "- rejectIfContentPreexists: fail the patch if the content string already appears in the target section — use this as an idempotency guard so a retry does not duplicate content.\n" +
        "- targetScope: controls what portion of the target the operation acts on. 'content' (default) patches only the content below the heading or at the block; 'marker' patches only the heading line or block-ID token itself; 'markerAndContent' patches the heading/block-ID together with its content. Only applicable to heading and block targets.\n\n" +
        "To discover valid heading names and block IDs before patching, call vault_get_document_map first.",
      {
        path: z.string().describe("File path relative to vault root"),
        targetType: z
          .enum(["heading", "block", "frontmatter"])
          .describe("Type of target section: 'heading', 'block' reference, or 'frontmatter' key"),
        target: z
          .string()
          .describe(
            "The section to patch. Heading text, block reference ID (without '^'), or frontmatter key. " +
              "Separate nested heading levels with '::' (e.g. 'Heading 1::Subheading').",
          ),
        operation: z
          .enum(["replace", "prepend", "append"])
          .describe("How to apply the content: replace the section, prepend before it, or append after it"),
        content: z.unknown().describe("Content to apply. For contentType 'text/markdown' pass a string. For contentType 'application/json' you may pass a native JSON value (number, boolean, array, object) and it will be serialised automatically."),
        contentType: z
          .string()
          .optional()
          .describe(
            "MIME type of content. 'text/markdown' (default) or 'application/json'. " +
              "Use 'application/json' to set typed frontmatter values or to append/prepend table rows (2-D array).",
          ),
        createTargetIfMissing: z
          .boolean()
          .optional()
          .describe("Create the heading or frontmatter key if it does not already exist (default: false)"),
        trimTargetWhitespace: z
          .boolean()
          .optional()
          .describe("Trim whitespace from the target section before applying the operation (default: false)"),
        rejectIfContentPreexists: z
          .boolean()
          .optional()
          .describe("If true, fail the patch when the content already appears in the target section (default: false). Use to make append/prepend operations idempotent on retry."),
        targetDelimiter: z
          .string()
          .optional()
          .describe("Delimiter for nested heading paths (default: '::')"),
        targetScope: z
          .enum(["content", "marker", "markerAndContent"])
          .optional()
          .describe(
            "Controls which part of the target the operation acts on. " +
              "'content' (default): patch the content below the heading or at the block. " +
              "'marker': patch only the heading line or block-ID token. " +
              "'markerAndContent': patch the heading/block-ID together with its content. " +
              "Only applicable to heading and block targets.",
          ),
      },
      async ({
        path,
        targetType,
        target,
        operation,
        content,
        contentType,
        createTargetIfMissing,
        trimTargetWhitespace,
        rejectIfContentPreexists,
        targetDelimiter,
        targetScope,
      }: {
        path: string;
        targetType: PatchTargetType;
        target: string;
        operation: PatchOperation;
        content: unknown;
        contentType?: string;
        createTargetIfMissing?: boolean;
        trimTargetWhitespace?: boolean;
        rejectIfContentPreexists?: boolean;
        targetDelimiter?: string;
        targetScope?: "content" | "marker" | "markerAndContent";
      }) => {
        try {
          await this.ops.patchFileSection(
            path,
            targetType,
            target,
            operation,
            content,
            contentType ?? "text/markdown",
            { createTargetIfMissing, trimTargetWhitespace, rejectIfContentPreexists, targetDelimiter, targetScope },
          );
        } catch (e) {
          if (e instanceof PatchFailed) {
            throw new Error(e.message);
          }
          throw e;
        }
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_delete",
      "Delete a file from the vault. Throws if the file does not exist.",
      { path: z.string().describe("File path relative to vault root") },
      async ({ path }: { path: string }) => {
        await this.ops.deleteVaultFile(path);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_move",
      "Move (rename) a vault file to a new path. " +
        "Creates any missing parent directories at the destination automatically. " +
        "Preserves file history and updates internal Obsidian links. " +
        "Throws if the source file does not exist. " +
        "Throws if the destination already exists and allowOverwrite is not set to true.\n\n" +
        "The destination must be a vault-relative path (e.g. 'archive/notes/todo.md'). " +
        "If the destination ends with '/', the source filename is preserved and the file is " +
        "placed in that directory (e.g. destination 'archive/' moves 'notes/todo.md' to 'archive/todo.md'). " +
        "The destination must not escape the vault root (i.e. the resolved path must remain within the vault).",
      {
        path: z.string().describe("Source file path relative to vault root"),
        destination: z
          .string()
          .describe(
            "Destination path relative to vault root. " +
              "May end with '/' to preserve the source filename in the target directory.",
          ),
        allowOverwrite: z
          .boolean()
          .optional()
          .describe("If true, move proceeds even when a file already exists at the destination (default: false)"),
      },
      async ({
        path,
        destination,
        allowOverwrite,
      }: {
        path: string;
        destination: string;
        allowOverwrite?: boolean;
      }) => {
        const normalized = destination
          .trim()
          .replace(/\\/g, "/")
          .replace(/\/+/g, "/");

        if (normalized.startsWith("/")) {
          throw new Error(
            "Destination path must be relative and must not escape the vault root.",
          );
        }

        const syntheticRoot = "/vault";
        const resolved = posix.resolve(syntheticRoot, normalized);
        if (resolved !== syntheticRoot && !resolved.startsWith(syntheticRoot + "/")) {
          throw new Error(
            "Destination path must be relative and must not escape the vault root.",
          );
        }

        const sourceFilename = path.includes("/")
          ? path.slice(path.lastIndexOf("/") + 1)
          : path;

        const resolvedDestination = !normalized || normalized.endsWith("/")
          ? normalized + sourceFilename
          : normalized;

        const actualPath = await this.ops.moveVaultFile(path, resolvedDestination, allowOverwrite ?? false);
        return this.text({ message: "OK", oldPath: path, newPath: actualPath });
      },
    );

    this.tool(
      "vault_get_document_map",
      "Return the structure of a vault file as a document map: the list of heading paths, " +
        "block reference IDs, and frontmatter field names present in the file. " +
        "Use this before vault_read or vault_patch with targeting to discover what targets are available " +
        "without parsing the full markdown content yourself.",
      { path: z.string().describe("File path relative to vault root") },
      async ({ path }: { path: string }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        const map = await this.ops.getDocumentMapObject(file);
        return this.text(map);
      },
    );

    this.tool(
      "active_file_get_path",
      "Return the vault-relative path of the file currently open in Obsidian. " +
        "Use this path with vault_read, vault_write, vault_append, vault_patch, " +
        "vault_get_document_map, or vault_delete to operate on the active file. " +
        "Throws if no file is active.",
      {},
      async () => {
        const file = this.getActiveFile();
        return this.text({ path: file.path });
      },
    );

    this.tool(
      "periodic_note_get_path",
      "Return the vault-relative path of the current periodic note for the given period " +
        "(daily, weekly, monthly, quarterly, or yearly). " +
        "Creates the note file if it does not already exist, applying any configured template. " +
        "Requires the Periodic Notes or Calendar plugin to be installed and configured. " +
        "Use the returned path with vault_read, vault_write, vault_append, vault_patch, " +
        "or vault_get_document_map to operate on the note.",
      {
        period: z
          .enum(PERIODS)
          .describe("Periodic note period: 'daily', 'weekly', 'monthly', 'quarterly', or 'yearly'"),
      },
      async ({ period }: { period: typeof PERIODS[number] }) => {
        const [file, err] = await this.ops.periodicGetOrCreateNote(period, Date.now());
        if (err || !file)
          throw new Error(
            `Could not get or create periodic note: ${err != null ? ERROR_CODE_MESSAGES[err] : "unknown error"}`,
          );
        return this.text({ path: file.path });
      },
    );

    this.tool(
      "search_query",
      "Search vault files using a JsonLogic query evaluated against each note's metadata.\n\n" +
        "The query is a JSON object following the JsonLogic spec (https://jsonlogic.com/operations.html). " +
        "It is evaluated against a NoteJson object for each file; files where the result is truthy are returned.\n\n" +
        "Each NoteJson has: path (string), content (string), tags (string[]), frontmatter (object), stat ({ctime, mtime, size}), links (string[]), backlinks (string[]).\n\n" +
        "Extra operators available beyond standard JsonLogic:\n" +
        "- {\"glob\": [\"*.foo\", {\"var\": \"path\"}]} — glob pattern match\n" +
        "- {\"regexp\": [\"^daily/\", {\"var\": \"path\"}]} — regular expression match\n\n" +
        "Returns an array of {filename, result} objects where result is the truthy value the query produced for that file.\n\n" +
        "Examples:\n" +
        "- Find by tag: {\"in\": [\"myTag\", {\"var\": \"tags\"}]}\n" +
        "- Find by frontmatter field: {\"==\": [{\"var\": \"frontmatter.status\"}, \"done\"]}\n" +
        "- Find by path glob: {\"glob\": [\"journal/*\", {\"var\": \"path\"}]}",
      {
        query: z
          .record(z.unknown())
          .describe("JsonLogic query object to evaluate against each note"),
      },
      async ({ query }: { query: unknown }) => {
        const results = await this.ops.searchJsonLogic(query);
        return this.text(results);
      },
    );

    this.tool(
      "search_simple",
      "Search vault files using Obsidian's built-in simple search. " +
        "Returns an array of {filename, score, matches} objects sorted by relevance score. " +
        "Each match includes the matched text and surrounding context characters (controlled by contextLength).",
      {
        query: z.string().describe("Search query string"),
        contextLength: z
          .number()
          .optional()
          .describe("Number of characters of surrounding context to return per match (default: 100)"),
      },
      async ({ query, contextLength }: { query: string; contextLength?: number }) => {
        const results = await this.ops.simpleSearch(query, contextLength);
        return this.text(results);
      },
    );

    this.tool(
      "tag_list",
      "Return all tags used across the vault, each with a usage count. " +
        "Tag names do not include the leading '#'. " +
        "This tool is read-only. To add a tag to a specific file, use vault_patch with " +
        "targetType 'frontmatter', target 'tags', operation 'append', contentType 'application/json', " +
        "and content [\"tag-name\"] (set createTargetIfMissing to true if the file may have no tags yet). " +
        "To remove a tag, read the current tags list with vault_read, filter client-side, then replace " +
        "the whole field with vault_patch using operation 'replace'. " +
        "For full examples, read the OpenAPI spec resource at obsidian://local-rest-api/openapi.yaml.",
      {},
      async () => {
        return this.text({ tags: this.ops.getAllTags() });
      },
    );

    this.tool(
      "command_list",
      "Return all registered Obsidian commands. " +
        "Each entry has an 'id' and a human-readable 'name'. " +
        "Pass the 'id' to command_execute to run a command.",
      {},
      async () => {
        return this.text({ commands: this.ops.listCommands() });
      },
    );

    this.tool(
      "command_execute",
      "Execute an Obsidian command by its ID. " +
        "Use command_list to discover available command IDs. " +
        "Throws if the command ID does not exist.",
      { commandId: z.string().describe("The command ID to execute (e.g. 'editor:toggle-bold')") },
      async ({ commandId }: { commandId: string }) => {
        this.ops.executeCommand(commandId);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "open_file",
      "Open a file in the Obsidian UI. " +
        "If the file does not exist, Obsidian will create a new document at that path. " +
        "Set newLeaf to true to open in a new pane rather than the current one.",
      {
        path: z.string().describe("File path relative to vault root"),
        newLeaf: z.boolean().optional().describe("Open in a new leaf/pane (default: false)"),
      },
      async ({ path, newLeaf }: { path: string; newLeaf?: boolean }) => {
        this.ops.openVaultFile(path, newLeaf);
        return this.text({ message: "OK" });
      },
    );

    // Canvas File Operations (Branch 1)

    this.tool(
      "canvas_list",
      "List .canvas files in a vault directory. " +
        "Returns an array of canvas file names and directory entries. " +
        "Omit dirPath or pass an empty string to list the vault root.",
      {
        dirPath: z.string().optional().describe("Directory path relative to vault root (default: root)"),
      },
      async ({ dirPath }: { dirPath?: string }) => {
        const files = await this.ops.listCanvasFiles(dirPath ?? "");
        return this.text({ files });
      },
    );

    this.tool(
      "canvas_read",
      "Read a canvas file and return its JSON structure with nodes and edges. " +
        "Each node has an id, type (text/file/link/group), and position/size (x, y, width, height). " +
        "Each edge connects two nodes with optional styling. " +
        "Throws if the canvas file does not exist or is invalid JSON.",
      {
        path: z.string().describe("Canvas file path relative to vault root (must end with .canvas)"),
      },
      async ({ path }: { path: string }) => {
        const data = await this.ops.readCanvas(path);
        return this.text(data);
      },
    );

    this.tool(
      "canvas_write",
      "Create or overwrite a canvas file with the given JSON structure. " +
        "Creates any missing parent directories automatically. " +
        "Input must have 'nodes' array (each with id, type, x, y, width, height) and 'edges' array (each with id, fromNode, toNode).",
      {
        path: z.string().describe("Canvas file path relative to vault root (must end with .canvas)"),
        data: z.record(z.unknown()).describe("Canvas data object with 'nodes' and 'edges' arrays"),
      },
      async ({ path, data }: { path: string; data: Record<string, unknown> }) => {
        await this.ops.writeCanvas(path, data as unknown as any);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "canvas_delete",
      "Delete a canvas file from the vault. " +
        "Throws if the canvas file does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root (must end with .canvas)"),
      },
      async ({ path }: { path: string }) => {
        await this.ops.deleteCanvas(path);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "canvas_search",
      "Search for text across all canvas files in a directory. " +
        "Searches both node text and edge labels. " +
        "Returns array of canvas files with matching text and context snippets.",
      {
        query: z.string().describe("Text query to search for"),
        dirPath: z.string().optional().describe("Directory path relative to vault root (default: root)"),
      },
      async ({ query, dirPath }: { query: string; dirPath?: string }) => {
        const results = await this.ops.searchCanvases(query, dirPath);
        return this.text({ results });
      },
    );

    // Canvas Metadata Operations (Branch 2)

    this.tool(
      "canvas_get_stats",
      "Get statistics for a canvas file including node and edge counts, node counts by type, and bounding box information. " +
        "The bounding box includes minX, minY, maxX, maxY (absolute coordinates), and computed width/height. " +
        "Throws if the canvas file does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
      },
      async ({ path }: { path: string }) => {
        const stats = await this.ops.getCanvasStats(path);
        return this.text(stats);
      },
    );

    // Canvas Card (Node) Operations (Branch 3)

    this.tool(
      "canvas_list_nodes",
      "List all nodes in a canvas file, with optional filtering by node type. " +
        "Returns an array of node objects. Each node has id, type (text/file/link/group), " +
        "position/size (x, y, width, height), and optional properties (color, text, file, url, label, etc). " +
        "Optional type filter narrows results to a specific node type.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        type: z
          .enum(["text", "file", "link", "group"])
          .optional()
          .describe("Filter nodes by type (text, file, link, or group)"),
      },
      async ({ path, type }: { path: string; type?: "text" | "file" | "link" | "group" }) => {
        const nodes = await this.ops.getCanvasNodes(path, type);
        return this.text(nodes);
      },
    );

    this.tool(
      "canvas_get_node",
      "Get a single node from a canvas by its ID. " +
        "Returns the complete node object with all properties. " +
        "Throws if the canvas file or node does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        nodeId: z.string().describe("Node ID"),
      },
      async ({ path, nodeId }: { path: string; nodeId: string }) => {
        const node = await this.ops.getCanvasNode(path, nodeId);
        return this.text(node);
      },
    );

    this.tool(
      "canvas_create_node",
      "Create a new node in a canvas and return the created node with a generated ID. " +
        "Required fields: type (text/file/link/group), x, y, width, height. " +
        "Optional fields vary by type: text (text content), file/url (reference), label/background (group styling).",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        type: z
          .enum(["text", "file", "link", "group"])
          .describe("Node type"),
        x: z.number().describe("X coordinate"),
        y: z.number().describe("Y coordinate"),
        width: z.number().describe("Node width"),
        height: z.number().describe("Node height"),
        color: z.string().optional().describe("Node color (optional)"),
        text: z.string().optional().describe("Text content (for text nodes)"),
        file: z.string().optional().describe("File reference (for file nodes)"),
        subpath: z.string().optional().describe("Section within file (for file nodes)"),
        url: z.string().optional().describe("URL (for link nodes)"),
        label: z.string().optional().describe("Label (for group nodes)"),
        background: z.string().optional().describe("Background color (for group nodes)"),
        backgroundStyle: z.string().optional().describe("Background style (for group nodes)"),
      },
      async (props: {
        path: string;
        type: "text" | "file" | "link" | "group";
        x: number;
        y: number;
        width: number;
        height: number;
        color?: string;
        text?: string;
        file?: string;
        subpath?: string;
        url?: string;
        label?: string;
        background?: string;
        backgroundStyle?: string;
      }) => {
        const { path, ...nodeData } = props;
        const node = await this.ops.addCanvasNode(path, nodeData as any);
        return this.text(node);
      },
    );

    this.tool(
      "canvas_update_node",
      "Update properties of an existing node in a canvas. " +
        "Provide only the fields you want to change; other properties are preserved. " +
        "Returns the updated node object. " +
        "Throws if the canvas file or node does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        nodeId: z.string().describe("Node ID"),
        x: z.number().optional().describe("New X coordinate"),
        y: z.number().optional().describe("New Y coordinate"),
        width: z.number().optional().describe("New width"),
        height: z.number().optional().describe("New height"),
        color: z.string().optional().describe("New color"),
        text: z.string().optional().describe("New text content"),
        file: z.string().optional().describe("New file reference"),
        subpath: z.string().optional().describe("New section reference"),
        url: z.string().optional().describe("New URL"),
        label: z.string().optional().describe("New label"),
        background: z.string().optional().describe("New background color"),
        backgroundStyle: z.string().optional().describe("New background style"),
      },
      async (props: {
        path: string;
        nodeId: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        color?: string;
        text?: string;
        file?: string;
        subpath?: string;
        url?: string;
        label?: string;
        background?: string;
        backgroundStyle?: string;
      }) => {
        const { path, nodeId, ...updates } = props;
        const node = await this.ops.updateCanvasNode(path, nodeId, updates as any);
        return this.text(node);
      },
    );

    this.tool(
      "canvas_delete_node",
      "Delete a node from a canvas. " +
        "Optionally delete all edges connected to this node. " +
        "Throws if the canvas file or node does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        nodeId: z.string().describe("Node ID"),
        deleteEdges: z.boolean().optional().describe("Also delete all edges connected to this node (default: false)"),
      },
      async ({ path, nodeId, deleteEdges }: { path: string; nodeId: string; deleteEdges?: boolean }) => {
        await this.ops.deleteCanvasNode(path, nodeId, deleteEdges ?? false);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "canvas_list_edges",
      "List all edges (connections) in a canvas file. " +
        "Returns an array of edge objects with their properties. " +
        "Throws if the canvas file does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
      },
      async ({ path }: { path: string }) => {
        const edges = await this.ops.getCanvasEdges(path);
        return this.text(edges);
      },
    );

    this.tool(
      "canvas_get_edge",
      "Get a single edge from a canvas by its ID. " +
        "Returns the edge object with all properties. " +
        "Throws if the canvas file or edge does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        edgeId: z.string().describe("Edge ID"),
      },
      async ({ path, edgeId }: { path: string; edgeId: string }) => {
        const edge = await this.ops.getCanvasEdge(path, edgeId);
        return this.text(edge);
      },
    );

    this.tool(
      "canvas_create_edge",
      "Create a new edge (connection) between two nodes in a canvas and return the created edge with a generated ID. " +
        "Both fromNode and toNode must exist in the canvas. " +
        "Throws if the canvas file or either node does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        fromNode: z.string().describe("ID of the source node"),
        toNode: z.string().describe("ID of the target node"),
        fromSide: z.enum(["top", "right", "bottom", "left"]).optional().describe("Which side of source node the edge starts from"),
        toSide: z.enum(["top", "right", "bottom", "left"]).optional().describe("Which side of target node the edge ends at"),
        fromEnd: z.enum(["none", "arrow"]).optional().describe("Arrow style at source end"),
        toEnd: z.enum(["none", "arrow"]).optional().describe("Arrow style at target end"),
        color: z.string().optional().describe("Edge color"),
        label: z.string().optional().describe("Edge label"),
      },
      async (props: {
        path: string;
        fromNode: string;
        toNode: string;
        fromSide?: "top" | "right" | "bottom" | "left";
        toSide?: "top" | "right" | "bottom" | "left";
        fromEnd?: "none" | "arrow";
        toEnd?: "none" | "arrow";
        color?: string;
        label?: string;
      }) => {
        const { path, ...edgeData } = props;
        const edge = await this.ops.addCanvasEdge(path, edgeData as any);
        return this.text(edge);
      },
    );

    this.tool(
      "canvas_update_edge",
      "Update properties of an existing edge in a canvas. " +
        "Provide only the fields you want to change; other properties are preserved. " +
        "Returns the updated edge object. " +
        "Throws if the canvas file or edge does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        edgeId: z.string().describe("Edge ID"),
        fromSide: z.enum(["top", "right", "bottom", "left"]).optional().describe("New source side"),
        toSide: z.enum(["top", "right", "bottom", "left"]).optional().describe("New target side"),
        fromEnd: z.enum(["none", "arrow"]).optional().describe("New source arrow style"),
        toEnd: z.enum(["none", "arrow"]).optional().describe("New target arrow style"),
        color: z.string().optional().describe("New edge color"),
        label: z.string().optional().describe("New edge label"),
      },
      async (props: {
        path: string;
        edgeId: string;
        fromSide?: "top" | "right" | "bottom" | "left";
        toSide?: "top" | "right" | "bottom" | "left";
        fromEnd?: "none" | "arrow";
        toEnd?: "none" | "arrow";
        color?: string;
        label?: string;
      }) => {
        const { path, edgeId, ...updates } = props;
        const edge = await this.ops.updateCanvasEdge(path, edgeId, updates as any);
        return this.text(edge);
      },
    );

    this.tool(
      "canvas_delete_edge",
      "Delete an edge from a canvas. " +
        "Throws if the canvas file or edge does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        edgeId: z.string().describe("Edge ID"),
      },
      async ({ path, edgeId }: { path: string; edgeId: string }) => {
        await this.ops.deleteCanvasEdge(path, edgeId);
        return this.text({ message: "OK" });
      },
    );

    // Canvas Groups (Branch 5)

    this.tool(
      "canvas_list_groups",
      "List all group nodes in a canvas. " +
        "Returns an array of group nodes (type='group'). " +
        "Throws if the canvas file does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
      },
      async ({ path }: { path: string }) => {
        const groups = await this.ops.getCanvasGroups(path);
        return this.json({ groups });
      },
    );

    this.tool(
      "canvas_get_group",
      "Get a group node and its spatially contained nodes from a canvas. " +
        "Returns {group, containedNodes} where group is the group node object " +
        "and containedNodes is an array of all nodes fully within the group's bounding box. " +
        "Throws if the canvas file or group does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        groupId: z.string().describe("Group node ID"),
      },
      async ({ path, groupId }: { path: string; groupId: string }) => {
        const result = await this.ops.getCanvasGroup(path, groupId);
        return this.json(result);
      },
    );

    this.tool(
      "canvas_create_group",
      "Create a new group node in a canvas. " +
        "Returns the created group node with a generated ID. " +
        "Throws if the canvas file does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        x: z.number().describe("X coordinate"),
        y: z.number().describe("Y coordinate"),
        width: z.number().describe("Width"),
        height: z.number().describe("Height"),
        label: z.string().optional().describe("Group label"),
        color: z.string().optional().describe("Color"),
        background: z.string().optional().describe("Background"),
        backgroundStyle: z.string().optional().describe("Background style"),
      },
      async (args: {
        path: string;
        x: number;
        y: number;
        width: number;
        height: number;
        label?: string;
        color?: string;
        background?: string;
        backgroundStyle?: string;
      }) => {
        const { path, ...groupData } = args;
        const group = await this.ops.addCanvasGroup(path, groupData);
        return this.json(group);
      },
    );

    this.tool(
      "canvas_update_group",
      "Update properties of a group node in a canvas. " +
        "Returns the updated group node. " +
        "Throws if the canvas file or group does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        groupId: z.string().describe("Group node ID"),
        label: z.string().optional().describe("New label"),
        x: z.number().optional().describe("New X coordinate"),
        y: z.number().optional().describe("New Y coordinate"),
        width: z.number().optional().describe("New width"),
        height: z.number().optional().describe("New height"),
        color: z.string().optional().describe("New color"),
        background: z.string().optional().describe("New background"),
        backgroundStyle: z.string().optional().describe("New background style"),
      },
      async (args: {
        path: string;
        groupId: string;
        label?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        color?: string;
        background?: string;
        backgroundStyle?: string;
      }) => {
        const { path, groupId, ...updates } = args;
        const group = await this.ops.updateCanvasGroup(path, groupId, updates);
        return this.json(group);
      },
    );

    this.tool(
      "canvas_delete_group",
      "Delete a group node from a canvas. " +
        "Throws if the canvas file or group does not exist.",
      {
        path: z.string().describe("Canvas file path relative to vault root"),
        groupId: z.string().describe("Group node ID"),
      },
      async ({ path, groupId }: { path: string; groupId: string }) => {
        await this.ops.deleteCanvasGroup(path, groupId);
        return this.text({ message: "OK" });
      },
    );
  }
}
