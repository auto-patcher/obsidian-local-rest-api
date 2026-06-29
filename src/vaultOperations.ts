import {
  getAllTags,
  App,
  CachedMetadata,
  Command,
  prepareSimpleSearch,
  TFile,
} from "obsidian";
import * as periodicNotes from "obsidian-daily-notes-interface";
import path from "path";
import { randomBytes } from "crypto";
import {
  applyPatch,
  getDocumentMap,
  PatchInstruction,
  PatchOperation,
  PatchTargetType,
} from "markdown-patch";
 
const jsonLogic = require("json-logic-js") as {
  apply: (logic: unknown, data?: unknown) => unknown;
  add_operation: (name: string, code: (...args: unknown[]) => unknown) => void;
};
 
const WildcardRegexp = require("glob-to-regexp") as (pattern: string) => RegExp;

export class FileNotFoundError extends Error {}
export class CommandNotFoundError extends Error {}
export class DestinationAlreadyExistsError extends Error {}

import {
  CanvasData,
  CanvasEdge,
  CanvasNode,
  CanvasStats,
  DocumentMapObject,
  ErrorCode,
  FileMetadataObject,
  PeriodicNoteInterface,
  SearchContext,
  SearchJsonResponseItem,
  SearchResponseItem,
} from "./types";
import { toArrayBuffer } from "./utils";

