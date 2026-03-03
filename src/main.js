import './style.css';

// ===== Constants =====
const STATUS_LABELS = ['pending', 'downloading', 'downloaded', 'verifying', 'verified', 'failed'];
const STATUS_VARIANTS = ['', 'warning', 'success', 'warning', 'success', 'danger'];

// ===== Global State =====
const STATE = {
  workerId: parseInt(localStorage.getItem('worker_id') || '', 10) || null,
  workerKey: localStorage.getItem('worker_key') || null,
  sseConnected: false,
  // DirStats fields: total, downloading, downloaded, verifying, verified, failed, conflict
  overview: { total: 0, downloading: 0, downloaded: 0, verifying: 0, verified: 0, failed: 0, conflict: 0 },
  // Browse state (driven by SSE)
  browsePath: '/',
  browseStats: null,
  browseChildren: [],
  // Persisted mappings (optional but helps My Worker + release)
  dirPaths: safeJsonParse(localStorage.getItem('dir_paths')) || {}, // dir_id -> path
  pathToDirId: safeJsonParse(localStorage.getItem('path_to_dir_id')) || {}, // path -> dir_id
};

const API_BASE = import.meta.env.VITE_API_URL || '';
let sse = null;
let ssePath = null;
let navbar = null;
let main = null;

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

// ===== SSE =====
// Backend stream: GET /api/stats/stream?path=... (optional)
// Sends generic `data: { type:"dir_stats", path, stats, children }` messages.
function connectSSE(path = '') {
  if (sse && ssePath === path) return;
  if (sse) {
    sse.close();
    sse = null;
  }
  ssePath = path;

  // Reset browse snapshot so UI doesn't show stale data while loading.
  STATE.browsePath = path || '/';
  STATE.browseStats = null;
  STATE.browseChildren = [];

  STATE.sseConnected = false;
  updateNavbar();

  const params = path ? `?path=${encodeURIComponent(path)}` : '';
  sse = new EventSource(`${API_BASE}/api/stats/stream${params}`);

  sse.onopen = () => {
    STATE.sseConnected = true;
    updateNavbar();
  };

  sse.onerror = () => {
    STATE.sseConnected = false;
    updateNavbar();
    if (sse) {
      sse.close();
      sse = null;
    }
    setTimeout(() => {
      // Only reconnect if we haven't switched paths in the meantime.
      if (!sse) connectSSE(ssePath || '');
    }, 3000);
  };

  sse.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type !== 'dir_stats') return;

      STATE.browsePath = data.path || '';
      STATE.browseStats = data.stats || null;
      STATE.browseChildren = data.children || [];

      // Cache the current directory's own mapping.
      if (data.dir_id != null && STATE.browsePath) {
        STATE.dirPaths[data.dir_id] = STATE.browsePath;
        STATE.pathToDirId[STATE.browsePath] = data.dir_id;
      }

      // Cache mappings for children.
      for (const child of STATE.browseChildren) {
        const childPath = (STATE.browsePath || '') + child.name + '/';
        STATE.dirPaths[child.dir_id] = childPath;
        STATE.pathToDirId[childPath] = child.dir_id;
      }
      persistMappings();

      if (getCurrentPage() === 'browse') updateBrowseFromSSE();
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };
}

function closeSSE() {
  if (sse) {
    sse.close();
    sse = null;
  }
  ssePath = null;
  STATE.sseConnected = false;
}

function persistMappings() {
  localStorage.setItem('dir_paths', JSON.stringify(STATE.dirPaths));
  localStorage.setItem('path_to_dir_id', JSON.stringify(STATE.pathToDirId));
}

// ===== Router =====
function getCurrentPage() {
  const p = location.pathname;
  if (p === '/' || p === '') return 'dashboard';
  if (p.startsWith('/browse')) return 'browse';
  if (p === '/my-worker') return 'my-worker';
  if (p === '/conflicts') return 'conflicts';
  return '404';
}

