import './style.css';

// ===== Constants =====
const API_BASE = import.meta.env.VITE_API_URL || '';

// ===== Global State =====
const STATE = {
  currentTab: 'overview', // 'overview' or 'management'
  overview: {
    total_files: 0,
    total_size: 0,
    claimed_files: 0,
    claimed_size: 0,
    downloaded_files: 0,
    downloaded_size: 0,
    verified_files: 0,
    verified_size: 0,
    archived_files: 0,
    archived_size: 0
  },
  treeData: [],
  expandedDirs: new Set(),
  dirChildren: {},   // path -> children array (cache)
  loadingDirs: new Set(),
  workerId: parseInt(localStorage.getItem('worker_id') || '', 10) || null,
  workerKey: localStorage.getItem('worker_key') || null,
};

let sse = null;

// ===== API =====
async function api(endpoint, opts = {}) {
  const headers = { ...opts.headers };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (STATE.workerKey) headers['Authorization'] = `Bearer ${STATE.workerKey}`;

  const res = await fetch(`${API_BASE}${endpoint}`, { ...opts, headers });
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  if (res.status === 204) return null;
  return await res.json();
}

// ===== SSE for real-time updates =====
function connectSSE() {
  if (sse) return;

  sse = new EventSource(`${API_BASE}/api/stats/stream`);
  
  sse.onopen = () => {
    console.log('SSE connected');
  };

  sse.onerror = () => {
    console.error('SSE error');
    if (sse) {
      sse.close();
      sse = null;
    }
    setTimeout(connectSSE, 3000);
  };

  sse.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'overview_update') {
        STATE.overview = data;
        if (STATE.currentTab === 'overview') renderOverviewContent();
      } else if (data.type === 'tree_update') {
        STATE.treeData = data.directories || [];
        if (STATE.currentTab === 'overview') renderOverviewContent();
      }
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };
}

// ===== Layout =====
function createLayout() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  const header = document.createElement('header');
  header.innerHTML = `
    <div class="flex" style="gap: 3rem;">
      <div class="logo">
        <div class="logo-icon">H</div>
        <span>Myrient Horizon</span>
      </div>
      <nav class="nav-links">
        <a href="#" data-tab="overview" class="active">Overview</a>
        <a href="#" data-tab="management">Management</a>
      </nav>
    </div>
    <div style="color: var(--text-secondary); font-size: 0.875rem;">
      Downloaded Reclaims Worker
    </div>
  `;

  const main = document.createElement('main');
  main.id = 'main';

  app.appendChild(header);
  app.appendChild(main);

  // Tab switching
  header.querySelectorAll('[data-tab]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = link.dataset.tab;
      STATE.currentTab = tab;
      
      header.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
      link.classList.add('active');
      
      render();
    });
  });

  render();
}

function render() {
  if (STATE.currentTab === 'overview') {
    renderOverview();
  } else if (STATE.currentTab === 'management') {
    renderManagement();
  }
}

// ===== Overview Tab =====
function renderOverview() {
  const main = document.getElementById('main');
  main.innerHTML = '<h1 style="margin-bottom: 1.5rem;">Overview</h1>';

  const overviewCard = document.createElement('div');
  overviewCard.className = 'card';
  overviewCard.id = 'overview-card';
  main.appendChild(overviewCard);

  const treeContainer = document.createElement('div');
  treeContainer.className = 'tree-container';
  treeContainer.innerHTML = '<h2 style="margin-bottom: 1rem;">Directory Status</h2>';
  const tree = document.createElement('div');
  tree.id = 'directory-tree';
  treeContainer.appendChild(tree);
  main.appendChild(treeContainer);

  // Event delegation for tree expand/collapse
  tree.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row.expandable');
    if (!row) return;
    const path = row.dataset.path;
    if (path) toggleDir(path);
  });

  renderOverviewContent();
}

