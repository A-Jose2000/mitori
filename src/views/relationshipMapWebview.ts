import { randomBytes } from 'node:crypto';
import dagre from 'dagre';
import * as vscode from 'vscode';

import { PostgresIntrospection } from '../db/introspection.js';
import type { DatabaseForeignKey, DatabaseTable } from '../db/types.js';
import { getErrorMessage } from '../utils/errors.js';
import { escapeHtml } from '../utils/html.js';

interface DatabaseGraphNode {
  id: string;
  schema: string;
  table: string;
  estimatedRowCount?: number;
  x: number;
  y: number;
}

interface DatabaseGraphEdge {
  source: string;
  target: string;
  label: string;
}

interface DatabaseGraph {
  nodes: DatabaseGraphNode[];
  edges: DatabaseGraphEdge[];
  hiddenTableCount: number;
}

export async function openRelationshipMapWebview(
  context: vscode.ExtensionContext,
  introspection: PostgresIntrospection,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'mitori.relationshipMap',
    'Mitori: Relationship Map',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = renderLoadingHtml(panel.webview);

  try {
    const [tables, relationships] = await Promise.all([
      introspection.getAllTables(),
      introspection.getAllForeignKeys(),
    ]);

    panel.webview.html = renderRelationshipMapHtml(
      panel.webview,
      context.extensionUri,
      tables,
      relationships,
    );
  } catch (error) {
    panel.webview.html = renderErrorHtml(panel.webview, getErrorMessage(error));
  }
}

function renderLoadingHtml(webview: vscode.Webview): string {
  return renderDocument(
    webview,
    'Loading relationship map',
    `<main><h1>Relationship Map</h1><p class="muted">Loading database relationships...</p></main>`,
  );
}

function renderErrorHtml(webview: vscode.Webview, message: string): string {
  return renderDocument(
    webview,
    'Could not load relationship map',
    `<main><h1>Relationship Map</h1><p class="error">${escapeHtml(message)}</p></main>`,
  );
}

function renderRelationshipMapHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  tables: DatabaseTable[],
  relationships: DatabaseForeignKey[],
): string {
  const visibleTables = tables.filter((table) => !isHiddenByDefault(table));
  const visibleTableIds = new Set(visibleTables.map((table) => getTableNodeId(table.schema, table.name)));
  const visibleRelationships = relationships.filter((relationship) => {
    const sourceId = getTableNodeId(relationship.schema, relationship.table);
    const targetId = getTableNodeId(relationship.referencedSchema, relationship.referencedTable);
    return visibleTableIds.has(sourceId) && visibleTableIds.has(targetId);
  });
  const schemas = new Set(visibleTables.map((table) => table.schema));
  const hiddenTableCount = tables.length - visibleTables.length;
  const graph = createDatabaseGraph(visibleTables, visibleRelationships, hiddenTableCount);
  const emptyState =
    visibleTables.length === 0
      ? '<div class="graph-empty">No tables found in user schemas.</div>'
      : visibleRelationships.length === 0
        ? '<div class="graph-empty muted">No foreign key connections discovered. Isolated tables are still shown.</div>'
        : '';
  const hiddenSummary =
    hiddenTableCount > 0
      ? `<p class="muted">${escapeHtml(hiddenTableCount)} migration/system tables hidden by default.</p>`
      : '';

  return renderDocument(
    webview,
    'Relationship Map',
    `
      <main>
        <header>
          <div>
            <h1>Relationship Map</h1>
            <p class="muted">Domain tables and foreign key connections, arranged automatically.</p>
            ${hiddenSummary}
          </div>
          <div class="summary">
            ${renderSummaryStat('Tables', visibleTables.length)}
            ${renderSummaryStat('Schemas', schemas.size)}
            ${renderSummaryStat('Connections', visibleRelationships.length)}
            ${renderSummaryStat('Hidden', hiddenTableCount)}
          </div>
        </header>

        <section class="graph-shell">
          <div class="graph-toolbar">
            <div class="graph-title">
              <h2>All Tables</h2>
              <p class="muted">Drag nodes or pan the canvas. Use wheel or buttons to zoom.</p>
            </div>
            <div class="graph-controls">
              <button type="button" class="icon-button" data-graph-action="zoom-out" title="Zoom out" aria-label="Zoom out">-</button>
              <button type="button" class="icon-button" data-graph-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
              <button type="button" class="icon-button reset-button" data-graph-action="reset" title="Reset view" aria-label="Reset view">100%</button>
            </div>
          </div>
          <div class="graph-stage">
            <svg class="relationship-canvas" data-relationship-graph viewBox="0 0 920 580" role="img" aria-label="Database relationship graph"></svg>
            ${emptyState}
          </div>
        </section>
      </main>
    `,
    extensionUri,
    renderGraphScript(graph),
  );
}