export class VaultOperations {
  constructor(readonly app: App) {
    jsonLogic.add_operation(
      "glob",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          return WildcardRegexp(pattern).test(field);
        }
        return false;
      },
    );
    jsonLogic.add_operation(
      "regexp",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          return new RegExp(pattern).test(field);
        }
        return false;
      },
    );
  }

  private waitForFileCache(
    file: TFile,
    timeoutMs = 5000,
  ): Promise<CachedMetadata | null> {
    const existingCache = this.app.metadataCache.getFileCache(file);
    if (existingCache) {
      return Promise.resolve(existingCache);
    }

    return new Promise((resolve) => {
      let resolved = false;

      const onCacheChange = (...data: unknown[]) => {
        const changedFile = data[0];
        if (!(changedFile instanceof TFile)) return;
        if (changedFile.path === file.path && !resolved) {
          resolved = true;
          this.app.metadataCache.off("changed", onCacheChange);
          window.clearTimeout(timeoutId);
          resolve(this.app.metadataCache.getFileCache(file));
        }
      };

      const timeoutId = window.setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.app.metadataCache.off("changed", onCacheChange);
          console.warn(
            `[REST API] Timeout waiting for metadata cache for ${file.path} after ${timeoutMs}ms`,
          );
          resolve(this.app.metadataCache.getFileCache(file));
        }
      }, timeoutMs);

      this.app.metadataCache.on("changed", onCacheChange);

      const cacheAfterListener = this.app.metadataCache.getFileCache(file);
      if (cacheAfterListener && !resolved) {
        resolved = true;
        this.app.metadataCache.off("changed", onCacheChange);
        window.clearTimeout(timeoutId);
        resolve(cacheAfterListener);
      }
    });
  }

  async getDocumentMapObject(file: TFile): Promise<DocumentMapObject> {
    const content = await this.app.vault.adapter.read(file.path);
    const documentMap = getDocumentMap(content);

    return {
      headings: Object.keys(documentMap.heading)
        .filter((h) => h)
        .map((h) => h.split("\x1f").join("::")),
      blocks: Object.keys(documentMap.block),
      frontmatterFields: Object.keys(documentMap.frontmatter),
    };
  }

  async readFileSection(
    file: TFile,
    targetType: string,
    target: string,
    targetDelimiter = "::",
  ): Promise<unknown> {
    const content = await this.app.vault.adapter.read(file.path);
    const documentMap = getDocumentMap(content);

    if (targetType === "frontmatter") {
      const value: unknown = documentMap.frontmatter[target];
      if (value === undefined)
        throw new Error(`Frontmatter key not found: ${target}`);
      return value;
    }

    const mapKey =
      targetType === "heading"
        ? target.split(targetDelimiter).join("\x1f")
        : target;

    const entry =
      targetType === "heading"
        ? documentMap.heading[mapKey]
        : documentMap.block[mapKey];

    if (!entry) throw new Error(`${targetType} not found: ${target}`);

    return content.substring(entry.content.start, entry.content.end);
  }

  buildBacklinksIndex(): Record<string, string[]> {
    const index: Record<string, string[]> = {};
    for (const [sourcePath, targets] of Object.entries(
      this.app.metadataCache.resolvedLinks,
    )) {
      for (const targetPath of Object.keys(targets)) {
        (index[targetPath] ??= []).push(sourcePath);
      }
    }
    return index;
  }

  async getFileMetadataObject(
    file: TFile,
    backlinksIndex?: Record<string, string[]>,
    includeContent = true,
  ): Promise<FileMetadataObject> {
    const cache = await this.waitForFileCache(file);

    const frontmatter = { ...(cache?.frontmatter ?? {}) };
    delete frontmatter.position;

    const directTags = (cache?.tags ?? [])
      .filter((tag) => tag)
      .map((tag) => tag.tag);
    const frontmatterTags = Array.isArray(frontmatter.tags)
      ? (frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const filteredTags: string[] = [...frontmatterTags, ...directTags]
      .filter((tag) => tag)
      .map((tag) => tag.replace(/^#/, ""))
      .filter((value, index, self) => self.indexOf(value) === index);

    const links = Object.keys(
      this.app.metadataCache.resolvedLinks[file.path] ?? {},
    );

    const index = backlinksIndex ?? this.buildBacklinksIndex();
    const backlinks = index[file.path] ?? [];

    return {
      tags: filteredTags,
      frontmatter: frontmatter,
      stat: file.stat,
      path: file.path,
      content: includeContent ? await this.app.vault.cachedRead(file) : "",
      links,
      backlinks,
    };
  }

  async resolvePathAndTarget(rawPath: string): Promise<{
    filePath: string;
    targetType?: string;
    target?: string;
  } | null> {
    const normalizedPath = rawPath.endsWith("/")
      ? rawPath.slice(0, -1)
      : rawPath;
    if (!normalizedPath) return null;

    let exactStat = null;
    try {
      exactStat = await this.app.vault.adapter.stat(normalizedPath);
    } catch {
      // ENOTDIR: a path component is a file, not a directory;
      // fall through to the backward walk which will find the actual file.
    }
    if (exactStat?.type === "file") {
      return { filePath: normalizedPath };
    }

    const segments = normalizedPath.split("/");
    for (let i = segments.length - 1; i >= 1; i--) {
      const candidate = segments.slice(0, i).join("/");
      let s = null;
      try {
        s = await this.app.vault.adapter.stat(candidate);
      } catch {
        continue;
      }
      if (s?.type === "file") {
        const remainder = segments.slice(i);
        const targetType = remainder[0];
        const target =
          targetType === "heading"
            ? remainder.slice(1).join("::")
            : remainder[1];
        return { filePath: candidate, targetType, target };
      }
    }

    return null;
  }

  async listVaultDirectory(dirPath: string): Promise<string[]> {
    const normalizedPath = dirPath.endsWith("/")
      ? dirPath.slice(0, -1)
      : dirPath;
    const prefix = normalizedPath ? normalizedPath + "/" : "";
    const files = [
      ...new Set(
        this.app.vault
          .getFiles()
          .map((e) => e.path)
          .filter((filename) => filename.startsWith(prefix))
          .map((filename) => {
            const subPath = filename.slice(prefix.length);
            if (subPath.indexOf("/") > -1) {
              return subPath.slice(0, subPath.indexOf("/") + 1);
            }
            return subPath;
          }),
      ),
    ];
    files.sort();
    return files;
  }

  async readFileContent(filePath: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return this.app.vault.read(file);
  }

  async writeFileContent(
    filePath: string,
    content: string | Buffer,
  ): Promise<void> {
    try {
      await this.app.vault.createFolder(path.dirname(filePath));
    } catch {
      // folder already exists
    }
    if (typeof content === "string") {
      await this.app.vault.adapter.write(filePath, content);
    } else {
      await this.app.vault.adapter.writeBinary(
        filePath,
        toArrayBuffer(content),
      );
    }
  }

  async appendFileContent(filePath: string, content: string): Promise<void> {
    try {
      await this.app.vault.createFolder(path.dirname(filePath));
    } catch {
      // folder already exists
    }
    let fileContents = "";
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      fileContents = await this.app.vault.read(file);
      if (!fileContents.endsWith("\n")) {
        fileContents += "\n";
      }
    }
    fileContents += content;
    await this.app.vault.adapter.write(filePath, fileContents);
  }

  async deleteVaultFile(filePath: string): Promise<void> {
    const pathExists = await this.app.vault.adapter.exists(filePath);
    if (!pathExists) {
      throw new FileNotFoundError(`File not found: ${filePath}`);
    }
    await this.app.vault.adapter.remove(filePath);
  }

  async moveVaultFile(
    sourcePath: string,
    destinationPath: string,
    allowOverwrite = false,
  ): Promise<string> {
    if (!destinationPath) {
      throw new Error("Destination path must not be empty.");
    }

    if (sourcePath === destinationPath) {
      return sourcePath;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${sourcePath}`);
    }

    const destExists = await this.app.vault.adapter.exists(destinationPath);
    if (destExists) {
      if (!allowOverwrite) {
        throw new DestinationAlreadyExistsError(
          `Destination already exists: ${destinationPath}`,
        );
      }
      await this.app.vault.adapter.remove(destinationPath);
    }

    const parentDir = destinationPath.substring(
      0,
      destinationPath.lastIndexOf("/"),
    );
    if (parentDir && !(await this.app.vault.adapter.exists(parentDir))) {
      await this.app.vault.createFolder(parentDir);
    }

    // @ts-ignore - fileManager exists at runtime but not in type definitions
    await this.app.fileManager.renameFile(sourceFile, destinationPath);
    return sourceFile.path;
  }

  // Throws PatchFailed on patch error; caller is responsible for mapping to
  // the appropriate HTTP error code or MCP error.
  async patchFileSection(
    filePath: string,
    targetType: PatchTargetType,
    target: string,
    operation: PatchOperation,
    content: unknown,
    contentType: string,
    options?: {
      createTargetIfMissing?: boolean;
      rejectIfContentPreexists?: boolean;
      trimTargetWhitespace?: boolean;
      targetDelimiter?: string;
      targetScope?: string;
    },
  ): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${filePath}`);
    }
    const fileContents = await this.app.vault.read(file);

    const delimiter = options?.targetDelimiter ?? "::";
    const resolvedTarget: string | string[] =
      targetType === "heading" ? target.split(delimiter) : target;

    const instruction: PatchInstruction = {
      operation,
      targetType,
      target: resolvedTarget,
      contentType,
      content,
      rejectIfContentPreexists: options?.rejectIfContentPreexists ?? false,
      trimTargetWhitespace: options?.trimTargetWhitespace ?? false,
      createTargetIfMissing: options?.createTargetIfMissing ?? false,
      ...(options?.targetScope ? { targetScope: options.targetScope } : {}),
    } as PatchInstruction;

    const patched = applyPatch(fileContents, instruction);
    await this.app.vault.adapter.write(filePath, patched);
    return patched;
  }

  getPeriodicNoteInterface(): Record<string, PeriodicNoteInterface> {
    return {
      daily: {
        settings: periodicNotes.getDailyNoteSettings(),
        loaded: periodicNotes.appHasDailyNotesPluginLoaded(),
        create: periodicNotes.createDailyNote,
        get: periodicNotes.getDailyNote,
        getAll: periodicNotes.getAllDailyNotes,
      },
      weekly: {
        settings: periodicNotes.getWeeklyNoteSettings(),
        loaded: periodicNotes.appHasWeeklyNotesPluginLoaded(),
        create: periodicNotes.createWeeklyNote,
        get: periodicNotes.getWeeklyNote,
        getAll: periodicNotes.getAllWeeklyNotes,
      },
      monthly: {
        settings: periodicNotes.getMonthlyNoteSettings(),
        loaded: periodicNotes.appHasMonthlyNotesPluginLoaded(),
        create: periodicNotes.createMonthlyNote,
        get: periodicNotes.getMonthlyNote,
        getAll: periodicNotes.getAllMonthlyNotes,
      },
      quarterly: {
        settings: periodicNotes.getQuarterlyNoteSettings(),
        loaded: periodicNotes.appHasQuarterlyNotesPluginLoaded(),
        create: periodicNotes.createQuarterlyNote,
        get: periodicNotes.getQuarterlyNote,
        getAll: periodicNotes.getAllQuarterlyNotes,
      },
      yearly: {
        settings: periodicNotes.getYearlyNoteSettings(),
        loaded: periodicNotes.appHasYearlyNotesPluginLoaded(),
        create: periodicNotes.createYearlyNote,
        get: periodicNotes.getYearlyNote,
        getAll: periodicNotes.getAllYearlyNotes,
      },
    };
  }

  periodicGetInterface(
    period: string,
  ): [PeriodicNoteInterface | null, ErrorCode | null] {
    const periodic = this.getPeriodicNoteInterface();
    if (!periodic[period]) {
      return [null, ErrorCode.PeriodDoesNotExist];
    }
    if (!periodic[period].loaded) {
      return [null, ErrorCode.PeriodIsNotEnabled];
    }
    return [periodic[period], null];
  }

  periodicGetNote(
    periodName: string,
    timestamp: number,
  ): [TFile | null, ErrorCode | null] {
    const [period, err] = this.periodicGetInterface(periodName);
    if (err || !period) {
      return [null, err ?? ErrorCode.PeriodDoesNotExist];
    }
    const now = window.moment(timestamp);
    const all = period.getAll();

    const file = period.get(now, all);
    if (!file) {
      return [null, ErrorCode.PeriodicNoteDoesNotExist];
    }
    return [file, null];
  }

  async periodicGetOrCreateNote(
    periodName: string,
    timestamp: number,
  ): Promise<[TFile | null, ErrorCode | null]> {
    const [gottenFile, err] = this.periodicGetNote(periodName, timestamp);
    let file = gottenFile;
    if (err === ErrorCode.PeriodicNoteDoesNotExist) {
      const [period] = this.periodicGetInterface(periodName);
      if (!period) {
        return [null, ErrorCode.PeriodDoesNotExist];
      }
      const now = window.moment(Date.now());

      file = await period.create(now);
      await this.waitForFileCache(file);
    } else if (err) {
      return [null, err];
    }

    return [file, null];
  }

  async simpleSearch(
    query: string,
    contextLength = 100,
  ): Promise<SearchResponseItem[]> {
    const results: SearchResponseItem[] = [];
    const search = prepareSimpleSearch(query);

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cachedContents = await this.app.vault.cachedRead(file);

      const filenamePrefix = file.basename + "\n\n";
      const result = search(filenamePrefix + cachedContents);
      const positionOffset = filenamePrefix.length;

      if (result) {
        const contextMatches: SearchContext[] = [];
        for (const match of result.matches) {
          if (match[0] < positionOffset && match[1] <= positionOffset) {
            contextMatches.push({
              match: {
                start: match[0],
                end: Math.min(match[1], file.basename.length),
                source: "filename",
              },
              context: file.basename,
            });
          } else if (match[0] >= positionOffset) {
            contextMatches.push({
              match: {
                start: match[0] - positionOffset,
                end: match[1] - positionOffset,
                source: "content",
              },
              context: cachedContents.slice(
                Math.max(match[0] - positionOffset - contextLength, 0),
                match[1] - positionOffset + contextLength,
              ),
            });
          }
        }

        results.push({
          filename: file.path,
          score: result.score,
          matches: contextMatches,
        });
      }
    }

    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return results;
  }

  async searchJsonLogic(
    query: unknown,
  ): Promise<SearchJsonResponseItem[]> {
    const results: SearchJsonResponseItem[] = [];
    const backlinksIndex = this.buildBacklinksIndex();
    const includeContent = JSON.stringify(query).includes('"content"');

    for (const file of this.app.vault.getMarkdownFiles()) {
      const fileContext = await this.getFileMetadataObject(file, backlinksIndex, includeContent);

      try {
        const fileResult = jsonLogic.apply(query, fileContext);

        if (this.isTruthy(fileResult)) {
          results.push({ filename: file.path, result: fileResult });
        }
      } catch (e) {
        const error = e as Error;
        throw new Error(`${error.message} (while processing ${file.path})`);
      }
    }

    return results;
  }

  private isTruthy(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  }

  getAllTags(): Array<{ name: string; count: number }> {
    const tagCounts: Record<string, number> = {};
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const fileTags = getAllTags(cache);
      if (!fileTags) continue;
      for (const rawTag of fileTags) {
        const tag = rawTag.startsWith("#") ? rawTag.slice(1) : rawTag;
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        const parts = tag.split("/");
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          tagCounts[parent] = (tagCounts[parent] || 0) + 1;
        }
      }
    }
    const tags: { name: string; count: number }[] = [];
    for (const [tag, count] of Object.entries(tagCounts)) {
      if (!tag) continue;
      tags.push({ name: tag, count });
    }
    return tags;
  }

  listCommands(): Command[] {
    const commands: Command[] = [];
    for (const commandName in this.app.commands.commands) {
      commands.push({
        id: commandName,
        name: this.app.commands.commands[commandName].name,
      });
    }
    return commands;
  }

  executeCommand(commandId: string): void {
    const cmd = this.app.commands.commands[commandId];
    if (!cmd) {
      throw new CommandNotFoundError(`Command not found: ${commandId}`);
    }
    this.app.commands.executeCommandById(commandId);
  }

  openVaultFile(filePath: string, newLeaf = false): void {
    void this.app.workspace.openLinkText(filePath, "/", newLeaf);
  }

  // Canvas operations

  private _generateCanvasId(): string {
    return randomBytes(8).toString("hex");
  }

  private async _readCanvasData(filePath: string): Promise<CanvasData> {
    const content = await this.readFileContent(filePath);
    try {
      const data = JSON.parse(content) as CanvasData;
      return data;
    } catch (e) {
      throw new Error(`Invalid canvas data: ${filePath}`);
    }
  }

  private async _writeCanvasData(filePath: string, data: CanvasData): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await this.writeFileContent(filePath, content);
  }

  // Branch 1: Canvas File Operations

  async listCanvasFiles(dirPath = ""): Promise<string[]> {
    const normalizedPath = dirPath.endsWith("/") ? dirPath.slice(0, -1) : dirPath;
    const prefix = normalizedPath ? normalizedPath + "/" : "";
    const files = [
      ...new Set(
        this.app.vault
          .getFiles()
          .map((e) => e.path)
          .filter((filename) => filename.startsWith(prefix) && filename.endsWith(".canvas"))
          .map((filename) => {
            const subPath = filename.slice(prefix.length);
            if (subPath.indexOf("/") > -1) {
              return subPath.slice(0, subPath.indexOf("/") + 1);
            }
            return subPath;
          }),
      ),
    ];
    files.sort();
    return files;
  }

  async readCanvas(filePath: string): Promise<CanvasData> {
    return this._readCanvasData(filePath);
  }

  async writeCanvas(filePath: string, data: CanvasData): Promise<CanvasData> {
    await this._writeCanvasData(filePath, data);
    return data;
  }

  async deleteCanvas(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) {
      throw new Error(`File not found: ${filePath}`);
    }
    await this.app.vault.delete(file);
  }

  async searchCanvases(query: string, dirPath = ""): Promise<Array<{ path: string; matches: number }>> {
    const normalizedPath = dirPath.endsWith("/") ? dirPath.slice(0, -1) : dirPath;
    const prefix = normalizedPath ? normalizedPath + "/" : "";
    const results: Array<{ path: string; matches: number }> = [];

    for (const file of this.app.vault.getFiles()) {
      if (!file.path.startsWith(prefix) || !file.path.endsWith(".canvas")) continue;

      try {
        const content = await this.readFileContent(file.path);
        const matches = (content.match(new RegExp(query, "gi")) || []).length;
        if (matches > 0) {
          results.push({ path: file.path, matches });
        }
      } catch {
        // Skip files that can't be read
      }
    }

    results.sort((a, b) => b.matches - a.matches);
    return results;
  }

  // Branch 2: Canvas Metadata Operations

  async getCanvasStats(filePath: string): Promise<CanvasStats> {
    const data = await this._readCanvasData(filePath);

    const nodeCountByType: Record<string, number> = {};
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of data.nodes) {
      nodeCountByType[node.type] = (nodeCountByType[node.type] || 0) + 1;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }

    // Handle empty canvas
    if (data.nodes.length === 0) {
      minX = 0;
      minY = 0;
      maxX = 0;
      maxY = 0;
    }

    return {
      nodeCount: data.nodes.length,
      nodeCountByType,
      edgeCount: data.edges.length,
      boundingBox: {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX,
        height: maxY - minY,
      },
    };
  }

  // Branch 3: Canvas Card (Node) Operations

  async getCanvasNodes(filePath: string, typeFilter?: string): Promise<CanvasNode[]> {
    const data = await this._readCanvasData(filePath);
    if (typeFilter) {
      return data.nodes.filter((node) => node.type === typeFilter);
    }
    return data.nodes;
  }

  async getCanvasNode(filePath: string, nodeId: string): Promise<CanvasNode> {
    const data = await this._readCanvasData(filePath);
    const node = data.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Canvas node not found: ${nodeId}`);
    }
    return node;
  }

  async addCanvasNode(filePath: string, node: Omit<CanvasNode, "id">): Promise<CanvasNode> {
    const data = await this._readCanvasData(filePath);
    const newNode: CanvasNode = {
      ...node,
      id: this._generateCanvasId(),
    };
    data.nodes.push(newNode);
    await this._writeCanvasData(filePath, data);
    return newNode;
  }

  async updateCanvasNode(
    filePath: string,
    nodeId: string,
    updates: Partial<CanvasNode>,
  ): Promise<CanvasNode> {
    const data = await this._readCanvasData(filePath);
    const node = data.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Canvas node not found: ${nodeId}`);
    }
    const updated = { ...node, ...updates, id: node.id };
    const index = data.nodes.indexOf(node);
    data.nodes[index] = updated;
    await this._writeCanvasData(filePath, data);
    return updated;
  }

  async deleteCanvasNode(filePath: string, nodeId: string, deleteEdges = false): Promise<void> {
    const data = await this._readCanvasData(filePath);
    const nodeIndex = data.nodes.findIndex((n) => n.id === nodeId);
    if (nodeIndex === -1) {
      throw new Error(`Canvas node not found: ${nodeId}`);
    }
    data.nodes.splice(nodeIndex, 1);

    if (deleteEdges) {
      data.edges = data.edges.filter((e) => e.fromNode !== nodeId && e.toNode !== nodeId);
    }

    await this._writeCanvasData(filePath, data);
  }

  // Branch 4: Canvas Line (Edge) Operations

  async getCanvasEdges(filePath: string): Promise<CanvasEdge[]> {
    const data = await this._readCanvasData(filePath);
    return data.edges;
  }

  async getCanvasEdge(filePath: string, edgeId: string): Promise<CanvasEdge> {
    const data = await this._readCanvasData(filePath);
    const edge = data.edges.find((e) => e.id === edgeId);
    if (!edge) {
      throw new Error(`Canvas edge not found: ${edgeId}`);
    }
    return edge;
  }

  async addCanvasEdge(filePath: string, edge: Omit<CanvasEdge, "id">): Promise<CanvasEdge> {
    const data = await this._readCanvasData(filePath);
    const newEdge: CanvasEdge = {
      ...edge,
      id: this._generateCanvasId(),
    };
    data.edges.push(newEdge);
    await this._writeCanvasData(filePath, data);
    return newEdge;
  }

  async updateCanvasEdge(
    filePath: string,
    edgeId: string,
    updates: Partial<CanvasEdge>,
  ): Promise<CanvasEdge> {
    const data = await this._readCanvasData(filePath);
    const edge = data.edges.find((e) => e.id === edgeId);
    if (!edge) {
      throw new Error(`Canvas edge not found: ${edgeId}`);
    }
    const updated = { ...edge, ...updates, id: edge.id };
    const index = data.edges.indexOf(edge);
    data.edges[index] = updated;
    await this._writeCanvasData(filePath, data);
    return updated;
  }

  async deleteCanvasEdge(filePath: string, edgeId: string): Promise<void> {
    const data = await this._readCanvasData(filePath);
    const edgeIndex = data.edges.findIndex((e) => e.id === edgeId);
    if (edgeIndex === -1) {
      throw new Error(`Canvas edge not found: ${edgeId}`);
    }
    data.edges.splice(edgeIndex, 1);
    await this._writeCanvasData(filePath, data);
  }

  // Branch 5: Canvas Region (Group) Operations

  private _getNodesInBounds(
    nodes: CanvasNode[],
    bounds: { x: number; y: number; width: number; height: number },
  ): CanvasNode[] {
    return nodes.filter((node) => {
      const nodeRight = node.x + node.width;
      const nodeBottom = node.y + node.height;
      const boundsRight = bounds.x + bounds.width;
      const boundsBottom = bounds.y + bounds.height;

      return (
        node.x >= bounds.x &&
        node.y >= bounds.y &&
        nodeRight <= boundsRight &&
        nodeBottom <= boundsBottom
      );
    });
  }

  async getCanvasGroups(filePath: string): Promise<CanvasNode[]> {
    const data = await this._readCanvasData(filePath);
    return data.nodes.filter((node) => node.type === "group");
  }

  async getCanvasGroup(
    filePath: string,
    groupId: string,
  ): Promise<{ group: CanvasNode; containedNodes: CanvasNode[] }> {
    const data = await this._readCanvasData(filePath);
    const group = data.nodes.find((n) => n.id === groupId && n.type === "group");
    if (!group) {
      throw new Error(`Canvas group not found: ${groupId}`);
    }
    const containedNodes = this._getNodesInBounds(
      data.nodes.filter((n) => n.id !== groupId),
      { x: group.x, y: group.y, width: group.width, height: group.height },
    );
    return { group, containedNodes };
  }

  async addCanvasGroup(
    filePath: string,
    group: Omit<CanvasNode, "id" | "type">,
  ): Promise<CanvasNode> {
    const data = await this._readCanvasData(filePath);
    const newGroup: CanvasNode = {
      ...group,
      id: this._generateCanvasId(),
      type: "group",
    };
    data.nodes.push(newGroup);
    await this._writeCanvasData(filePath, data);
    return newGroup;
  }

  async updateCanvasGroup(
    filePath: string,
    groupId: string,
    updates: Partial<CanvasNode>,
  ): Promise<CanvasNode> {
    const data = await this._readCanvasData(filePath);
    const group = data.nodes.find((n) => n.id === groupId && n.type === "group");
    if (!group) {
      throw new Error(`Canvas group not found: ${groupId}`);
    }
    const updated = { ...group, ...updates, id: group.id, type: "group" };
    const index = data.nodes.indexOf(group);
    data.nodes[index] = updated;
    await this._writeCanvasData(filePath, data);
    return updated;
  }

  async deleteCanvasGroup(filePath: string, groupId: string): Promise<void> {
    const data = await this._readCanvasData(filePath);
    const groupIndex = data.nodes.findIndex((n) => n.id === groupId && n.type === "group");
    if (groupIndex === -1) {
      throw new Error(`Canvas group not found: ${groupId}`);
    }
    data.nodes.splice(groupIndex, 1);
    await this._writeCanvasData(filePath, data);
  }
}