function renderOverviewContent() {
  const overviewCard = document.getElementById('overview-card');
  if (!overviewCard) return;

  const o = STATE.overview;
  const total = o.total_files || 0;
  const claimed = o.claimed_files || 0;
  const downloaded = o.downloaded_files || 0;
  const verified = o.verified_files || 0;
  const archived = o.archived_files || 0;

  const claimedPct = total > 0 ? (claimed / total * 100) : 0;
  const downloadedPct = total > 0 ? (downloaded / total * 100) : 0;
  const verifiedPct = total > 0 ? (verified / total * 100) : 0;
  const archivedPct = total > 0 ? (archived / total * 100) : 0;

  overviewCard.innerHTML = `
    <h2 style="margin-bottom: 1rem;">Overall Progress</h2>
    
    <div class="progress-container">
      <div class="progress-labels">
        <span>Claimed</span>
        <span>Downloaded</span>
        <span>Verified</span>
        <span>Archived</span>
      </div>
      <div class="multi-progress-bar">
        <div class="progress-segment claimed" style="width: ${claimedPct}%"></div>
        <div class="progress-segment downloaded" style="width: ${downloadedPct}%"></div>
        <div class="progress-segment verified" style="width: ${verifiedPct}%"></div>
        <div class="progress-segment archived" style="width: ${archivedPct}%"></div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-item total">
        <div class="stat-label">Total Files</div>
        <div class="stat-value">${formatNumber(total)}</div>
        <div class="stat-sub">${formatSize(o.total_size || 0)}</div>
      </div>
      <div class="stat-item claimed">
        <div class="stat-label">Claimed</div>
        <div class="stat-value">${formatNumber(claimed)}</div>
        <div class="stat-sub">${formatSize(o.claimed_size || 0)}</div>
      </div>
      <div class="stat-item downloaded">
        <div class="stat-label">Downloaded</div>
        <div class="stat-value">${formatNumber(downloaded)}</div>
        <div class="stat-sub">${formatSize(o.downloaded_size || 0)}</div>
      </div>
      <div class="stat-item verified">
        <div class="stat-label">Verified</div>
        <div class="stat-value">${formatNumber(verified)}</div>
        <div class="stat-sub">${formatSize(o.verified_size || 0)}</div>
      </div>
      <div class="stat-item archived">
        <div class="stat-label">Archived</div>
        <div class="stat-value">${formatNumber(archived)}</div>
        <div class="stat-sub">${formatSize(o.archived_size || 0)}</div>
      </div>
    </div>
  `;

  renderTree();
}

// ===== Tree Expand/Collapse =====
async function toggleDir(path) {
  if (STATE.expandedDirs.has(path)) {
    STATE.expandedDirs.delete(path);
    renderTree();
    return;
  }

  STATE.expandedDirs.add(path);

  // Fetch children if not cached
  if (!STATE.dirChildren[path]) {
    STATE.loadingDirs.add(path);
    renderTree();
    try {
      const data = await api(`/api/stats/tree?path=${encodeURIComponent(path)}&depth=1`);
      STATE.dirChildren[path] = data.directories || [];
    } catch (err) {
      console.error('Failed to fetch children:', err);
    }
    STATE.loadingDirs.delete(path);
  }

  renderTree();
}

function renderTree() {
  const tree = document.getElementById('directory-tree');
  if (!tree) return;

  if (!STATE.treeData || STATE.treeData.length === 0) {
    tree.innerHTML = '<div class="card"><p style="color: var(--text-secondary);">No directory data available.</p></div>';
    return;
  }

  let html = `
    <div class="tree-header">
      <span style="flex: 2; min-width: 200px;">Directory</span>
      <span style="flex: 3; padding: 0 1rem;">Progress</span>
      <span style="flex: 1; text-align: right;">Status</span>
    </div>
    <div class="tree-body">
  `;

  for (const dir of STATE.treeData) {
    html += renderTreeRow(dir, 0);
  }

  html += '</div>';
  tree.innerHTML = html;
}

