import { request } from './client';
import { TEST_DIR } from './fixtures';

const TEST_CANVAS_PATH = `${TEST_DIR}/test-canvas.canvas`;
const TEST_CANVAS_DIR = TEST_DIR;

describe('Canvas Operations', () => {
  // Branch 1: Canvas File Operations
  describe('Canvas File Operations', () => {
    it('should create a new canvas file', async () => {
      const response = await request('PUT', `canvas/${TEST_CANVAS_PATH}`, {
        nodes: [],
        edges: [],
      });

      expect(response.statusCode).toBe(200);
      expect(response.json?.nodes).toBeDefined();
      expect(response.json?.edges).toBeDefined();
    });

    it('should read a canvas file', async () => {
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}`);

      expect(response.statusCode).toBe(200);
      expect(response.json?.nodes).toBeDefined();
      expect(response.json?.edges).toBeDefined();
    });

    it('should list canvas files in a directory', async () => {
      const response = await request('GET', `canvas/${TEST_CANVAS_DIR}`);

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json?.files)).toBe(true);
      expect(response.json?.files?.some((f: string) => f.includes('.canvas'))).toBe(true);
    });

    it('should delete a canvas file', async () => {
      const tempPath = `${TEST_DIR}/temp-canvas.canvas`;

      // Create first
      await request('PUT', `canvas/${tempPath}`, {
        nodes: [],
        edges: [],
      });

      // Delete
      const response = await request('DELETE', `canvas/${tempPath}`);
      expect(response.statusCode).toBe(204);
    });

    it('should search canvas files', async () => {
      const response = await request('POST', 'canvas/search/', {
        query: 'canvas',
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json?.results)).toBe(true);
    });
  });

  // Branch 2: Canvas Metadata Operations
  describe('Canvas Metadata Operations', () => {
    it('should get canvas stats', async () => {
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/stats`);

      expect(response.statusCode).toBe(200);
      expect(response.json?.nodeCount).toBeDefined();
      expect(response.json?.nodeCountByType).toBeDefined();
      expect(response.json?.edgeCount).toBeDefined();
      expect(response.json?.boundingBox).toBeDefined();
    });
  });

  // Branch 3: Canvas Node Operations
  describe('Canvas Node Operations', () => {
    it('should list nodes in a canvas', async () => {
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/nodes`);

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json?.nodes)).toBe(true);
    });

    it('should filter nodes by type', async () => {
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/nodes?type=text`);

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json?.nodes)).toBe(true);
    });

    it('should create a new node', async () => {
      const response = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        text: 'Test Node',
      });

      expect(response.statusCode).toBe(201);
      expect(response.json?.id).toBeDefined();
      expect(response.json?.type).toBe('text');
    });

    it('should get a specific node', async () => {
      // Create a node first
      const createResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        text: 'Test Node',
      });

      const nodeId = createResponse.json?.id;

      // Get the node
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/nodes/${nodeId}`);

      expect(response.statusCode).toBe(200);
      expect(response.json?.id).toBe(nodeId);
    });

    it('should update a node', async () => {
      // Create a node first
      const createResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        text: 'Test Node',
      });

      const nodeId = createResponse.json?.id;

      // Update the node
      const response = await request('PUT', `canvas/${TEST_CANVAS_PATH}/nodes/${nodeId}`, {
        text: 'Updated Node',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json?.text).toBe('Updated Node');
    });

    it('should delete a node', async () => {
      // Create a node first
      const createResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        text: 'Test Node',
      });

      const nodeId = createResponse.json?.id;

      // Delete the node
      const response = await request('DELETE', `canvas/${TEST_CANVAS_PATH}/nodes/${nodeId}`);

      expect(response.statusCode).toBe(204);
    });
  });

  // Branch 4: Canvas Edge Operations
  describe('Canvas Edge Operations', () => {
    let fromNodeId: string;
    let toNodeId: string;

    beforeAll(async () => {
      // Create two nodes for edge operations
      const node1 = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        text: 'Node 1',
      });

      const node2 = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 200,
        y: 20,
        width: 100,
        height: 100,
        text: 'Node 2',
      });

      fromNodeId = node1.json?.id;
      toNodeId = node2.json?.id;
    });

    it('should list edges in a canvas', async () => {
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/edges`);

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json?.edges)).toBe(true);
    });

    it('should create a new edge', async () => {
      const response = await request('POST', `canvas/${TEST_CANVAS_PATH}/edges`, {
        fromNode: fromNodeId,
        toNode: toNodeId,
        fromSide: 'right',
        toSide: 'left',
      });

      expect(response.statusCode).toBe(201);
      expect(response.json?.id).toBeDefined();
      expect(response.json?.fromNode).toBe(fromNodeId);
      expect(response.json?.toNode).toBe(toNodeId);
    });

    it('should get a specific edge', async () => {
      // Create an edge first
      const createResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/edges`, {
        fromNode: fromNodeId,
        toNode: toNodeId,
      });

      const edgeId = createResponse.json?.id;

      // Get the edge
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/edges/${edgeId}`);

      expect(response.statusCode).toBe(200);
      expect(response.json?.id).toBe(edgeId);
    });

    it('should update an edge', async () => {
      // Create an edge first
      const createResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/edges`, {
        fromNode: fromNodeId,
        toNode: toNodeId,
      });

      const edgeId = createResponse.json?.id;

      // Update the edge
      const response = await request('PUT', `canvas/${TEST_CANVAS_PATH}/edges/${edgeId}`, {
        label: 'updated edge',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json?.label).toBe('updated edge');
    });

    it('should delete an edge', async () => {
      // Create an edge first
      const createResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/edges`, {
        fromNode: fromNodeId,
        toNode: toNodeId,
      });

      const edgeId = createResponse.json?.id;

      // Delete the edge
      const response = await request('DELETE', `canvas/${TEST_CANVAS_PATH}/edges/${edgeId}`);

      expect(response.statusCode).toBe(204);
    });
  });

  // Branch 5: Canvas Group Operations
  describe('Canvas Group Operations', () => {
    it('should list groups in a canvas', async () => {
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/groups`);

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json?.groups)).toBe(true);
    });

    it('should create a new group', async () => {
      const response = await request('POST', `canvas/${TEST_CANVAS_PATH}/groups`, {
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        label: 'Test Group',
        color: '#ff0000',
      });

      expect(response.statusCode).toBe(201);
      expect(response.json?.id).toBeDefined();
      expect(response.json?.type).toBe('group');
      expect(response.json?.label).toBe('Test Group');
    });

    it('should get a group with contained nodes', async () => {
      // Create a group
      const groupResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/groups`, {
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        label: 'Container Group',
      });

      const groupId = groupResponse.json?.id;

      // Create a node inside the group bounds
      await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 50,
        y: 50,
        width: 100,
        height: 100,
        text: 'Contained Node',
      });

      // Get the group
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/groups/${groupId}`);

      expect(response.statusCode).toBe(200);
      expect(response.json?.group?.id).toBe(groupId);
      expect(Array.isArray(response.json?.containedNodes)).toBe(true);
    });

    it('should update a group', async () => {
      // Create a group first
      const createResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/groups`, {
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        label: 'Test Group',
      });

      const groupId = createResponse.json?.id;

      // Update the group
      const response = await request('PUT', `canvas/${TEST_CANVAS_PATH}/groups/${groupId}`, {
        label: 'Updated Group',
        color: '#00ff00',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json?.label).toBe('Updated Group');
      expect(response.json?.color).toBe('#00ff00');
    });

    it('should delete a group', async () => {
      // Create a group first
      const createResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/groups`, {
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        label: 'Test Group',
      });

      const groupId = createResponse.json?.id;

      // Delete the group
      const response = await request('DELETE', `canvas/${TEST_CANVAS_PATH}/groups/${groupId}`);

      expect(response.statusCode).toBe(204);
    });

    it('should detect spatial containment correctly', async () => {
      // Create a group
      const groupResponse = await request('POST', `canvas/${TEST_CANVAS_PATH}/groups`, {
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        label: 'Boundary Test Group',
      });

      const groupId = groupResponse.json?.id;

      // Create nodes with different positions
      // Node inside
      const insideNode = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 120,
        y: 120,
        width: 50,
        height: 50,
        text: 'Inside',
      });

      // Node partially outside
      const partialNode = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 200,
        y: 200,
        width: 150,
        height: 150,
        text: 'Partial',
      });

      // Node completely outside
      const outsideNode = await request('POST', `canvas/${TEST_CANVAS_PATH}/nodes`, {
        type: 'text',
        x: 400,
        y: 400,
        width: 50,
        height: 50,
        text: 'Outside',
      });

      // Get group with contained nodes
      const response = await request('GET', `canvas/${TEST_CANVAS_PATH}/groups/${groupId}`);

      expect(response.statusCode).toBe(200);
      const containedIds = response.json?.containedNodes?.map((n: any) => n.id);

      // Only the inside node should be contained (fully within bounds)
      expect(containedIds).toContain(insideNode.json?.id);
      expect(containedIds).not.toContain(partialNode.json?.id);
      expect(containedIds).not.toContain(outsideNode.json?.id);
    });
  });
});
