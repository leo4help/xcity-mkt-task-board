(function() {
  'use strict';

  const STATUS_ORDER = ['To Do', 'Processing', 'Waiting', 'On Hold', 'Done'];
  const STATUS_SLUG = {
    'To Do': 'to-do',
    'Processing': 'processing',
    'Waiting': 'waiting',
    'On Hold': 'on-hold',
    'Done': 'done'
  };

  const AUTH_KEY = 'xcity_marketing_auth_token';
  const AUTH_EXPIRY_DAYS = 7;

  const state = {
    tasks: [],
    projects: [],
    summary: null,
    filters: { priorityBand: '', status: '', blocked: '', search: '' },
    editingId: null,
    activeSection: (location.hash || '#overview').slice(1)
  };

  const $ = (id) => document.getElementById(id);

  // ── Auth（預設關閉，config.js 的 REQUIRE_PASSWORD 控制）──────────────────

  function hashPassword(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  function checkAuth() {
    const stored = localStorage.getItem(AUTH_KEY);
    if (!stored) return false;
    try {
      const data = JSON.parse(stored);
      if (data.expiry < Date.now()) {
        localStorage.removeItem(AUTH_KEY);
        return false;
      }
      return data.hash === hashPassword(window.XCITY_CONFIG.PASSWORD);
    } catch (e) {
      return false;
    }
  }

  function saveAuth() {
    const data = {
      hash: hashPassword(window.XCITY_CONFIG.PASSWORD),
      expiry: Date.now() + AUTH_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    };
    localStorage.setItem(AUTH_KEY, JSON.stringify(data));
  }

  function unlock() {
    $('lock-screen').style.display = 'none';
    $('app').style.display = 'block';
    bindEvents();
    loadAndRender();
  }

  function tryPassword() {
    const input = $('lock-input').value;
    const err = $('lock-error');
    if (input === window.XCITY_CONFIG.PASSWORD) {
      saveAuth();
      err.textContent = '';
      unlock();
    } else {
      err.textContent = '密碼錯誤';
      $('lock-input').value = '';
      $('lock-input').focus();
    }
  }

  function initAuth() {
    const requirePassword = window.XCITY_CONFIG && window.XCITY_CONFIG.REQUIRE_PASSWORD;
    if (!requirePassword) {
      unlock();
      return;
    }
    if (checkAuth()) {
      unlock();
      return;
    }
    $('lock-screen').style.display = 'flex';
    $('lock-submit').addEventListener('click', tryPassword);
    $('lock-input').addEventListener('keydown', e => { if (e.key === 'Enter') tryPassword(); });
    setTimeout(() => $('lock-input').focus(), 100);
  }

  // ── Utils ────────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function slugify(str) {
    return 'proj-' + String(str).toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'proj-unnamed';
  }

  function statusTagClass(status) {
    return 'tag status-' + (STATUS_SLUG[status] || 'to-do');
  }

  function priorityBand(score) {
    const n = Number(score) || 0;
    if (n >= 8) return 'high';
    if (n >= 4) return 'mid';
    return 'low';
  }

  // Processing（執行中）的期限代表「執行到什麼時候」而不是「要完成的截止日」，
  // 留空＝沒有固定期限、會一直做下去；有日期則不套用逾期判斷，改用「執行至」的說法跟其他任務區隔開。
  function getDueInfo(deadline, today, status) {
    if (status === 'Processing') {
      if (!deadline) return { text: '無固定期限', cls: 'due-ongoing' };
      if (deadline < today) return { text: '執行至 ' + deadline + '・請確認狀態', cls: 'due-today' };
      if (deadline === today) return { text: '執行至今日', cls: 'due-today' };
      return { text: '執行至 ' + deadline, cls: 'due-ongoing' };
    }

    if (!deadline) return { text: '待訂', cls: 'due-normal' };
    if (status === 'Done' || status === 'On Hold') return { text: deadline, cls: 'due-normal' };
    const d1 = new Date(deadline);
    const d2 = new Date(today);
    const diffDays = Math.round((d1 - d2) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return { text: '逾期 ' + Math.abs(diffDays) + ' 天', cls: 'due-overdue' };
    if (diffDays === 0) return { text: '今日到期', cls: 'due-today' };
    if (diffDays <= 3) return { text: diffDays + ' 天後・' + deadline, cls: 'due-soon' };
    return { text: deadline, cls: 'due-normal' };
  }

  // ── API ──────────────────────────────────────────────────────────────────

  function requireConfig() {
    if (!window.XCITY_CONFIG || !window.XCITY_CONFIG.API_URL || !window.XCITY_CONFIG.API_TOKEN) {
      throw new Error('config.js 未正確設定 API_URL 或 API_TOKEN');
    }
  }

  function isDemoMode() {
    return Array.isArray(window.XCITY_DEMO_TASKS) && typeof window.XCITY_DEMO_BUILD_SUMMARY === 'function';
  }

  async function fetchData() {
    if (isDemoMode()) {
      return { tasks: window.XCITY_DEMO_TASKS, summary: window.XCITY_DEMO_BUILD_SUMMARY(window.XCITY_DEMO_TASKS) };
    }
    requireConfig();
    const url = window.XCITY_CONFIG.API_URL + '?token=' + encodeURIComponent(window.XCITY_CONFIG.API_TOKEN) + '&action=all';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  function nextDemoId(project) {
    const letterIdx = Array.from(new Set(window.XCITY_DEMO_TASKS.map(t => t.project))).indexOf(project);
    const letter = String.fromCharCode(65 + (letterIdx === -1 ? window.XCITY_DEMO_TASKS.length : letterIdx));
    const nums = window.XCITY_DEMO_TASKS
      .filter(t => t.project === project)
      .map(t => { const m = String(t.id).match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; });
    const max = nums.length ? Math.max.apply(null, nums) : 0;
    return letter + (max + 1);
  }

  function demoPostApi(action, extra) {
    const tasks = window.XCITY_DEMO_TASKS;
    if (action === 'addTask') {
      const task = Object.assign({ id: nextDemoId(extra.task.project) }, extra.task);
      task.blocked = !!(task.supportNeed && task.supportNeed.trim());
      tasks.push(task);
      return { ok: true, task };
    }
    if (action === 'updateTask') {
      const idx = tasks.findIndex(t => t.id === extra.id);
      if (idx === -1) return { error: '找不到任務 ID：' + extra.id };
      tasks[idx] = Object.assign({}, tasks[idx], extra.task);
      tasks[idx].blocked = !!(tasks[idx].supportNeed && tasks[idx].supportNeed.trim());
      return { ok: true, task: tasks[idx] };
    }
    if (action === 'deleteTask') {
      const idx = tasks.findIndex(t => t.id === extra.id);
      if (idx !== -1) tasks.splice(idx, 1);
      return { ok: true };
    }
    return { error: '未知的 action：' + action };
  }

  async function postApi(action, extra) {
    if (isDemoMode()) return demoPostApi(action, extra);
    requireConfig();
    const body = Object.assign({ action, token: window.XCITY_CONFIG.API_TOKEN }, extra);
    const res = await fetch(window.XCITY_CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  // ── Render: KPI / nav ───────────────────────────────────────────────────

  function renderKPIs() {
    const s = state.summary;
    if (!s) return;
    $('kpi-doing').textContent = s.inProgressCount;
    $('kpi-today').textContent = s.dueTodayCount;
    $('kpi-blocked').textContent = s.blockedCount;
    $('kpi-completion').textContent = s.completionRate + '%';
    $('overview-tag').textContent = state.projects.length + ' 個專案・共 ' + s.total + ' 筆任務';
  }

  function renderProjectNav() {
    const links = ['<a href="#overview">總覽</a>'].concat(
      state.projects.map(p => `<a href="#${slugify(p.project)}">${escapeHtml(p.projectLabel || p.project)}</a>`)
    );
    $('project-nav').innerHTML = links.join('');
  }

  // ── Tabs：每個分類（總覽／單一專案）各自佔一整頁，不是同一長頁往下滾動 ──

  function activateSection(id) {
    const validIds = ['overview'].concat(state.projects.map(p => slugify(p.project)));
    if (!validIds.includes(id)) id = 'overview';
    state.activeSection = id;

    const overviewEl = $('overview');
    if (overviewEl) overviewEl.classList.toggle('tab-hidden', id !== 'overview');

    document.querySelectorAll('#project-sections > section').forEach(sec => {
      sec.classList.toggle('tab-hidden', sec.id !== id);
    });

    document.querySelectorAll('#project-nav a').forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === '#' + id);
    });
  }

  function bindNavClicks() {
    $('project-nav').addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      const id = a.getAttribute('href').slice(1);
      activateSection(id);
      history.replaceState(null, '', '#' + id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  function taskMatchesFilters(t) {
    if (state.filters.priorityBand && priorityBand(t.priority) !== state.filters.priorityBand) return false;
    if (state.filters.status && t.status !== state.filters.status) return false;
    if (state.filters.blocked === 'yes' && !t.blocked) return false;
    if (state.filters.search) {
      const q = state.filters.search.toLowerCase();
      if (!(t.name || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }

  // ── Render: Project sections ────────────────────────────────────────────

  function renderProjectSections() {
    const today = state.summary ? state.summary.today : new Date().toISOString().slice(0, 10);

    if (state.projects.length === 0) {
      $('project-sections').innerHTML = '<div class="empty-state">還沒有任務，點右上角「+ 新增任務」開始吧。</div>';
      activateSection('overview');
      return;
    }

    const html = state.projects.map(proj => {
      const visibleTasks = proj.tasks.filter(taskMatchesFilters);
      const blockedInProject = proj.tasks.filter(t => t.blocked);

      const rowsHtml = visibleTasks.length > 0
        ? visibleTasks.map(t => renderTaskRow(t, today)).join('')
        : '<tr><td colspan="5" class="empty-state">沒有符合篩選條件的任務</td></tr>';

      const supportHtml = blockedInProject.length > 0 ? `
        <div class="callout support">
          ${blockedInProject.map(t => `
            <div class="support-item">
              <div class="support-item-title">🚧 ${escapeHtml(t.name)}</div>
              <div class="support-item-meta">${escapeHtml(t.status || '')} · ${escapeHtml(getDueInfo(t.deadline, today, t.status).text)} · 優先度 ${escapeHtml(t.priority)}</div>
              <div class="support-item-need">${escapeHtml(t.supportNeed || '')}</div>
            </div>
          `).join('')}
        </div>` : '';

      return `
        <section id="${slugify(proj.project)}" class="project-card card">
          <div class="project-head">
            <div class="project-name">${escapeHtml(proj.projectLabel || proj.project)}</div>
            <div class="project-progress-chip"><b>${proj.done}</b> / ${proj.total} 已完成（${proj.completionRate}%）${proj.blocked > 0 ? ` · <span style="color:var(--bad);">🚧 ${proj.blocked} 筆需要支援</span>` : ''}</div>
          </div>
          <div class="project-bar-wrap"><div class="project-bar" style="width:${proj.completionRate}%;"></div></div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>任務名稱</th><th>狀態</th><th>優先度</th><th>期限</th><th>需要支援</th></tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          ${supportHtml}
        </section>`;
    }).join('');

    $('project-sections').innerHTML = html;
    bindTaskRowClicks();
    activateSection(state.activeSection);
  }

  function renderTaskRow(t, today) {
    const due = getDueInfo(t.deadline, today, t.status);
    const priCls = 'priority-' + priorityBand(t.priority);

    return `<tr data-id="${escapeHtml(t.id)}">
      <td class="name-cell">${escapeHtml(t.name)}</td>
      <td><span class="${statusTagClass(t.status)}">${escapeHtml(t.status || '-')}</span></td>
      <td><span class="tag priority-chip ${priCls}">${escapeHtml(t.priority)}</span></td>
      <td><span class="due-pill ${due.cls}">${escapeHtml(due.text)}</span></td>
      <td>${t.blocked ? escapeHtml(t.supportNeed) : ''}</td>
    </tr>`;
  }

  function bindTaskRowClicks() {
    document.querySelectorAll('#project-sections tbody tr[data-id]').forEach(el => {
      el.addEventListener('click', () => openModal(el.dataset.id));
    });
  }

  function render() {
    renderKPIs();
    renderProjectNav();
    renderProjectSections();
  }

  async function loadAndRender() {
    const btn = $('refresh-btn');
    btn.classList.add('spinning');
    try {
      const data = await fetchData();
      state.tasks = data.tasks || [];
      state.projects = (data.summary && data.summary.projects) || [];
      state.summary = data.summary || null;
      const now = new Date();
      $('last-updated').textContent = '最後更新：' + now.toLocaleString('zh-TW', { hour12: false });
      render();
    } catch (err) {
      console.error(err);
      $('project-sections').innerHTML = `<div class="error">載入失敗：${escapeHtml(err.message)}<br><br>請檢查 config.js 的 API_URL 和 API_TOKEN 是否正確。</div>`;
    } finally {
      btn.classList.remove('spinning');
    }
  }

  // ── Modal（新增 / 編輯）─────────────────────────────────────────────────

  // 分頁名稱如果是「專案A_...」這種「專案＋英文字母」開頭的命名慣例，顯示時把前綴拿掉
  function displayProjectName(name) {
    const m = String(name).match(/^專案[A-Za-z]+[_\-\s]*(.*)$/);
    if (m && m[1]) return m[1].trim();
    return name;
  }

  function projectOptions() {
    const configured = (window.XCITY_CONFIG && window.XCITY_CONFIG.PROJECTS) || [];
    const labelMap = {};
    state.projects.forEach(p => { labelMap[p.project] = p.projectLabel || p.project; });
    const all = Array.from(new Set(configured.concat(Object.keys(labelMap))));
    return all.map(p => {
      const label = labelMap[p] || displayProjectName(p);
      return `<option value="${escapeHtml(p)}">${escapeHtml(label)}</option>`;
    }).join('');
  }

  function openModal(id) {
    state.editingId = id || null;
    const task = id ? state.tasks.find(t => t.id === id) : null;

    const projectFieldHtml = task ? `
      <div class="form-row">
        <label>專案</label>
        <input type="text" value="${escapeHtml(task.projectLabel || task.project)}" disabled style="background:var(--tan-soft);color:var(--ink-soft);">
        <div class="hint-text">編輯時不能換專案，要換的話請新增到別的專案再刪除這筆</div>
      </div>` : `
      <div class="form-row">
        <label>專案 / Campaign</label>
        <input type="text" list="project-list" id="f-project" placeholder="輸入現有專案名稱，或打新名稱自動建立新分頁">
        <datalist id="project-list">${projectOptions()}</datalist>
      </div>`;

    const html = `
      <div class="modal-overlay" id="modal-overlay">
        <div class="modal-box">
          <h3>${task ? '編輯任務' : '新增任務'}</h3>
          <div class="form-row">
            <label>任務名稱</label>
            <input type="text" id="f-name" value="${escapeHtml(task ? task.name : '')}">
          </div>
          ${projectFieldHtml}
          <div class="form-row">
            <label>優先度（1～10 分，分數越高越優先）</label>
            <input type="number" id="f-priority" min="1" max="10" step="1" value="${task ? escapeHtml(task.priority) : 5}">
          </div>
          <div class="form-row">
            <label>狀態</label>
            <select id="f-status">
              ${STATUS_ORDER.map(s => `<option value="${s}"${task && task.status === s ? ' selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>期限</label>
            <input type="date" id="f-deadline" value="${escapeHtml(task ? task.deadline : '')}">
            <div class="hint-text">留空＝沒有固定期限。狀態是 Processing 時，填日期代表「執行到什麼時候」；其他狀態則是一般的截止日。</div>
          </div>
          <div class="form-row">
            <label>需要支援（卡在哪裡 / 需要什麼支援；不需要支援就留空）</label>
            <textarea id="f-support" placeholder="留空＝不需要支援；有填內容＝這筆任務會顯示為需要支援">${escapeHtml(task ? task.supportNeed : '')}</textarea>
          </div>
          <div class="modal-actions">
            <div>${task ? '<button class="btn-danger" id="btn-delete">刪除任務</button>' : ''}</div>
            <div class="modal-actions-right">
              <button class="btn-secondary" id="btn-cancel">取消</button>
              <button class="btn-primary" id="btn-save">儲存</button>
            </div>
          </div>
        </div>
      </div>`;

    $('modal-root').innerHTML = html;
    $('btn-cancel').addEventListener('click', closeModal);
    $('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
    $('btn-save').addEventListener('click', saveTask);
    if (task) $('btn-delete').addEventListener('click', deleteTask);
  }

  function closeModal() {
    $('modal-root').innerHTML = '';
    state.editingId = null;
  }

  async function saveTask() {
    const name = $('f-name').value.trim();
    if (!name) { alert('請輸入任務名稱'); return; }

    const existingTask = state.editingId ? state.tasks.find(t => t.id === state.editingId) : null;
    const project = existingTask ? existingTask.project : ($('f-project').value.trim());
    if (!project) { alert('請輸入專案名稱'); return; }

    const priority = Math.max(1, Math.min(10, parseInt($('f-priority').value, 10) || 5));

    const payload = {
      name,
      priority,
      status: $('f-status').value,
      deadline: $('f-deadline').value,
      supportNeed: $('f-support').value.trim()
    };
    if (!existingTask) payload.project = project;

    const btn = $('btn-save');
    btn.textContent = '儲存中...';
    btn.disabled = true;
    try {
      if (state.editingId) {
        await postApi('updateTask', { id: state.editingId, task: payload });
      } else {
        await postApi('addTask', { task: payload });
      }
      closeModal();
      await loadAndRender();
    } catch (err) {
      alert('儲存失敗：' + err.message);
      btn.textContent = '儲存';
      btn.disabled = false;
    }
  }

  async function deleteTask() {
    if (!confirm('確定要刪除這個任務嗎？')) return;
    try {
      await postApi('deleteTask', { id: state.editingId });
      closeModal();
      await loadAndRender();
    } catch (err) {
      alert('刪除失敗：' + err.message);
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────

  function bindEvents() {
    $('filter-priority').addEventListener('change', e => { state.filters.priorityBand = e.target.value; renderProjectSections(); });
    $('filter-status').addEventListener('change', e => { state.filters.status = e.target.value; renderProjectSections(); });
    $('filter-blocked').addEventListener('change', e => { state.filters.blocked = e.target.value; renderProjectSections(); });
    $('filter-search').addEventListener('input', e => { state.filters.search = e.target.value; renderProjectSections(); });

    $('filter-reset').addEventListener('click', () => {
      state.filters = { priorityBand: '', status: '', blocked: '', search: '' };
      $('filter-priority').value = '';
      $('filter-status').value = '';
      $('filter-blocked').value = '';
      $('filter-search').value = '';
      renderProjectSections();
    });

    $('refresh-btn').addEventListener('click', loadAndRender);
    $('add-task-btn').addEventListener('click', () => openModal(null));
    bindNavClicks();

    if (window.XCITY_CONFIG && window.XCITY_CONFIG.SHEET_URL) {
      $('sheet-link').href = window.XCITY_CONFIG.SHEET_URL;
    }
  }

  initAuth();
})();
