import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import { PostgresIntrospection } from '../db/introspection.js';
import type {
  DatabaseColumn,
  DatabaseForeignKey,
  DatabaseIndex,
  DatabaseTable,
  TablePreview,
  TableRelationships,
} from '../db/types.js';
import { getErrorMessage } from '../utils/errors.js';
import { escapeHtml } from '../utils/html.js';

interface RelationshipGraphNode {
  id: string;
  schema: string;
  table: string;
  kind: 'current' | 'inbound' | 'outbound' | 'both';
  x: number;
  y: number;
}

interface RelationshipGraphEdge {
  source: string;
  target: string;
  label: string;
  kind: 'inbound' | 'outbound';
}

interface RelationshipGraph {
  nodes: RelationshipGraphNode[];
  edges: RelationshipGraphEdge[];
}

type TableTab = 'columns' | 'preview' | 'relationships' | 'indexes';
type RelationshipTab = 'list' | 'canvas';

interface TableWebviewState {
  selectedTab: TableTab;
  relationshipTab: RelationshipTab;
}

interface OpenTableWebviewOptions extends Partial<TableWebviewState> {
  targetPanel?: vscode.WebviewPanel;
  reuseActive?: boolean;
}

interface OpenTableMessage {
  type: 'openTable';
  mode: 'same' | 'new';
  table: DatabaseTable;
  selectedTab?: TableTab;
  relationshipTab?: RelationshipTab;
}

interface TableStateChangedMessage extends Partial<TableWebviewState> {
  type: 'tableStateChanged';
}

let activeTablePanel: vscode.WebviewPanel | undefined;
const panelMessageHandlers = new WeakSet<vscode.WebviewPanel>();
const panelStates = new WeakMap<vscode.WebviewPanel, TableWebviewState>();

export async function openTableWebview(
  context: vscode.ExtensionContext,
  introspection: PostgresIntrospection,
  table: DatabaseTable,
  options: OpenTableWebviewOptions = {},
): Promise<void> {
  const panel = options.targetPanel ?? (options.reuseActive ? activeTablePanel : undefined) ?? createTablePanel();
  const previousState = panelStates.get(panel);
  const state = normalizeTableState({
    selectedTab: options.selectedTab ?? previousState?.selectedTab,
    relationshipTab: options.relationshipTab ?? previousState?.relationshipTab,
  });

  activeTablePanel = panel;
  attachTablePanelMessageHandler(context, introspection, panel);
  await renderTableIntoPanel(context, introspection, panel, table, state);
  panel.reveal(vscode.ViewColumn.One);
}

function createTablePanel(): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'mitori.tablePreview',
    'Mitori',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.onDidDispose(() => {
    if (activeTablePanel === panel) {
      activeTablePanel = undefined;
    }
  });

  panel.onDidChangeViewState((event) => {
    if (event.webviewPanel.visible) {
      activeTablePanel = event.webviewPanel;
    }
  });

  return panel;
}

function attachTablePanelMessageHandler(
  context: vscode.ExtensionContext,
  introspection: PostgresIntrospection,
  panel: vscode.WebviewPanel,
): void {
  if (panelMessageHandlers.has(panel)) {
    return;
  }

  panelMessageHandlers.add(panel);
  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (isTableStateChangedMessage(message)) {
      panelStates.set(panel, normalizeTableState(message));
      return;
    }

    if (!isOpenTableMessage(message)) {
      return;
    }

    const nextState = normalizeTableState({
      selectedTab: message.selectedTab,
      relationshipTab: message.relationshipTab,
    });

    if (message.mode === 'new') {
      await openTableWebview(context, introspection, message.table, nextState);
      return;
    }

    await openTableWebview(context, introspection, message.table, {
      ...nextState,
      targetPanel: panel,
    });
  });
}