function renderSummaryStat(label: string, value: number): string {
  return `
    <div class="stat">
      <span class="stat-value">${escapeHtml(formatNumber(value))}</span>
      <span class="stat-label">${escapeHtml(label)}</span>
    </div>
  `;
}

function createDatabaseGraph(
  tables: DatabaseTable[],
  relationships: DatabaseForeignKey[],
  hiddenTableCount: number,
): DatabaseGraph {
  const nodesById = new Map<string, DatabaseGraphNode>();

  for (const table of tables) {
    const id = getTableNodeId(table.schema, table.name);
    nodesById.set(id, {
      id,
      schema: table.schema,
      table: table.name,
      estimatedRowCount: table.estimatedRowCount,
      x: 0,
      y: 0,
    });
  }

  const edges = relationships.map((relationship) => {
    const source = getTableNodeId(relationship.schema, relationship.table);
    const target = getTableNodeId(relationship.referencedSchema, relationship.referencedTable);

    if (!nodesById.has(source)) {
      nodesById.set(source, {
        id: source,
        schema: relationship.schema,
        table: relationship.table,
        x: 0,
        y: 0,
      });
    }

    if (!nodesById.has(target)) {
      nodesById.set(target, {
        id: target,
        schema: relationship.referencedSchema,
        table: relationship.referencedTable,
        x: 0,
        y: 0,
      });
    }

    return {
      source,
      target,
      label: `${relationship.columnName} -> ${relationship.referencedColumn}`,
    };
  });

  layoutDatabaseGraph(nodesById, edges);

  return {
    nodes: Array.from(nodesById.values()),
    edges,
    hiddenTableCount,
  };
}