function getBrowseTreePathFromUrl() {
  let p = location.pathname;
  if (!p.startsWith('/browse')) return null;

  // Keep the part after /browse, and decode URI encoding back into a tree path.
  let treePath = p.slice('/browse'.length);
  if (treePath === '' || treePath === '/') return '/';

  if (!treePath.startsWith('/')) treePath = '/' + treePath;
  if (!treePath.endsWith('/')) treePath = treePath + '/';

  // location.pathname is encoded; backend expects the decoded string.
  try {
    treePath = decodeURI(treePath);
  } catch {
    // If decode fails, keep as-is.
  }
  return treePath;
}

function toBrowseHref(treePath) {
  // Encode for URL path usage (keeps slashes).
  return `/browse${encodeURI(treePath)}`;
}

function navigate(path) {
  history.pushState(null, '', path);
  route();
}
window.navigate = navigate;

function route() {
  main.innerHTML = '';

  const page = getCurrentPage();

  if (page === 'dashboard') {
    closeSSE();
    renderDashboard();
  } else if (page === 'browse') {
    const treePath = getBrowseTreePathFromUrl() || '/';
    connectSSE(treePath);
    renderBrowse(treePath);
  } else if (page === 'my-worker') {
    closeSSE();
    renderMyWorker();
  } else if (page === 'conflicts') {
    closeSSE();
    renderConflicts();
  } else {
    closeSSE();
    main.innerHTML = '<h1>404 Not Found</h1>';
  }

  updateNavbar();
}

// ===== Layout =====
function createLayout() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  navbar = document.createElement('header');
  navbar.className = 'navbar';

  main = document.createElement('main');

  app.appendChild(navbar);
  app.appendChild(main);

  updateNavbar();

  // SPA link handler: intercept <a> clicks with href starting with '/'
  document.body.addEventListener('click', e => {
    const link = e.target.closest('a');
    if (link && link.getAttribute('href')?.startsWith('/')) {
      e.preventDefault();
      navigate(link.getAttribute('href'));
    }
  });

  window.addEventListener('popstate', route);
}

function updateNavbar() {
  if (!navbar) return;

  const isAuth = !!STATE.workerKey && !!STATE.workerId;
  const o = STATE.overview;
  const started = (o.downloading || 0) + (o.downloaded || 0) + (o.verifying || 0) + (o.verified || 0) + (o.failed || 0);
  const progress = o.total > 0 ? Math.round((started / o.total) * 100) : 0;
  const page = getCurrentPage();

  navbar.innerHTML = `
    <div class="flex items-center">
      <h2 style="margin:0; margin-right: 2rem; font-size: 1.25rem;">Myrient Horizon</h2>
      <nav class="nav-links">
        <a href="/" class="${page === 'dashboard' ? 'active' : ''}">Overview</a>
        <a href="/browse" class="${page === 'browse' ? 'active' : ''}">Browse</a>
        <a href="/conflicts" class="${page === 'conflicts' ? 'active' : ''}">Conflicts</a>
      </nav>
    </div>
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2" title="Progress: ${progress}%">
        <div style="width: 100px;" class="progress-track">
          <div class="progress-fill" style="width: ${progress}%"></div>
        </div>
        <span style="font-size: 0.75rem; color: var(--text-secondary)">${progress}%</span>
      </div>
      <div title="${STATE.sseConnected ? 'Connected' : 'Disconnected'}"
           style="width: 8px; height: 8px; border-radius: 50%; background-color: ${STATE.sseConnected ? 'var(--success-color)' : 'var(--danger-color)'};"></div>
      ${isAuth
        ? `<a href="/my-worker" class="btn btn-sm ${page === 'my-worker' ? 'btn-primary' : ''}">My Worker</a>
           <button class="btn btn-sm" id="logout-btn">Sign Out</button>`
        : `<button class="btn btn-sm btn-primary" id="auth-btn">Worker Auth</button>`
      }
    </div>
  `;

  const authBtn = navbar.querySelector('#auth-btn');
  if (authBtn) authBtn.onclick = showAuthDialog;

  const logoutBtn = navbar.querySelector('#logout-btn');
  if (logoutBtn) logoutBtn.onclick = logout;
}

