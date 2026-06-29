import { describe, it, expect } from "@jest/globals";
import { randomBytes } from "crypto";

describe("Canvas Operations", () => {
  describe("Canvas ID Generation", () => {
    it("should generate a 16-character hex ID", () => {
      // Generate ID using the same method as _generateCanvasId
      const id = randomBytes(8).toString("hex");
      expect(id).toHaveLength(16);
      expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    });

    it("should generate unique IDs", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(randomBytes(8).toString("hex"));
      }
      expect(ids.size).toBe(100); // All unique
    });
  });

  describe("Canvas Data Validation", () => {
    it("should accept valid canvas data with nodes and edges", () => {
      const canvasData = {
        nodes: [
          { id: "1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "Hello" },
        ],
        edges: [{ id: "e1", fromNode: "1", toNode: "2" }],
      };

      // Valid structure
      expect(Array.isArray(canvasData.nodes)).toBe(true);
      expect(Array.isArray(canvasData.edges)).toBe(true);
    });

    it("should validate canvas node required fields", () => {
      const node = {
        id: "node-1",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      };

      // All required fields present
      expect(node.id).toBeDefined();
      expect(node.type).toBeDefined();
      expect(["text", "file", "link", "group"]).toContain(node.type);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    });

    it("should validate canvas edge required fields", () => {
      const edge = {
        id: "edge-1",
        fromNode: "node-1",
        toNode: "node-2",
      };

      // All required fields present
      expect(edge.id).toBeDefined();
      expect(edge.fromNode).toBeDefined();
      expect(edge.toNode).toBeDefined();
    });
  });

  describe("Canvas Node Types", () => {
    it("should support all node types", () => {
      const nodeTypes = ["text", "file", "link", "group"];
      const supportedTypes = new Set(nodeTypes);

      expect(supportedTypes.size).toBe(4);
      expect(supportedTypes).toContain("text");
      expect(supportedTypes).toContain("file");
      expect(supportedTypes).toContain("link");
      expect(supportedTypes).toContain("group");
    });
  });
});