function layoutDatabaseGraph(nodesById: Map<string, DatabaseGraphNode>, edges: DatabaseGraphEdge[]): void {
  if (nodesById.size === 0) {
    return;
  }

  const graph = new dagre.graphlib.Graph({ directed: true, multigraph: true });
  graph.setGraph({
    rankdir: 'LR',
    align: 'UL',
    nodesep: 54,
    edgesep: 18,
    ranksep: 118,
    marginx: 30,
    marginy: 30,
    acyclicer: 'greedy',
    ranker: 'network-simplex',
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of Array.from(nodesById.values()).sort((a, b) => a.id.localeCompare(b.id))) {
    graph.setNode(node.id, {
      width: 220,
      height: 78,
    });
  }

  edges.forEach((edge, index) => {
    graph.setEdge(
      edge.source,
      edge.target,
      {
        width: 20,
        height: 16,
        weight: 1,
      },
      `${edge.source}->${edge.target}:${index}`,
    );
  });

  dagre.layout(graph);

  const laidOutNodes = graph.nodes().map((id) => ({ id, position: graph.node(id) as { x: number; y: number } }));
  const minX = Math.min(...laidOutNodes.map((node) => node.position.x));
  const maxX = Math.max(...laidOutNodes.map((node) => node.position.x));
  const minY = Math.min(...laidOutNodes.map((node) => node.position.y));
  const maxY = Math.max(...laidOutNodes.map((node) => node.position.y));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  laidOutNodes.forEach(({ id, position }) => {
    const node = nodesById.get(id);

    if (!node) {
      return;
    }

    node.x = position.x - centerX;
    node.y = position.y - centerY;
  });
}

function isHiddenByDefault(table: DatabaseTable): boolean {
  const tableName = table.name.toLowerCase();

  return [
    '_prisma_migrations',
    'drizzle_migrations',
    'knex_migrations',
    'knex_migrations_lock',
    'schema_migrations',
    'sequelize_meta',
  ].includes(tableName);
}

function renderGraphScript(graph: DatabaseGraph): string {
  return `
(function () {
  const graph = ${serializeForScript(graph)};
  const svg = document.querySelector('[data-relationship-graph]');

  if (!svg || graph.nodes.length === 0) {
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const nodeWidth = 220;
  const nodeHeight = 78;
  const nodeById = new Map(graph.nodes.map(function (node) {
    return [node.id, node];
  }));
  const connectedNodeIdsByNodeId = new Map();
  const connectedEdgesByNodeId = new Map();
  const state = {
    x: 460,
    y: 290,
    scale: 1
  };
  let activeDrag = null;

  graph.nodes.forEach(function (node) {
    connectedNodeIdsByNodeId.set(node.id, new Set([node.id]));
    connectedEdgesByNodeId.set(node.id, new Set());
  });

  graph.edges.forEach(function (edge, index) {
    const edgeId = getEdgeId(edge, index);
    ensureSet(connectedNodeIdsByNodeId, edge.source).add(edge.target);
    ensureSet(connectedNodeIdsByNodeId, edge.target).add(edge.source);
    ensureSet(connectedEdgesByNodeId, edge.source).add(edgeId);
    ensureSet(connectedEdgesByNodeId, edge.target).add(edgeId);
  });

  const viewport = createSvgElement('g', { class: 'graph-viewport' });
  svg.append(createDefs(), viewport);
  render();
  updateTransform();

  document.querySelectorAll('[data-graph-action]').forEach(function (button) {
    button.addEventListener('click', function () {
      const action = button.getAttribute('data-graph-action');

      if (action === 'zoom-in') {
        zoomAtCenter(1.18);
      } else if (action === 'zoom-out') {
        zoomAtCenter(0.84);
      } else if (action === 'reset') {
        state.x = 460;
        state.y = 290;
        state.scale = 1;
        updateTransform();
      }
    });
  });

  svg.addEventListener('wheel', function (event) {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.88 : 1.14;
    zoomAtPoint(factor, clientToSvgPoint(event));
  }, { passive: false });

  svg.addEventListener('pointerdown', function (event) {
    const target = event.target;
    const nodeElement = target && typeof target.closest === 'function' ? target.closest('.graph-node') : null;

    svg.setPointerCapture(event.pointerId);

    if (nodeElement) {
      activeDrag = {
        type: 'node',
        id: nodeElement.getAttribute('data-node-id'),
        lastPoint: clientToGraphPoint(event)
      };
    } else {
      activeDrag = {
        type: 'pan',
        lastClientX: event.clientX,
        lastClientY: event.clientY
      };
      svg.classList.add('is-panning');
    }

    event.preventDefault();
  });

  svg.addEventListener('pointermove', function (event) {
    if (!activeDrag) {
      return;
    }

    if (activeDrag.type === 'pan') {
      state.x += event.clientX - activeDrag.lastClientX;
      state.y += event.clientY - activeDrag.lastClientY;
      activeDrag.lastClientX = event.clientX;
      activeDrag.lastClientY = event.clientY;
      updateTransform();
      return;
    }

    const node = nodeById.get(activeDrag.id);
    const point = clientToGraphPoint(event);

    if (node) {
      node.x += point.x - activeDrag.lastPoint.x;
      node.y += point.y - activeDrag.lastPoint.y;
      activeDrag.lastPoint = point;
      render();
    }
  });

  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', function (event) {
    if (activeDrag && activeDrag.type === 'pan') {
      endDrag(event);
    }
  });

  function endDrag(event) {
    if (activeDrag) {
      activeDrag = null;
      svg.classList.remove('is-panning');
    }

    if (event && svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
  }

  function render() {
    viewport.replaceChildren();

    const gridLayer = createSvgElement('g', { class: 'graph-grid-layer' });
    gridLayer.append(createSvgElement('rect', {
      class: 'graph-grid',
      x: '-9000',
      y: '-9000',
      width: '18000',
      height: '18000'
    }));
    const edgeLayer = createSvgElement('g', { class: 'graph-edges' });
    const nodeLayer = createSvgElement('g', { class: 'graph-nodes' });
    viewport.append(gridLayer, edgeLayer, nodeLayer);

    graph.edges.forEach(function (edge, index) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);

      if (!source || !target) {
        return;
      }

      const group = createSvgElement('g', {
        class: 'graph-edge-group',
        'data-edge-id': getEdgeId(edge, index),
        'data-source-id': edge.source,
        'data-target-id': edge.target
      });
      const edgePath = createEdgePath(source, target);
      const hitPath = createSvgElement('path', {
        class: 'graph-edge-hit',
        d: edgePath
      });
      const path = createSvgElement('path', {
        class: 'graph-edge',
        d: edgePath,
        'marker-end': 'url(#mitori-relationship-arrow)'
      });
      const label = createSvgElement('text', {
        class: 'graph-edge-label',
        x: String((source.x + target.x) / 2),
        y: String((source.y + target.y) / 2 - 10)
      });
      label.textContent = edge.label;
      group.append(hitPath, path, label);
      edgeLayer.append(group);
    });

    graph.nodes.forEach(function (node) {
      const group = createSvgElement('g', {
        class: 'graph-node',
        'data-node-id': node.id,
        transform: 'translate(' + (node.x - nodeWidth / 2) + ' ' + (node.y - nodeHeight / 2) + ')'
      });
      const rect = createSvgElement('rect', {
        width: String(nodeWidth),
        height: String(nodeHeight),
        rx: '8',
        ry: '8'
      });
      const tableName = createSvgElement('text', {
        class: 'graph-node-title',
        x: '14',
        y: '30'
      });
      const schemaName = createSvgElement('text', {
        class: 'graph-node-subtitle',
        x: '14',
        y: '52'
      });
      tableName.textContent = node.table;
      schemaName.textContent = node.estimatedRowCount === undefined
        ? node.schema
        : node.schema + ' · ~' + formatNumber(node.estimatedRowCount) + ' rows';
      group.append(rect, tableName, schemaName);
      nodeLayer.append(group);
    });

    bindFocusEvents();
  }

  function bindFocusEvents() {
    viewport.querySelectorAll('.graph-node').forEach(function (nodeElement) {
      nodeElement.addEventListener('mouseenter', function () {
        focusNode(nodeElement.getAttribute('data-node-id'));
      });
      nodeElement.addEventListener('mouseleave', clearFocus);
    });

    viewport.querySelectorAll('.graph-edge-group').forEach(function (edgeElement) {
      edgeElement.addEventListener('mouseenter', function () {
        focusEdge(
          edgeElement.getAttribute('data-edge-id'),
          edgeElement.getAttribute('data-source-id'),
          edgeElement.getAttribute('data-target-id')
        );
      });
      edgeElement.addEventListener('mouseleave', clearFocus);
    });
  }

  function focusNode(nodeId) {
    if (!nodeId) {
      return;
    }

    const connectedNodes = connectedNodeIdsByNodeId.get(nodeId) || new Set([nodeId]);
    const connectedEdges = connectedEdgesByNodeId.get(nodeId) || new Set();
    applyFocus(connectedNodes, connectedEdges);
  }

  function focusEdge(edgeId, sourceId, targetId) {
    if (!edgeId || !sourceId || !targetId) {
      return;
    }

    applyFocus(new Set([sourceId, targetId]), new Set([edgeId]));
  }

  function applyFocus(nodeIds, edgeIds) {
    svg.classList.add('has-graph-focus');

    viewport.querySelectorAll('.graph-node').forEach(function (nodeElement) {
      const isFocused = nodeIds.has(nodeElement.getAttribute('data-node-id'));
      nodeElement.classList.toggle('is-focused', isFocused);
      nodeElement.classList.toggle('is-dimmed', !isFocused);
    });

    viewport.querySelectorAll('.graph-edge-group').forEach(function (edgeElement) {
      const isFocused = edgeIds.has(edgeElement.getAttribute('data-edge-id'));
      edgeElement.classList.toggle('is-focused', isFocused);
      edgeElement.classList.toggle('is-dimmed', !isFocused);
    });
  }

  function clearFocus() {
    svg.classList.remove('has-graph-focus');

    viewport.querySelectorAll('.is-focused, .is-dimmed').forEach(function (element) {
      element.classList.remove('is-focused', 'is-dimmed');
    });
  }

  function getEdgeId(edge, index) {
    return edge.source + '->' + edge.target + ':' + index;
  }

  function ensureSet(map, key) {
    if (!map.has(key)) {
      map.set(key, new Set());
    }

    return map.get(key);
  }

  function createDefs() {
    const defs = createSvgElement('defs');
    const pattern = createSvgElement('pattern', {
      id: 'mitori-grid-dots',
      width: '32',
      height: '32',
      patternUnits: 'userSpaceOnUse'
    });
    const dot = createSvgElement('circle', {
      class: 'graph-grid-dot',
      cx: '1',
      cy: '1',
      r: '1.25'
    });
    const marker = createSvgElement('marker', {
      id: 'mitori-relationship-arrow',
      markerWidth: '10',
      markerHeight: '10',
      refX: '9',
      refY: '3',
      orient: 'auto',
      markerUnits: 'strokeWidth'
    });
    const markerPath = createSvgElement('path', {
      d: 'M 0 0 L 9 3 L 0 6 z',
      class: 'graph-arrow'
    });
    pattern.append(dot);
    marker.append(markerPath);
    defs.append(pattern, marker);
    return defs;
  }

  function createEdgePath(source, target) {
    if (source.id === target.id) {
      const top = source.y - nodeHeight / 2;
      return 'M ' + (source.x + 40) + ' ' + top +
        ' C ' + (source.x + 210) + ' ' + (top - 130) +
        ', ' + (source.x - 210) + ' ' + (top - 130) +
        ', ' + (source.x - 40) + ' ' + top;
    }

    const direction = target.x >= source.x ? 1 : -1;
    const startX = source.x + direction * nodeWidth / 2;
    const endX = target.x - direction * nodeWidth / 2;
    const startY = source.y;
    const endY = target.y;
    const curve = Math.max(90, Math.abs(endX - startX) * 0.45);

    return 'M ' + startX + ' ' + startY +
      ' C ' + (startX + direction * curve) + ' ' + startY +
      ', ' + (endX - direction * curve) + ' ' + endY +
      ', ' + endX + ' ' + endY;
  }

  function zoomAtCenter(factor) {
    zoomAtPoint(factor, { x: 460, y: 290 });
  }

  function zoomAtPoint(factor, point) {
    const graphPoint = {
      x: (point.x - state.x) / state.scale,
      y: (point.y - state.y) / state.scale
    };
    state.scale = clamp(state.scale * factor, 0.25, 3.2);
    state.x = point.x - graphPoint.x * state.scale;
    state.y = point.y - graphPoint.y * state.scale;
    updateTransform();
  }

  function updateTransform() {
    viewport.setAttribute('transform', 'translate(' + state.x + ' ' + state.y + ') scale(' + state.scale + ')');
  }

  function clientToGraphPoint(event) {
    const point = clientToSvgPoint(event);
    return {
      x: (point.x - state.x) / state.scale,
      y: (point.y - state.y) / state.scale
    };
  }

  function clientToSvgPoint(event) {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;

    if (!rect.width || !rect.height) {
      return { x: 460, y: 290 };
    }

    return {
      x: ((event.clientX - rect.left) / rect.width) * viewBox.width + viewBox.x,
      y: ((event.clientY - rect.top) / rect.height) * viewBox.height + viewBox.y
    };
  }

  function createSvgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);

    Object.entries(attributes || {}).forEach(function (entry) {
      element.setAttribute(entry[0], entry[1]);
    });

    return element;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(value);
  }
})();
`;
}

function renderDocument(
  webview: vscode.Webview,
  title: string,
  body: string,
  extensionUri?: vscode.Uri,
  script?: string,
): string {
  const cspSource = webview.cspSource;
  const resourceComment = extensionUri ? `<!-- ${escapeHtml(extensionUri.toString())} -->` : '';
  const nonce = getNonce();
  const scriptTag = script ? `<script nonce="${nonce}">${script}</script>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      padding: 0;
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    main {
      max-width: none;
      margin: 0;
      padding: 20px;
    }

    header {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) auto;
      gap: 20px;
      align-items: start;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 16px;
      margin-bottom: 16px;
    }

    h1,
    h2,
    p {
      margin-top: 0;
    }

    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 6px;
    }

    h2 {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .muted,
    .empty {
      color: var(--vscode-descriptionForeground);
    }

    .error {
      color: var(--vscode-errorForeground);
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(92px, 1fr));
      gap: 8px;
    }

    .stat {
      border: 1px solid var(--vscode-panel-border);
      padding: 8px 10px;
      min-width: 92px;
    }

    .stat-value,
    .stat-label {
      display: block;
    }

    .stat-value {
      font-size: 17px;
      font-weight: 600;
      line-height: 1.2;
    }

    .stat-label {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-top: 2px;
    }

    .graph-shell {
      border: 1px solid var(--vscode-panel-border);
      min-height: calc(100vh - 150px);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .graph-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }

    .graph-title h2,
    .graph-title p {
      margin-bottom: 0;
    }

    .graph-controls {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .icon-button {
      min-width: 30px;
      height: 28px;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font: inherit;
      line-height: 1;
    }

    .icon-button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .reset-button {
      min-width: 48px;
      font-size: 11px;
    }

    .graph-stage {
      position: relative;
      min-height: calc(100vh - 206px);
      overflow: hidden;
      background-color: var(--vscode-editor-background);
    }

    .relationship-canvas {
      display: block;
      width: 100%;
      height: calc(100vh - 206px);
      min-height: 560px;
      cursor: grab;
      touch-action: none;
      user-select: none;
    }

    .relationship-canvas.is-panning {
      cursor: grabbing;
    }

    .graph-grid {
      fill: url(#mitori-grid-dots);
    }

    .graph-grid-dot {
      fill: var(--vscode-panel-border);
      opacity: 0.8;
    }

    .graph-node {
      cursor: move;
      transition: opacity 120ms ease;
    }

    .graph-node rect {
      fill: var(--vscode-editorWidget-background);
      stroke: var(--vscode-textLink-foreground);
      stroke-width: 1.25;
      transition: stroke-width 120ms ease, stroke 120ms ease;
    }

    .graph-node.is-focused rect {
      stroke: var(--vscode-focusBorder);
      stroke-width: 2.2;
    }

    .graph-node-title {
      fill: var(--vscode-foreground);
      font-size: 14px;
      font-weight: 600;
      pointer-events: none;
    }

    .graph-node-subtitle {
      fill: var(--vscode-descriptionForeground);
      font-size: 12px;
      pointer-events: none;
    }

    .graph-edge {
      fill: none;
      stroke: var(--vscode-textLink-foreground);
      stroke-width: 1.35;
      opacity: 0.72;
      transition: opacity 120ms ease, stroke-width 120ms ease;
    }

    .graph-edge-group {
      transition: opacity 120ms ease;
    }

    .graph-edge-hit {
      fill: none;
      stroke: transparent;
      stroke-width: 16;
      pointer-events: stroke;
    }

    .graph-edge-group.is-focused .graph-edge {
      opacity: 1;
      stroke-width: 2.2;
    }

    .graph-arrow {
      fill: var(--vscode-textLink-foreground);
    }

    .graph-edge-label {
      fill: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-anchor: middle;
      opacity: 0;
      pointer-events: none;
      paint-order: stroke;
      stroke: var(--vscode-editor-background);
      stroke-width: 4px;
      stroke-linejoin: round;
      transition: opacity 120ms ease;
    }

    .graph-edge-group.is-focused .graph-edge-label {
      opacity: 1;
    }

    .relationship-canvas.has-graph-focus .graph-node.is-dimmed,
    .relationship-canvas.has-graph-focus .graph-edge-group.is-dimmed {
      opacity: 0.16;
    }

    .graph-empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--vscode-descriptionForeground);
      pointer-events: none;
    }

    @media (max-width: 760px) {
      main {
        padding: 14px;
      }

      header {
        grid-template-columns: 1fr;
      }

      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .graph-toolbar {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  ${resourceComment}
  ${body}
  ${scriptTag}
</body>
</html>`;
}

function getTableNodeId(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function getNonce(): string {
  return randomBytes(16).toString('base64');
}