function renderTreeRow(dir, depth) {
  const indent = depth * 1.5;
  const total = dir.total_files || 0;
  const claimed = dir.claimed_files || 0;
  const downloaded = dir.downloaded_files || 0;
  const verified = dir.verified_files || 0;
  const archived = dir.archived_files || 0;

  const claimedPct = total > 0 ? (claimed / total * 100) : 0;
  const downloadedPct = total > 0 ? (downloaded / total * 100) : 0;
  const verifiedPct = total > 0 ? (verified / total * 100) : 0;
  const archivedPct = total > 0 ? (archived / total * 100) : 0;

  const hasChildren = dir.has_children;
  const isExpanded = dir.path && STATE.expandedDirs.has(dir.path);
  const isLoading = dir.path && STATE.loadingDirs.has(dir.path);

  const chevron = hasChildren
    ? `<span class="tree-chevron${isExpanded ? ' expanded' : ''}">&#9654;</span>`
    : '<span class="tree-chevron-spacer"></span>';

  let html = `
    <div class="tree-row${hasChildren ? ' expandable' : ''}" data-path="${escapeHtml(dir.path || '')}">
      <div class="tree-col-name" style="padding-left: ${indent + 0.5}rem;">
        ${chevron}
        &#128193; ${escapeHtml(dir.name)}
      </div>
      <div class="tree-col-progress">
        <div class="multi-progress-bar" style="height: 8px;">
          <div class="progress-segment claimed" style="width: ${claimedPct}%"></div>
          <div class="progress-segment downloaded" style="width: ${downloadedPct}%"></div>
          <div class="progress-segment verified" style="width: ${verifiedPct}%"></div>
          <div class="progress-segment archived" style="width: ${archivedPct}%"></div>
        </div>
      </div>
      <div class="tree-col-stats">
        ${verified}/${total}
      </div>
    </div>
  `;

  // Loading indicator
  if (isLoading) {
    html += `
      <div class="tree-loading" style="padding-left: ${(depth + 1) * 1.5 + 0.5}rem;">
        <span class="tree-loading-spinner"></span> Loading...
      </div>
    `;
  }

  // Render children if expanded
  if (isExpanded && !isLoading) {
    const children = STATE.dirChildren[dir.path] || [];
    for (const child of children) {
      html += renderTreeRow(child, depth + 1);
    }
    if (children.length === 0) {
      html += `
        <div class="tree-loading" style="padding-left: ${(depth + 1) * 1.5 + 0.5}rem;">
          No subdirectories
        </div>
      `;
    }
  }

  return html;
}

// ===== Management Tab =====
function renderManagement() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <h1 style="margin-bottom: 1.5rem;">Worker Management</h1>
    <div class="card">
      <p style="color: var(--text-secondary);">Worker management interface will be implemented here.</p>
      <p style="color: var(--text-secondary); margin-top: 1rem;">This section will allow you to:</p>
      <ul style="color: var(--text-secondary); padding-left: 1.5rem; margin-top: 0.5rem;">
        <li>View worker status and configuration</li>
        <li>Manage worker claims and tasks</li>
        <li>Monitor worker performance</li>
        <li>Configure worker settings</li>
      </ul>
    </div>
  `;
}

// ===== Data Fetching =====
async function fetchOverview() {
  try {
    const data = await api('/api/stats/overview');
    STATE.overview = data;
    if (STATE.currentTab === 'overview') renderOverviewContent();
  } catch (err) {
    console.error('Failed to fetch overview:', err);
  }
}

async function fetchTree() {
  try {
    const data = await api('/api/stats/tree?depth=1');
    STATE.treeData = data.directories || [];

    // Refresh children of expanded dirs in parallel
    const expandedPaths = [...STATE.expandedDirs];
    if (expandedPaths.length > 0) {
      await Promise.all(expandedPaths.map(async (path) => {
        try {
          const childData = await api(`/api/stats/tree?path=${encodeURIComponent(path)}&depth=1`);
          STATE.dirChildren[path] = childData.directories || [];
        } catch (_) {}
      }));
    }

    if (STATE.currentTab === 'overview') renderTree();
  } catch (err) {
    console.error('Failed to fetch tree:', err);
  }
}

// ===== Utilities =====
function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function formatNumber(num) {
  if (num == null) return '0';
  return num.toLocaleString();
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Init =====
createLayout();
fetchOverview();
fetchTree();

// Fetch data periodically
setInterval(fetchOverview, 15000);
setInterval(fetchTree, 30000);

// Try to connect SSE for real-time updates
connectSSE();