// ===== Auth =====
function showAuthDialog() {
  const existing = document.getElementById('auth-dialog');
  if (existing) existing.remove();

  const dialog = document.createElement('dialog');
  dialog.id = 'auth-dialog';
  dialog.innerHTML = `
    <div class="flex flex-col gap-4" style="min-width: 350px;">
      <h3>Sign In</h3>

      <div class="card" style="margin-bottom: 0;">
        <form id="bind-form" class="flex flex-col gap-2">
          <input type="number" id="bind-id" class="input" placeholder="Worker ID" required value="${STATE.workerId || ''}" />
          <input type="password" id="bind-key" class="input" placeholder="Worker Key (mh_...)" required />
          <button type="submit" class="btn btn-primary">Sign In</button>
        </form>
      </div>

      <p id="auth-error" style="color: var(--danger-color); display: none;"></p>
      <button type="button" class="btn" id="cancel-auth">Close</button>
    </div>
  `;
  document.body.appendChild(dialog);

  dialog.querySelector('#cancel-auth').onclick = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.querySelector('#bind-form').onsubmit = handleBind;
  dialog.showModal();
}

async function handleBind(e) {
  e.preventDefault();
  const id = parseInt(document.getElementById('bind-id').value, 10);
  const key = document.getElementById('bind-key').value.trim();
  const errorEl = document.getElementById('auth-error');
  const btn = e.target.querySelector('[type="submit"]');
  if (!id || !key) return;

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  errorEl.style.display = 'none';

  try {
    // Verify key by calling an authenticated endpoint.
    const res = await fetch(`${API_BASE}/api/manage/workers`, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    if (!res.ok) throw new Error('Invalid key');

    const workers = await res.json();
    const exists = Array.isArray(workers) && workers.some(w => w.id === id);
    if (!exists) throw new Error(`Worker ID ${id} not found`);

    STATE.workerId = id;
    STATE.workerKey = key;
    localStorage.setItem('worker_id', String(id));
    localStorage.setItem('worker_key', key);

    const dialog = document.getElementById('auth-dialog');
    if (dialog) {
      dialog.close();
      dialog.remove();
    }

    updateNavbar();
    navigate('/my-worker');
  } catch (err) {
    errorEl.textContent = err.message || 'Invalid key or connection error.';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

function logout() {
  if (confirm('Sign out?')) {
    STATE.workerKey = null;
    STATE.workerId = null;
    localStorage.removeItem('worker_key');
    localStorage.removeItem('worker_id');
    updateNavbar();
    navigate('/');
  }
}

// ===== Pages: Dashboard =====
// Backend: GET /api/stats/overview -> { total_files, downloading, downloaded, verifying, verified, failed, conflicts }
async function fetchOverview() {
  try {
    const data = await api('/api/stats/overview');
    STATE.overview = {
      total: data.total_files,
      downloading: data.downloading,
      downloaded: data.downloaded,
      verifying: data.verifying,
      verified: data.verified,
      failed: data.failed,
      conflict: data.conflicts,
    };
    updateNavbar();
    if (getCurrentPage() === 'dashboard') renderDashboard();
  } catch (err) {
    console.error('Failed to fetch overview:', err);
  }
}

function renderDashboard() {
  const o = STATE.overview;
  const started = (o.downloading || 0) + (o.downloaded || 0) + (o.verifying || 0) + (o.verified || 0) + (o.failed || 0);
  const progress = o.total > 0 ? Math.round((started / o.total) * 100) : 0;

  main.innerHTML = `
    <h1>Overview</h1>
    <div class="grid grid-4">
      <div class="card">
        <h4 style="margin: 0; color: var(--text-secondary); font-size: 0.875rem;">Total Files</h4>
        <p style="font-size: 2rem; margin: 0.5rem 0 0; font-weight: 600;">${o.total}</p>
      </div>
      <div class="card">
        <h4 style="margin: 0; color: var(--text-secondary); font-size: 0.875rem;">Downloading</h4>
        <p style="font-size: 2rem; margin: 0.5rem 0 0; font-weight: 600;">
          <span class="badge badge-warning">${o.downloading}</span>
        </p>
      </div>
      <div class="card">
        <h4 style="margin: 0; color: var(--text-secondary); font-size: 0.875rem;">Downloaded</h4>
        <p style="font-size: 2rem; margin: 0.5rem 0 0; font-weight: 600;">
          <span class="badge badge-success">${o.downloaded}</span>
        </p>
      </div>
      <div class="card">
        <h4 style="margin: 0; color: var(--text-secondary); font-size: 0.875rem;">Verifying</h4>
        <p style="font-size: 2rem; margin: 0.5rem 0 0; font-weight: 600;">
          <span class="badge badge-warning">${o.verifying}</span>
        </p>
      </div>
      <div class="card">
        <h4 style="margin: 0; color: var(--text-secondary); font-size: 0.875rem;">Verified</h4>
        <p style="font-size: 2rem; margin: 0.5rem 0 0; font-weight: 600;">
          <span class="badge badge-success">${o.verified}</span>
        </p>
      </div>
      <div class="card">
        <h4 style="margin: 0; color: var(--text-secondary); font-size: 0.875rem;">Failed</h4>
        <p style="font-size: 2rem; margin: 0.5rem 0 0; font-weight: 600;">
          <span class="badge badge-danger">${o.failed}</span>
        </p>
      </div>
      <div class="card">
        <h4 style="margin: 0; color: var(--text-secondary); font-size: 0.875rem;">Conflicts</h4>
        <p style="font-size: 2rem; margin: 0.5rem 0 0; font-weight: 600;">
          <span class="badge badge-warning">${o.conflict}</span>
        </p>
      </div>
    </div>

    <div class="card">
      <h3>Overall Progress</h3>
      <div class="progress-track" style="height: 20px;">
        <div class="progress-fill" style="width: ${progress}%"></div>
      </div>
      <p style="text-align: center; margin-top: 0.5rem;">${progress}% (${started} / ${o.total})</p>
    </div>
  `;
}

// ===== Pages: Browse =====
// - Subdirectories: SSE children[]
// - Files: REST /api/stats/dir?path=...
function renderBrowse(treePath) {
  const breadcrumbHtml = renderBreadcrumb(treePath);

  main.innerHTML = `
    <h1>Browse</h1>
    ${breadcrumbHtml}
    ${STATE.workerKey && STATE.workerId ? `
      <div class="card" style="padding: var(--spacing-sm) var(--spacing-lg);">
        <button class="btn btn-primary" id="claim-btn">Claim This Directory</button>
      </div>
    ` : ''}
    <div class="card" id="dir-content"><p>Loading directories...</p></div>
    <div class="card" id="file-content"><p>Loading files...</p></div>
  `;

  const claimBtn = main.querySelector('#claim-btn');
  if (claimBtn) claimBtn.onclick = () => claimDir(treePath);

  // Render any existing SSE data immediately (if any), then load files via REST.
  updateBrowseFromSSE();
  fetchBrowseFiles(treePath);
}

function updateBrowseFromSSE() {
  const dirContent = document.getElementById('dir-content');
  if (!dirContent) return;

  // Only render children for the currently subscribed path.
  if (!STATE.browseChildren || STATE.browseChildren.length === 0) {
    dirContent.innerHTML = '<p>No subdirectories (or still loading)...</p>';
    return;
  }

  let html = `
    <table class="table">
      <thead><tr><th>Name</th><th>Progress</th><th>Stats</th></tr></thead>
      <tbody>`;

  for (const child of STATE.browseChildren) {
    const childPath = (STATE.browsePath || '') + child.name + '/';
    const s = child.stats || {};
    const started = (s.downloading || 0) + (s.downloaded || 0) + (s.verifying || 0) + (s.verified || 0) + (s.failed || 0);

    html += `
      <tr style="cursor: pointer;" data-href="${toBrowseHref(childPath)}">
        <td>${escapeHtml(child.name)}</td>
        <td>${renderProgressBar(started, s.total || 0)}</td>
        <td>
          <span class="badge badge-success" title="Verified">${s.verified || 0}</span>
          <span class="badge badge-warning" title="In Progress">${(s.downloading || 0) + (s.verifying || 0)}</span>
          <span class="badge badge-danger" title="Failed">${s.failed || 0}</span>
          ${s.conflict ? `<span class="badge badge-warning" title="Conflicts">${s.conflict}</span>` : ''}
        </td>
      </tr>`;
  }

  html += '</tbody></table>';
  dirContent.innerHTML = html;

  dirContent.querySelectorAll('tr[data-href]').forEach(row => {
    row.onclick = () => navigate(row.dataset.href);
  });
}

async function fetchBrowseFiles(treePath) {
  const fileContent = document.getElementById('file-content');
  if (!fileContent) return;

  try {
    const data = await api(`/api/stats/dir?path=${encodeURIComponent(treePath)}`);

    // Cache dir_id ↔ path mapping from REST response.
    if (data.dir_id != null && data.path) {
      STATE.dirPaths[data.dir_id] = data.path;
      STATE.pathToDirId[data.path] = data.dir_id;
      persistMappings();
    }

    const files = data.files || [];

    if (files.length === 0) {
      fileContent.innerHTML = '<p>No files in this directory.</p>';
      return;
    }

    let html = `
      <table class="table">
        <thead><tr><th>Name</th><th>Size</th><th>Status</th></tr></thead>
        <tbody>`;

    for (const f of files) {
      html += `
        <tr>
          <td>${escapeHtml(f.name)}</td>
          <td>${formatSize(f.size)}</td>
          <td>${renderStatusBadge(f.best_status)}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    fileContent.innerHTML = html;
  } catch (err) {
    fileContent.innerHTML = `<p>Failed to load files: ${escapeHtml(err.message)}</p>`;
  }
}

function renderBreadcrumb(treePath) {
  const segments = treePath.split('/').filter(Boolean);
  let html = '<div class="breadcrumb">';
  html += `<a href="/browse">root</a>`;

  segments.forEach((seg, i) => {
    const partial = '/' + segments.slice(0, i + 1).join('/') + '/';
    html += '<span>/</span>';
    if (i < segments.length - 1) {
      html += `<a href="${toBrowseHref(partial)}">${escapeHtml(seg)}</a>`;
    } else {
      html += `<span>${escapeHtml(seg)}</span>`;
    }
  });

  html += '</div>';
  return html;
}

// ===== Pages: My Worker =====
// Backend: GET /api/stats/worker/{id}
async function renderMyWorker() {
  if (!STATE.workerKey || !STATE.workerId) {
    main.innerHTML = `
      <div class="card">
        <h2>Not Connected</h2>
        <p>Please bind a worker key to continue.</p>
        <button class="btn btn-primary" id="auth-prompt">Bind Worker</button>
      </div>`;
    main.querySelector('#auth-prompt').onclick = showAuthDialog;
    return;
  }

  main.innerHTML = '<h1>My Worker</h1><div class="card"><p>Loading...</p></div>';

  try {
    const data = await api(`/api/stats/worker/${STATE.workerId}`);
    const worker = data.worker;
    const claims = data.claims || [];
    const heartbeat = data.heartbeat;

    const config = decodeBase64Json(worker.config) || {};

    main.innerHTML = `
      <h1>My Worker: ${escapeHtml(worker.name || ('Worker #' + worker.id))}</h1>

      <div class="card">
        <h3>Status</h3>
        <p>Status: ${renderStringBadge(data.online ? 'online' : 'offline')}</p>
        ${heartbeat ? `
          <p>Disk Free: ${heartbeat.disk_free_gb != null ? heartbeat.disk_free_gb.toFixed(2) + ' GB' : 'Unknown'}</p>
          <p>Tasks: ${heartbeat.downloading || 0} downloading, ${heartbeat.verifying || 0} verifying</p>
          <p>Aria2: ${escapeHtml(heartbeat.aria2_status || 'Unknown')}</p>
        ` : '<p>No heartbeat data (worker may be offline).</p>'}
        ${data.last_seen ? `<p>Last Seen: ${new Date(data.last_seen).toLocaleString()}</p>` : ''}
      </div>

      <div class="card">
        <h3>Active Claims</h3>
        ${claims.length > 0 ? `
          <table class="table">
            <thead><tr><th>Dir ID</th><th>Path</th><th>Claimed At</th><th>Action</th></tr></thead>
            <tbody>
              ${claims.map(c => {
                const path = STATE.dirPaths[c.dir_id] || '';
                return `
                  <tr>
                    <td>${c.dir_id}</td>
                    <td>${path ? `<a href="${toBrowseHref(path)}">${escapeHtml(path)}</a>` : '<em>Unknown</em>'}</td>
                    <td>${new Date(c.claimed_at).toLocaleString()}</td>
                    <td>${path
                      ? `<button class="btn btn-sm btn-danger" data-dir-path="${escapeAttr(path)}">Release</button>`
                      : '<span style="color: var(--text-secondary); font-size: 0.8rem;">Browse dir first to learn path</span>'
                    }</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        ` : '<p>No active claims.</p>'}
      </div>

      <div class="card">
        <h3>Configuration</h3>
        <form id="config-form">
          <div class="flex flex-col gap-2">
            <label>Download Concurrency: <input type="number" name="download_concurrency" value="${config.download_concurrency || 3}" class="input" /></label>
            <label>Verify Concurrency: <input type="number" name="verify_concurrency" value="${config.verify_concurrency || 3}" class="input" /></label>
            <label style="display: flex; align-items: center; gap: 0.5rem;">
              <input type="checkbox" name="simultaneous" ${config.simultaneous ? 'checked' : ''} />
              Simultaneous Download &amp; Verify
            </label>
          </div>
          <br/>
          <button type="submit" class="btn btn-primary">Save</button>
        </form>
      </div>
    `;

    main.querySelectorAll('button[data-dir-path]').forEach(btn => {
      btn.onclick = () => releaseClaim(btn.dataset.dirPath);
    });
    main.querySelector('#config-form').onsubmit = updateConfig;

  } catch (err) {
    console.error(err);
    main.innerHTML = '<div class="card"><p>Failed to load worker info. Check connection.</p></div>';
  }
}

// ===== Pages: Conflicts =====
// Backend: GET /api/manage/conflicts?dir_id=... (auth)
function renderConflicts() {
  if (!STATE.workerKey) {
    main.innerHTML = `
      <h1>Conflicts</h1>
      <div class="card">
        <p>Authentication required to view conflicts. Please bind a worker first.</p>
        <button class="btn btn-primary" id="auth-for-conflicts">Bind Worker</button>
      </div>`;
    main.querySelector('#auth-for-conflicts').onclick = showAuthDialog;
    return;
  }

  main.innerHTML = `
    <h1>Conflicts</h1>
    <div class="card">
      <form id="conflict-form" class="flex gap-2 items-center">
        <label style="white-space: nowrap;">Directory ID:</label>
        <input type="number" id="conflict-dir-id" class="input" style="width: 140px;" required />
        <button type="submit" class="btn btn-primary">Check</button>
      </form>
    </div>
    <div class="card" id="conflict-results">
      <p>Enter a directory ID to check for file hash conflicts.</p>
    </div>
  `;

  main.querySelector('#conflict-form').onsubmit = async (e) => {
    e.preventDefault();
    const dirId = document.getElementById('conflict-dir-id').value;
    const resultsEl = document.getElementById('conflict-results');

    resultsEl.innerHTML = '<p>Loading...</p>';

    try {
      const conflicts = await api(`/api/manage/conflicts?dir_id=${encodeURIComponent(dirId)}`);

      if (!conflicts || conflicts.length === 0) {
        resultsEl.innerHTML = '<p>No conflicts found for this directory.</p>';
        return;
      }

      let html = `
        <table class="table">
          <thead><tr><th>File Index</th><th>File Name</th><th>Reports</th></tr></thead>
          <tbody>`;

      for (const c of conflicts) {
        const reportDetails = (c.reports || []).map(r => {
          const status = STATUS_LABELS[r.status] || 'unknown';
          const sha1 = r.sha1 ? base64ToHex(r.sha1) : null;
          const crc32 = r.crc32 ? base64ToHex(r.crc32) : null;
          const hashes = [sha1 ? `SHA1: ${sha1}` : null, crc32 ? `CRC32: ${crc32}` : null].filter(Boolean).join(' | ');
          return `Worker #${r.worker_id}: ${status}${hashes ? ' (' + hashes + ')' : ''}`;
        }).join('<br>');

        html += `
          <tr>
            <td>${c.file_idx}</td>
            <td>${escapeHtml(c.file_name)}</td>
            <td style="font-size: 0.8rem;">${reportDetails || '-'}</td>
          </tr>`;
      }

      html += '</tbody></table>';
      resultsEl.innerHTML = html;
    } catch (err) {
      resultsEl.innerHTML = `<p>Failed to load conflicts: ${escapeHtml(err.message)}</p>`;
    }
  };
}

// ===== Actions =====
// Claim: POST /api/manage/claim { worker_id, dir_path }
async function claimDir(treePath) {
  if (!STATE.workerId) {
    alert('Please bind a worker first.');
    return;
  }
  if (!treePath) {
    alert('Directory path not resolved yet.');
    return;
  }

  try {
    const result = await api('/api/manage/claim', {
      method: 'POST',
      body: JSON.stringify({ worker_id: STATE.workerId, dir_path: treePath })
    });

    // Cache mapping for later release.
    if (result && result.dir_id != null) {
      STATE.dirPaths[result.dir_id] = treePath;
      STATE.pathToDirId[treePath] = result.dir_id;
      persistMappings();
    }

    alert('Claimed successfully!');
    navigate('/my-worker');
  } catch (err) {
    alert('Failed to claim: ' + err.message);
  }
}

// Release: DELETE /api/manage/claim { worker_id, dir_path }
async function releaseClaim(dirPath) {
  if (!confirm('Release this directory?')) return;
  try {
    await api('/api/manage/claim', {
      method: 'DELETE',
      body: JSON.stringify({ worker_id: STATE.workerId, dir_path: dirPath })
    });
    renderMyWorker();
  } catch (err) {
    alert('Failed to release: ' + err.message);
  }
}

// Config: PATCH /api/manage/worker/{id}/config
async function updateConfig(e) {
  e.preventDefault();
  const formData = new FormData(e.target);
  const config = {
    download_concurrency: parseInt(formData.get('download_concurrency'), 10),
    verify_concurrency: parseInt(formData.get('verify_concurrency'), 10),
    simultaneous: formData.has('simultaneous'),
  };

  try {
    await api(`/api/manage/worker/${STATE.workerId}/config`, {
      method: 'PATCH',
      body: JSON.stringify(config)
    });
    alert('Config updated!');
  } catch (err) {
    alert('Failed to update: ' + err.message);
  }
  return false;
}

// ===== UI Helpers =====
function renderStatusBadge(numericStatus) {
  const label = STATUS_LABELS[numericStatus] || 'unknown';
  const variant = STATUS_VARIANTS[numericStatus] || '';
  return `<span class="badge ${variant ? 'badge-' + variant : ''}">${label}</span>`;
}

function renderStringBadge(str) {
  const variants = { online: 'success', offline: 'danger' };
  const v = variants[str] || '';
  return `<span class="badge ${v ? 'badge-' + v : ''}">${str}</span>`;
}

function renderProgressBar(current, total) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return `
    <div class="progress-track" style="width: 100px; display: inline-block; vertical-align: middle; margin-right: 8px;">
      <div class="progress-fill" style="width: ${pct}%"></div>
    </div>
    <span style="font-size: 0.75rem;">${pct}%</span>
  `;
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0) + ' ' + units[i];
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

function safeJsonParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function decodeBase64Json(b64) {
  if (!b64) return null;
  if (typeof b64 === 'object') return b64; // if backend ever changes to JSON object
  if (typeof b64 !== 'string') return null;

  try {
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

function base64ToHex(b64) {
  if (!b64 || typeof b64 !== 'string') return '';
  try {
    const bin = atob(b64);
    let hex = '';
    for (let i = 0; i < bin.length; i++) {
      hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    // If it's not base64, return as-is.
    return b64;
  }
}

// ===== Init =====
createLayout();
fetchOverview();
setInterval(fetchOverview, 15000);
route();