async function renderTableIntoPanel(
  context: vscode.ExtensionContext,
  introspection: PostgresIntrospection,
  panel: vscode.WebviewPanel,
  table: DatabaseTable,
  state: TableWebviewState,
): Promise<void> {
  panel.title = `Mitori: ${table.name}`;
  panelStates.set(panel, state);
  panel.webview.html = renderLoadingHtml(panel.webview, table);

  try {
    const [columns, preview, relationships, indexes] = await Promise.all([
      introspection.getColumns(table.schema, table.name),
      introspection.getTablePreview(table.schema, table.name, 100),
      introspection.getTableRelationships(table.schema, table.name),
      introspection.getIndexes(table.schema, table.name),
    ]);

    panel.webview.html = renderTableHtml(
      panel.webview,
      context.extensionUri,
      table,
      columns,
      preview,
      relationships,
      indexes,
      state,
    );
  } catch (error) {
    panel.webview.html = renderErrorHtml(panel.webview, table, getErrorMessage(error));
  }
}

function normalizeTableState(state: Partial<TableWebviewState>): TableWebviewState {
  return {
    selectedTab: isTableTab(state.selectedTab) ? state.selectedTab : 'columns',
    relationshipTab: isRelationshipTab(state.relationshipTab) ? state.relationshipTab : 'list',
  };
}

function isOpenTableMessage(message: unknown): message is OpenTableMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Partial<OpenTableMessage>;
  return (
    candidate.type === 'openTable' &&
    (candidate.mode === 'same' || candidate.mode === 'new') &&
    Boolean(candidate.table) &&
    typeof candidate.table?.schema === 'string' &&
    typeof candidate.table?.name === 'string'
  );
}

function isTableStateChangedMessage(message: unknown): message is TableStateChangedMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Partial<TableStateChangedMessage>;
  return candidate.type === 'tableStateChanged';
}

function isTableTab(value: unknown): value is TableTab {
  return value === 'columns' || value === 'preview' || value === 'relationships' || value === 'indexes';
}

function isRelationshipTab(value: unknown): value is RelationshipTab {
  return value === 'list' || value === 'canvas';
}

function renderLoadingHtml(webview: vscode.Webview, table: DatabaseTable): string {
  return renderDocument(
    webview,
    'Loading table preview',
    `<main><h1>Table: ${escapeHtml(table.name)}</h1><p class="muted">Loading preview...</p></main>`,
  );
}

function renderErrorHtml(webview: vscode.Webview, table: DatabaseTable, message: string): string {
  return renderDocument(
    webview,
    'Could not load table preview',
    `<main><h1>Table: ${escapeHtml(table.name)}</h1><p class="error">${escapeHtml(message)}</p></main>`,
  );
}

function renderTableHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  table: DatabaseTable,
  columns: DatabaseColumn[],
  preview: TablePreview,
  relationships: TableRelationships,
  indexes: DatabaseIndex[],
  state: TableWebviewState,
): string {
  return renderDocument(
    webview,
    `Table: ${table.name}`,
    `
      <main>
        <header>
          <div>
            <h1>${escapeHtml(table.name)}</h1>
            <p class="muted">${escapeHtml(table.schema)} schema</p>
          </div>
          <div class="summary">
            ${renderSummaryStat('Columns', columns.length)}
            ${renderSummaryStat('PK', countPrimaryKeys(columns))}
            ${renderSummaryStat('FK', relationships.outbound.length)}
            ${renderSummaryStat('Indexes', indexes.length)}
            ${renderSummaryStat('Rows', preview.rows.length)}
          </div>
        </header>

        <div class="tabs">
          <input class="tab-input" type="radio" name="mitori-tabs" id="tab-columns" data-tab="columns" ${checked(state.selectedTab === 'columns')}>
          <input class="tab-input" type="radio" name="mitori-tabs" id="tab-preview" data-tab="preview" ${checked(state.selectedTab === 'preview')}>
          <input class="tab-input" type="radio" name="mitori-tabs" id="tab-relationships" data-tab="relationships" ${checked(state.selectedTab === 'relationships')}>
          <input class="tab-input" type="radio" name="mitori-tabs" id="tab-indexes" data-tab="indexes" ${checked(state.selectedTab === 'indexes')}>

          <div class="tab-list" role="tablist">
            <label class="tab" for="tab-columns" role="tab">Columns</label>
            <label class="tab" for="tab-preview" role="tab">Preview</label>
            <label class="tab" for="tab-relationships" role="tab">Relationships</label>
            <label class="tab" for="tab-indexes" role="tab">Indexes</label>
          </div>

          <div class="panels">
            <section class="tab-panel" id="panel-columns">
              ${renderColumnsTable(columns)}
            </section>

            <section class="tab-panel" id="panel-preview">
              <div class="section-heading">
                <h2>Preview</h2>
                <p class="muted">First ${escapeHtml(preview.limit)} rows, read-only.</p>
              </div>
              ${renderPreviewTable(preview)}
            </section>

            <section class="tab-panel" id="panel-relationships">
              ${renderRelationships(table, relationships, state.relationshipTab)}
            </section>

            <section class="tab-panel" id="panel-indexes">
              ${renderIndexes(indexes)}
            </section>
          </div>
        </div>
      </main>
    `,
    extensionUri,
    renderRelationshipGraphScript(table, relationships),
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

function renderColumnsTable(columns: DatabaseColumn[]): string {
  const rows =
    columns.length > 0
      ? columns.map(renderColumnRow).join('')
      : '<tr><td colspan="4" class="empty">No columns found.</td></tr>';

  return `
    <div class="section-heading">
      <h2>Columns</h2>
      <p class="muted">${escapeHtml(columns.length)} columns discovered.</p>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Markers</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderColumnRow(column: DatabaseColumn): string {
  const markers = [
    column.isPrimaryKey ? renderBadge('PK', 'key') : undefined,
    column.foreignKey ? renderBadge('FK', 'link') : undefined,
    renderBadge(column.isNullable ? 'nullable' : 'not null', column.isNullable ? 'soft' : 'strict'),
  ]
    .filter(Boolean)
    .join('');
  const reference = column.foreignKey
    ? `${column.foreignKey.referencedSchema}.${column.foreignKey.referencedTable}.${column.foreignKey.referencedColumn}`
    : '-';

  return `
    <tr>
      <td class="strong">${escapeHtml(column.name)}</td>
      <td><code>${escapeHtml(column.dataType)}</code></td>
      <td><div class="badges">${markers}</div></td>
      <td>${escapeHtml(reference)}</td>
    </tr>
  `;
}

function renderPreviewTable(preview: TablePreview): string {
  const header =
    preview.columns.length > 0
      ? preview.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')
      : '<th>Result</th>';
  const body =
    preview.rows.length > 0
      ? preview.rows.map((row) => renderPreviewRow(preview.columns, row)).join('')
      : `<tr><td colspan="${Math.max(preview.columns.length, 1)}" class="empty">No rows returned.</td></tr>`;

  return `
    <div class="table-wrap preview">
      <table>
        <thead><tr>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function renderPreviewRow(columns: string[], row: Record<string, unknown>): string {
  const cells = columns.map((column) => `<td>${formatCell(row[column])}</td>`).join('');
  return `<tr>${cells}</tr>`;
}

function renderRelationships(
  table: DatabaseTable,
  relationships: TableRelationships,
  selectedRelationshipTab: RelationshipTab,
): string {
  return `
    <div class="relationship-tabs">
      <input class="relationship-tab-input" type="radio" name="relationship-tabs" id="relationship-tab-list" data-relationship-tab="list" ${checked(selectedRelationshipTab === 'list')}>
      <input class="relationship-tab-input" type="radio" name="relationship-tabs" id="relationship-tab-canvas" data-relationship-tab="canvas" ${checked(selectedRelationshipTab === 'canvas')}>

      <div class="relationship-tab-list" role="tablist">
        <label class="relationship-tab" for="relationship-tab-list" role="tab">List</label>
        <label class="relationship-tab" for="relationship-tab-canvas" role="tab">Canvas</label>
      </div>

      <section class="relationship-panel" id="relationship-panel-list">
        <div class="relationship-grid">
          <section>
            <div class="section-heading">
              <h2>Outbound</h2>
              <p class="muted">Foreign keys from this table.</p>
            </div>
            ${renderOutboundRelationships(relationships.outbound)}
          </section>

          <section>
            <div class="section-heading">
              <h2>Inbound</h2>
              <p class="muted">Foreign keys pointing at this table.</p>
            </div>
            ${renderInboundRelationships(relationships.inbound)}
          </section>
        </div>
      </section>

      <section class="relationship-panel" id="relationship-panel-canvas">
        ${renderRelationshipCanvas(table, relationships)}
      </section>
    </div>
  `;
}

function renderRelationshipCanvas(table: DatabaseTable, relationships: TableRelationships): string {
  const relationshipCount = relationships.inbound.length + relationships.outbound.length;
  const emptyState =
    relationshipCount === 0
      ? `<div class="graph-empty">${escapeHtml(`${table.schema}.${table.name} has no discovered relationships.`)}</div>`
      : '';

  return `
    <div class="graph-shell">
      <div class="graph-toolbar">
        <div class="graph-title">
          <h2>Relationship Canvas</h2>
          <p class="muted">${escapeHtml(formatNumber(relationshipCount))} connections discovered.</p>
        </div>
        <div class="graph-controls">
          <button type="button" class="icon-button" data-graph-action="zoom-out" title="Zoom out" aria-label="Zoom out">-</button>
          <button type="button" class="icon-button" data-graph-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" class="icon-button reset-button" data-graph-action="reset" title="Reset view" aria-label="Reset view">100%</button>
        </div>
      </div>
      <div class="graph-stage">
        <svg class="relationship-canvas" data-relationship-graph viewBox="0 0 920 540" role="img" aria-label="Relationship graph"></svg>
        ${emptyState}
      </div>
    </div>
  `;
}

function renderOutboundRelationships(relationships: DatabaseForeignKey[]): string {
  const cards =
    relationships.length > 0
      ? relationships
          .map((relationship) =>
            renderRelationshipCard({
              direction: 'Outbound',
              table: {
                schema: relationship.referencedSchema,
                name: relationship.referencedTable,
              },
              sourceColumn: relationship.columnName,
              targetColumn: relationship.referencedColumn,
              constraintName: relationship.constraintName,
              detail: `${relationship.columnName} -> ${relationship.referencedColumn}`,
            }),
          )
          .join('')
      : '<div class="relationship-empty empty">No outbound relationships.</div>';

  return `<div class="relationship-card-list">${cards}</div>`;
}

function renderInboundRelationships(relationships: DatabaseForeignKey[]): string {
  const cards =
    relationships.length > 0
      ? relationships
          .map((relationship) =>
            renderRelationshipCard({
              direction: 'Inbound',
              table: {
                schema: relationship.schema,
                name: relationship.table,
              },
              sourceColumn: relationship.columnName,
              targetColumn: relationship.referencedColumn,
              constraintName: relationship.constraintName,
              detail: `${relationship.columnName} -> ${relationship.referencedColumn}`,
            }),
          )
          .join('')
      : '<div class="relationship-empty empty">No inbound relationships.</div>';

  return `<div class="relationship-card-list">${cards}</div>`;
}

function renderRelationshipCard(input: {
  direction: 'Inbound' | 'Outbound';
  table: Pick<DatabaseTable, 'schema' | 'name'>;
  sourceColumn: string;
  targetColumn: string;
  constraintName: string;
  detail: string;
}): string {
  const fullTableName = `${input.table.schema}.${input.table.name}`;

  return `
    <article class="relationship-card">
      <div class="relationship-card-main">
        <div class="relationship-card-topline">
          <span class="relationship-direction">${escapeHtml(input.direction)}</span>
          <button
            type="button"
            class="table-link"
            data-open-table-schema="${escapeHtml(input.table.schema)}"
            data-open-table-name="${escapeHtml(input.table.name)}"
            data-open-mode="same"
            title="Open ${escapeHtml(fullTableName)} in this tab"
          >${escapeHtml(fullTableName)}</button>
        </div>
        <div class="relationship-columns">
          <code>${escapeHtml(input.sourceColumn)}</code>
          <span class="relationship-arrow">-></span>
          <code>${escapeHtml(input.targetColumn)}</code>
        </div>
        <code class="relationship-constraint">${escapeHtml(input.constraintName)}</code>
      </div>
      <div class="relationship-actions">
        <button
          type="button"
          class="secondary-button"
          data-open-table-schema="${escapeHtml(input.table.schema)}"
          data-open-table-name="${escapeHtml(input.table.name)}"
          data-open-mode="new"
          title="Open ${escapeHtml(fullTableName)} in a new tab"
        >New</button>
      </div>
    </article>
  `;
}

function renderIndexes(indexes: DatabaseIndex[]): string {
  const rows =
    indexes.length > 0
      ? indexes
          .map(
            (index) => `
              <tr>
                <td class="strong">${escapeHtml(index.name)}</td>
                <td><code class="definition">${escapeHtml(index.definition)}</code></td>
              </tr>
            `,
          )
          .join('')
      : '<tr><td colspan="2" class="empty">No indexes found.</td></tr>';

  return `
    <div class="section-heading">
      <h2>Indexes</h2>
      <p class="muted">${escapeHtml(indexes.length)} indexes discovered.</p>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Definition</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderBadge(label: string, tone: 'key' | 'link' | 'soft' | 'strict'): string {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function countPrimaryKeys(columns: DatabaseColumn[]): number {
  return columns.filter((column) => column.isPrimaryKey).length;
}

function renderRelationshipGraphScript(table: DatabaseTable, relationships: TableRelationships): string {
  const graph = createRelationshipGraph(table, relationships);
  const currentTable = {
    schema: table.schema,
    name: table.name,
  };

  return `
(function () {
  const graph = ${serializeForScript(graph)};
  const currentTable = ${serializeForScript(currentTable)};
  const vscodeApi = acquireVsCodeApi();
  const svg = document.querySelector('[data-relationship-graph]');

  document.addEventListener('click', function (event) {
    const target = event.target;
    const opener = target && typeof target.closest === 'function' ? target.closest('[data-open-table-schema]') : null;

    if (!opener) {
      return;
    }

    openTable(
      {
        schema: opener.getAttribute('data-open-table-schema'),
        name: opener.getAttribute('data-open-table-name')
      },
      opener.getAttribute('data-open-mode') === 'new' ? 'new' : 'same'
    );
  });

  document.addEventListener('change', function (event) {
    const target = event.target;

    if (
      target &&
      target instanceof HTMLInputElement &&
      (target.name === 'mitori-tabs' || target.name === 'relationship-tabs')
    ) {
      postTableState();
    }
  });

  postTableState();

  if (!svg || graph.nodes.length === 0) {
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const nodeWidth = 214;
  const nodeHeight = 76;
  const nodeById = new Map(graph.nodes.map(function (node) {
    return [node.id, node];
  }));
  const state = {
    x: 460,
    y: 270,
    scale: 1
  };
  let activeDrag = null;

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
        state.y = 270;
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
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
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
      if (Math.abs(event.clientX - activeDrag.startClientX) > 4 || Math.abs(event.clientY - activeDrag.startClientY) > 4) {
        activeDrag.moved = true;
      }

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
    const finishedDrag = activeDrag;

    if (activeDrag) {
      activeDrag = null;
      svg.classList.remove('is-panning');
    }

    if (event && svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }

    if (finishedDrag && finishedDrag.type === 'node' && !finishedDrag.moved) {
      const node = nodeById.get(finishedDrag.id);

      if (node && node.id !== currentTable.schema + '.' + currentTable.name) {
        openTable({ schema: node.schema, name: node.table }, 'same');
      }
    }
  }

  function render() {
    viewport.replaceChildren();

    const gridLayer = createSvgElement('g', { class: 'graph-grid-layer' });
    gridLayer.append(createSvgElement('rect', {
      class: 'graph-grid',
      x: '-5000',
      y: '-5000',
      width: '10000',
      height: '10000'
    }));
    const edgeLayer = createSvgElement('g', { class: 'graph-edges' });
    const nodeLayer = createSvgElement('g', { class: 'graph-nodes' });
    viewport.append(gridLayer, edgeLayer, nodeLayer);

    graph.edges.forEach(function (edge) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);

      if (!source || !target) {
        return;
      }

      const path = createSvgElement('path', {
        class: 'graph-edge ' + edge.kind,
        d: createEdgePath(source, target),
        'marker-end': 'url(#mitori-relationship-arrow)'
      });
      const label = createSvgElement('text', {
        class: 'graph-edge-label',
        x: String((source.x + target.x) / 2),
        y: String((source.y + target.y) / 2 - 10)
      });
      label.textContent = edge.label;
      edgeLayer.append(path, label);
    });

    graph.nodes.forEach(function (node) {
      const group = createSvgElement('g', {
        class: 'graph-node ' + node.kind,
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
      schemaName.textContent = node.schema;
      group.append(rect, tableName, schemaName);
      nodeLayer.append(group);
    });
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
    zoomAtPoint(factor, { x: 460, y: 270 });
  }

  function zoomAtPoint(factor, point) {
    const graphPoint = {
      x: (point.x - state.x) / state.scale,
      y: (point.y - state.y) / state.scale
    };
    state.scale = clamp(state.scale * factor, 0.35, 2.8);
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
      return { x: 460, y: 270 };
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

  function openTable(table, mode) {
    if (!table.schema || !table.name) {
      return;
    }

    vscodeApi.postMessage({
      type: 'openTable',
      mode: mode,
      table: table,
      selectedTab: getSelectedTab(),
      relationshipTab: getSelectedRelationshipTab()
    });
  }

  function postTableState() {
    vscodeApi.postMessage({
      type: 'tableStateChanged',
      selectedTab: getSelectedTab(),
      relationshipTab: getSelectedRelationshipTab()
    });
  }

  function getSelectedTab() {
    const selected = document.querySelector('input[name="mitori-tabs"]:checked');
    return selected ? selected.getAttribute('data-tab') || 'columns' : 'columns';
  }

  function getSelectedRelationshipTab() {
    const selected = document.querySelector('input[name="relationship-tabs"]:checked');
    return selected ? selected.getAttribute('data-relationship-tab') || 'list' : 'list';
  }
})();
`;
}

function createRelationshipGraph(table: DatabaseTable, relationships: TableRelationships): RelationshipGraph {
  const currentId = getTableNodeId(table.schema, table.name);
  const nodesById = new Map<string, RelationshipGraphNode>();
  const inboundIds = new Set<string>();
  const outboundIds = new Set<string>();
  const edges: RelationshipGraphEdge[] = [];

  nodesById.set(currentId, {
    id: currentId,
    schema: table.schema,
    table: table.name,
    kind: 'current',
    x: 0,
    y: 0,
  });

  for (const relationship of relationships.outbound) {
    const targetId = getTableNodeId(relationship.referencedSchema, relationship.referencedTable);
    addGraphNode(nodesById, targetId, relationship.referencedSchema, relationship.referencedTable, 'outbound');
    outboundIds.add(targetId);
    edges.push({
      source: currentId,
      target: targetId,
      label: `${relationship.columnName} -> ${relationship.referencedColumn}`,
      kind: 'outbound',
    });
  }

  for (const relationship of relationships.inbound) {
    const sourceId = getTableNodeId(relationship.schema, relationship.table);
    addGraphNode(nodesById, sourceId, relationship.schema, relationship.table, 'inbound');
    inboundIds.add(sourceId);
    edges.push({
      source: sourceId,
      target: currentId,
      label: `${relationship.columnName} -> ${relationship.referencedColumn}`,
      kind: 'inbound',
    });
  }

  layoutGraphNodes(nodesById, inboundIds, outboundIds, currentId);

  return {
    nodes: Array.from(nodesById.values()),
    edges,
  };
}

function addGraphNode(
  nodesById: Map<string, RelationshipGraphNode>,
  id: string,
  schema: string,
  table: string,
  kind: RelationshipGraphNode['kind'],
): void {
  const existing = nodesById.get(id);

  if (!existing) {
    nodesById.set(id, {
      id,
      schema,
      table,
      kind,
      x: 0,
      y: 0,
    });
    return;
  }

  if (existing.kind !== 'current' && existing.kind !== kind) {
    existing.kind = 'both';
  }
}

function layoutGraphNodes(
  nodesById: Map<string, RelationshipGraphNode>,
  inboundIds: Set<string>,
  outboundIds: Set<string>,
  currentId: string,
): void {
  const inbound = Array.from(inboundIds)
    .filter((id) => id !== currentId && !outboundIds.has(id))
    .sort();
  const outbound = Array.from(outboundIds)
    .filter((id) => id !== currentId)
    .sort();
  const both = Array.from(inboundIds)
    .filter((id) => id !== currentId && outboundIds.has(id))
    .sort();
  const centerNode = nodesById.get(currentId);

  if (centerNode) {
    centerNode.x = 0;
    centerNode.y = 0;
  }

  positionNodeColumn(nodesById, inbound, -350);
  positionNodeColumn(nodesById, outbound, 350);
  positionNodeColumn(nodesById, both, 0, 140);
}

function positionNodeColumn(
  nodesById: Map<string, RelationshipGraphNode>,
  ids: string[],
  x: number,
  yOffset = 0,
): void {
  ids.forEach((id, index) => {
    const node = nodesById.get(id);

    if (!node) {
      return;
    }

    node.x = x;
    node.y = yOffset + (index - (ids.length - 1) / 2) * 122;
  });
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

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '<span class="null">null</span>';
  }

  if (value instanceof Date) {
    return escapeHtml(value.toISOString());
  }

  if (Buffer.isBuffer(value)) {
    return escapeHtml(`\\x${value.toString('hex')}`);
  }

  if (typeof value === 'object') {
    try {
      return `<pre class="cell-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
    } catch {
      return escapeHtml(String(value));
    }
  }

  if (typeof value === 'string' && value.length === 0) {
    return '<span class="empty-value">empty</span>';
  }

  return escapeHtml(String(value));
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
      max-width: 1180px;
      margin: 0 auto;
      padding: 20px;
    }

    header {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
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

    code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .muted,
    .null,
    .empty,
    .empty-value {
      color: var(--vscode-descriptionForeground);
    }

    .error {
      color: var(--vscode-errorForeground);
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(72px, 1fr));
      gap: 8px;
    }

    .stat {
      border: 1px solid var(--vscode-panel-border);
      padding: 8px 10px;
      min-width: 72px;
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

    .tabs {
      width: 100%;
    }

    .tab-input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .tab-list {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 16px;
      overflow-x: auto;
    }

    .tab {
      cursor: pointer;
      padding: 8px 12px;
      border: 1px solid transparent;
      border-bottom: 0;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    #tab-columns:checked ~ .tab-list label[for="tab-columns"],
    #tab-preview:checked ~ .tab-list label[for="tab-preview"],
    #tab-relationships:checked ~ .tab-list label[for="tab-relationships"],
    #tab-indexes:checked ~ .tab-list label[for="tab-indexes"] {
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border);
      background: var(--vscode-tab-activeBackground);
    }

    .tab-panel {
      display: none;
    }

    #tab-columns:checked ~ .panels #panel-columns,
    #tab-preview:checked ~ .panels #panel-preview,
    #tab-relationships:checked ~ .panels #panel-relationships,
    #tab-indexes:checked ~ .panels #panel-indexes {
      display: block;
    }

    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 16px;
      margin-bottom: 10px;
    }

    .section-heading p {
      margin-bottom: 0;
    }

    .relationship-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    .relationship-card-list {
      display: grid;
      gap: 10px;
    }

    .relationship-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      padding: 10px;
    }

    .relationship-card-main {
      min-width: 0;
    }

    .relationship-card-topline {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .relationship-direction {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .table-link {
      min-width: 0;
      padding: 0;
      border: 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .table-link:hover {
      text-decoration: underline;
    }

    .relationship-columns {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }

    .relationship-arrow {
      color: var(--vscode-descriptionForeground);
    }

    .relationship-constraint {
      display: block;
      color: var(--vscode-descriptionForeground);
      margin-top: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .relationship-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .secondary-button {
      min-width: 44px;
      height: 28px;
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border));
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
      font: inherit;
      line-height: 1;
    }

    .secondary-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .relationship-empty {
      border: 1px solid var(--vscode-panel-border);
      padding: 12px;
      background: var(--vscode-editorWidget-background);
    }

    .relationship-tab-input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .relationship-tab-list {
      display: inline-flex;
      gap: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 14px;
    }

    .relationship-tab {
      cursor: pointer;
      padding: 7px 11px;
      border: 1px solid transparent;
      border-bottom: 0;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    #relationship-tab-list:checked ~ .relationship-tab-list label[for="relationship-tab-list"],
    #relationship-tab-canvas:checked ~ .relationship-tab-list label[for="relationship-tab-canvas"] {
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border);
      background: var(--vscode-tab-activeBackground);
    }

    .relationship-panel {
      display: none;
    }

    #relationship-tab-list:checked ~ #relationship-panel-list,
    #relationship-tab-canvas:checked ~ #relationship-panel-canvas {
      display: block;
    }

    .graph-shell {
      border: 1px solid var(--vscode-panel-border);
      min-height: 560px;
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
      min-height: 520px;
      overflow: hidden;
      background-color: var(--vscode-editor-background);
    }

    .relationship-canvas {
      display: block;
      width: 100%;
      height: 520px;
      cursor: grab;
      touch-action: none;
      user-select: none;
    }

    .relationship-canvas.is-panning {
      cursor: grabbing;
    }

    .graph-node {
      cursor: move;
    }

    .graph-grid {
      fill: url(#mitori-grid-dots);
    }

    .graph-grid-dot {
      fill: var(--vscode-panel-border);
      opacity: 0.8;
    }

    .graph-node rect {
      fill: var(--vscode-editorWidget-background);
      stroke: var(--vscode-panel-border);
      stroke-width: 1.25;
    }

    .graph-node.current rect {
      stroke: var(--vscode-focusBorder);
      stroke-width: 2;
    }

    .graph-node.inbound rect {
      stroke: var(--vscode-charts-purple);
    }

    .graph-node.outbound rect {
      stroke: var(--vscode-textLink-foreground);
    }

    .graph-node.both rect {
      stroke: var(--vscode-charts-orange);
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
      stroke: var(--vscode-descriptionForeground);
      stroke-width: 1.4;
    }

    .graph-edge.outbound {
      stroke: var(--vscode-textLink-foreground);
    }

    .graph-edge.inbound {
      stroke: var(--vscode-charts-purple);
    }

    .graph-arrow {
      fill: var(--vscode-descriptionForeground);
    }

    .graph-edge-label {
      fill: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-anchor: middle;
      paint-order: stroke;
      stroke: var(--vscode-editor-background);
      stroke-width: 4px;
      stroke-linejoin: round;
    }

    .graph-empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--vscode-descriptionForeground);
      pointer-events: none;
    }

    .table-wrap {
      width: 100%;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 680px;
    }

    th,
    td {
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 8px 10px;
      white-space: nowrap;
    }

    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      z-index: 1;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .preview {
      max-height: 560px;
    }

    .preview td {
      max-width: 420px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .strong {
      font-weight: 600;
    }

    .badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--vscode-panel-border);
      padding: 2px 6px;
      font-size: 11px;
      line-height: 1.3;
      white-space: nowrap;
    }

    .badge.key {
      color: var(--vscode-charts-yellow);
    }

    .badge.link {
      color: var(--vscode-textLink-foreground);
    }

    .badge.strict {
      color: var(--vscode-charts-green);
    }

    .badge.soft {
      color: var(--vscode-descriptionForeground);
    }

    .cell-json,
    .definition {
      display: block;
      max-width: 720px;
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    @media (max-width: 760px) {
      main {
        padding: 14px;
      }

      header,
      .relationship-grid {
        grid-template-columns: 1fr;
      }

      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .section-heading {
        display: block;
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

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function checked(condition: boolean): string {
  return condition ? 'checked' : '';
}

function getNonce(): string {
  return randomBytes(16).toString('base64');
}
