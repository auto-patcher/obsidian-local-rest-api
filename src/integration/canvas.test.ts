import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { App, Vault } from "obsidian";
import { CANVAS_TEST_PATH, CANVAS_FIXTURE_DATA, TEST_DIR } from "./fixtures";
import RequestHandler from "../requestHandler";

describe("Canvas Operations", () => {
  let app: App;
  let requestHandler: RequestHandler;
  let vault: Vault;

  beforeEach(async () => {
    // Note: Integration tests require a live Obsidian instance
    // This is a placeholder for actual integration testing
    if (!app) {
      console.log("Skipping canvas integration tests (Obsidian not available)");
      return;
    }
    vault = app.vault;

    // Create test directory
    const testDir = vault.getAbstractFileByPath(TEST_DIR);
    if (!testDir) {
      await vault.createFolder(TEST_DIR);
    }
  });

  afterEach(async () => {
    if (!app) return;
    // Clean up test canvas files
    try {
      const file = vault.getAbstractFileByPath(CANVAS_TEST_PATH);
      if (file) {
        await vault.delete(file);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe("Canvas Stats", () => {
    it("should calculate stats for a canvas with nodes and edges", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      const stats = await requestHandler.operations.getCanvasStats(CANVAS_TEST_PATH);

      // Verify node count
      expect(stats.nodeCount).toBe(4);

      // Verify node counts by type
      expect(stats.nodeCountByType).toEqual({
        text: 1,
        file: 1,
        link: 1,
        group: 1,
      });

      // Verify edge count
      expect(stats.edgeCount).toBe(2);

      // Verify bounding box
      expect(stats.boundingBox).toBeDefined();
      expect(stats.boundingBox.minX).toBe(0);
      expect(stats.boundingBox.minY).toBe(0);
      expect(stats.boundingBox.maxX).toBe(650); // rightmost node ends at 50 + 600
      expect(stats.boundingBox.maxY).toBe(500); // bottom-most node ends at 200 + 300
      expect(stats.boundingBox.width).toBe(650);
      expect(stats.boundingBox.height).toBe(500);
    });

    it("should handle empty canvas", async () => {
      if (!app) return;

      const emptyCanvas = { nodes: [], edges: [] };
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(emptyCanvas));

      const stats = await requestHandler.operations.getCanvasStats(CANVAS_TEST_PATH);

      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.nodeCountByType).toEqual({});
      expect(stats.boundingBox.minX).toBe(0);
      expect(stats.boundingBox.minY).toBe(0);
      expect(stats.boundingBox.maxX).toBe(0);
      expect(stats.boundingBox.maxY).toBe(0);
      expect(stats.boundingBox.width).toBe(0);
      expect(stats.boundingBox.height).toBe(0);
    });

    it("should throw for non-existent canvas file", async () => {
      if (!app) return;

      await expect(
        requestHandler.operations.getCanvasStats("nonexistent.canvas"),
      ).rejects.toThrow();
    });
  });

  describe("Canvas Edges", () => {
    it("should list all edges in a canvas", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      const edges = await requestHandler.operations.getCanvasEdges(CANVAS_TEST_PATH);

      expect(edges).toHaveLength(2);
      expect(edges[0].id).toBe("edge-1");
      expect(edges[0].fromNode).toBe("node-text-1");
      expect(edges[0].toNode).toBe("node-file-1");
      expect(edges[0].label).toBe("Test Edge 1");
      expect(edges[1].id).toBe("edge-2");
    });

    it("should get a single edge by ID", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      const edge = await requestHandler.operations.getCanvasEdge(CANVAS_TEST_PATH, "edge-1");

      expect(edge).toBeDefined();
      expect(edge.id).toBe("edge-1");
      expect(edge.fromNode).toBe("node-text-1");
      expect(edge.toNode).toBe("node-file-1");
      expect(edge.fromSide).toBe("right");
      expect(edge.toSide).toBe("left");
      expect(edge.toEnd).toBe("arrow");
      expect(edge.color).toBe("#0000FF");
      expect(edge.label).toBe("Test Edge 1");
    });

    it("should throw when getting non-existent edge", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      await expect(
        requestHandler.operations.getCanvasEdge(CANVAS_TEST_PATH, "nonexistent-edge"),
      ).rejects.toThrow();
    });

    it("should create a new edge between nodes", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      const newEdge = await requestHandler.operations.addCanvasEdge(CANVAS_TEST_PATH, {
        fromNode: "node-link-1",
        toNode: "node-text-1",
        fromSide: "top" as const,
        toSide: "bottom" as const,
        color: "#FF00FF",
        label: "New Edge",
      });

      expect(newEdge).toBeDefined();
      expect(newEdge.id).toBeDefined();
      expect(newEdge.fromNode).toBe("node-link-1");
      expect(newEdge.toNode).toBe("node-text-1");
      expect(newEdge.fromSide).toBe("top");
      expect(newEdge.toSide).toBe("bottom");
      expect(newEdge.color).toBe("#FF00FF");
      expect(newEdge.label).toBe("New Edge");

      // Verify edge was persisted
      const edges = await requestHandler.operations.getCanvasEdges(CANVAS_TEST_PATH);
      expect(edges).toHaveLength(3);
    });

    it("should throw when creating edge with non-existent node", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      await expect(
        requestHandler.operations.addCanvasEdge(CANVAS_TEST_PATH, {
          fromNode: "nonexistent-node",
          toNode: "node-text-1",
        }),
      ).rejects.toThrow();
    });

    it("should update edge properties", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      const updatedEdge = await requestHandler.operations.updateCanvasEdge(
        CANVAS_TEST_PATH,
        "edge-1",
        {
          color: "#FFFF00",
          label: "Updated Label",
          fromSide: "bottom" as const,
        },
      );

      expect(updatedEdge.id).toBe("edge-1");
      expect(updatedEdge.color).toBe("#FFFF00");
      expect(updatedEdge.label).toBe("Updated Label");
      expect(updatedEdge.fromSide).toBe("bottom");
      // Verify unchanged properties are preserved
      expect(updatedEdge.toSide).toBe("left");
      expect(updatedEdge.toEnd).toBe("arrow");

      // Verify edge was persisted
      const edge = await requestHandler.operations.getCanvasEdge(CANVAS_TEST_PATH, "edge-1");
      expect(edge.color).toBe("#FFFF00");
    });

    it("should delete an edge", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      await requestHandler.operations.deleteCanvasEdge(CANVAS_TEST_PATH, "edge-1");

      // Verify edge was deleted
      const edges = await requestHandler.operations.getCanvasEdges(CANVAS_TEST_PATH);
      expect(edges).toHaveLength(1);
      expect(edges[0].id).toBe("edge-2");

      // Verify accessing deleted edge throws
      await expect(
        requestHandler.operations.getCanvasEdge(CANVAS_TEST_PATH, "edge-1"),
      ).rejects.toThrow();
    });

    it("should throw when deleting non-existent edge", async () => {
      if (!app) return;

      // Create test canvas file
      await vault.create(CANVAS_TEST_PATH, JSON.stringify(CANVAS_FIXTURE_DATA));

      await expect(
        requestHandler.operations.deleteCanvasEdge(CANVAS_TEST_PATH, "nonexistent-edge"),
      ).rejects.toThrow();
    });
  });
});
