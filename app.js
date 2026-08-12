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

  const PARTNER_STATUS_LIST = ['To Do', 'Doing', 'Done'];

  const state = {
    tasks: [],
    projects: [],
    summary: null,
    filters: { priorityBand: '', status: '', blocked: '', search: '' },
    editingId: null,
    activeSection: (location.hash || '#overview').slice(1),
    sort: { column: 'deadline', dir: 'asc' }, // 預設用期限排序，越近的排越上面
    partnerTasks: [],
    partnerList: [],
    editingPartnerId: null
  };

  const SORT_COLUMNS = [
    { key: 'name', label: '任務名稱' },
    { key: 'status', label: '狀態' },
    { key: 'priority', label: '優先度' },
    { key: 'deadline', label: '期限' },
    { key: 'supportNeed', label: '需要支援' },
    { key: 'note', label: '備注' }
  ];

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

  // 已完成數旁邊用括號附註持續執行中的數量，例如 "1,(2)"（1 筆 Done、2 筆 Processing）；
  // 沒有 Done 只有 Processing 時只顯示 "(2)"；都沒有 Processing 就正常顯示數字。
  function doneProcessingText(done, processing) {
    if (processing > 0 && done > 0) return done + ',(' + processing + ')';
    if (processing > 0) return '(' + processing + ')';
    return String(done);
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
      const summary = window.XCITY_DEMO_BUILD_SUMMARY(window.XCITY_DEMO_TASKS);
      return {
        tasks: window.XCITY_DEMO_TASKS,
        summary,
        partnerTasks: resolveDemoPartnerTasks(),
        partnerList: getDemoPartnerList()
      };
    }
    requireConfig();
    const url = window.XCITY_CONFIG.API_URL + '?token=' + encodeURIComponent(window.XCITY_CONFIG.API_TOKEN) + '&action=all';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  // 依「目前已有幾個專案」對應字母：0→A, 1→B ... 25→Z, 26→AA ...（跟 Code.gs 的 numberToLetters_ 邏輯一致）
  function numberToLetters(n) {
    let s = '';
    n = n + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // 新建立專案時自動加上「專案X_」前綴，跟 Code.gs 的 buildAutoProjectTabName_ 邏輯一致
  function buildAutoProjectName(rawName, existingProjects) {
    if (/^專案[A-Za-z]+[_\-\s]/.test(rawName)) return rawName;
    return '專案' + numberToLetters(existingProjects.length) + '_' + rawName;
  }

  function nextDemoId(project) {
    const letterIdx = Array.from(new Set(window.XCITY_DEMO_TASKS.map(t => t.project))).indexOf(project);
    const letter = numberToLetters(letterIdx === -1 ? new Set(window.XCITY_DEMO_TASKS.map(t => t.project)).size : letterIdx);
    const nums = window.XCITY_DEMO_TASKS
      .filter(t => t.project === project)
      .map(t => { const m = String(t.id).match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; });
    const max = nums.length ? Math.max.apply(null, nums) : 0;
    return letter + (max + 1);
  }

  // 依「關聯專案／關聯任務」把夥伴支援項目補上顯示用的 projectLabel / taskName，邏輯對應 Code.gs 的 readPartnerTasks_
  function resolveDemoPartnerTasks() {
    const tasks = window.XCITY_DEMO_TASKS;
    const list = window.XCITY_DEMO_PARTNER_TASKS || [];
    return list.map(p => {
      const relatedTask = p.taskId ? tasks.find(t => t.id === p.taskId) : null;
      const projTask = p.project ? tasks.find(t => t.project === p.project) : null;
      return Object.assign({}, p, {
        projectLabel: projTask ? (projTask.projectLabel || projTask.project) : (p.project || ''),
        taskName: relatedTask ? relatedTask.name : ''
      });
    });
  }

  function getDemoPartnerList() {
    const used = (window.XCITY_DEMO_PARTNER_TASKS || []).map(p => p.partner).filter(Boolean);
    return Array.from(new Set((window.XCITY_DEMO_DEFAULT_PARTNERS || []).concat(used)));
  }

  function nextDemoPartnerId() {
    const list = window.XCITY_DEMO_PARTNER_TASKS || [];
    const nums = list.map(p => { const m = String(p.id).match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; });
    const max = nums.length ? Math.max.apply(null, nums) : 0;
    return 'P' + (max + 1);
  }

  function demoPostApi(action, extra) {
    const tasks = window.XCITY_DEMO_TASKS;
    if (action === 'addPartnerTask') {
      if (!window.XCITY_DEMO_PARTNER_TASKS) window.XCITY_DEMO_PARTNER_TASKS = [];
      const list = window.XCITY_DEMO_PARTNER_TASKS;
      const task = Object.assign({ id: nextDemoPartnerId() }, extra.task);
      list.push(task);
      return { ok: true, task };
    }
    if (action === 'updatePartnerTask') {
      const list = window.XCITY_DEMO_PARTNER_TASKS || [];
      const idx = list.findIndex(p => p.id === extra.id);
      if (idx === -1) return { error: '找不到夥伴支援項目 ID：' + extra.id };
      list[idx] = Object.assign({}, list[idx], extra.task);
      return { ok: true, task: list[idx] };
    }
    if (action === 'deletePartnerTask') {
      const list = window.XCITY_DEMO_PARTNER_TASKS || [];
      const idx = list.findIndex(p => p.id === extra.id);
      if (idx !== -1) list.splice(idx, 1);
      return { ok: true };
    }
    if (action === 'addTask') {
      const existingProjects = Array.from(new Set(tasks.map(t => t.project)));
      const rawProject = (extra.task.project || '').trim();
      const project = existingProjects.includes(rawProject) ? rawProject : buildAutoProjectName(rawProject, existingProjects);
      const task = Object.assign({ id: nextDemoId(project) }, extra.task, { project });
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
    $('kpi-total').textContent = s.total;
    $('kpi-doing').textContent = s.inProgressCount;
    $('kpi-completion').textContent = s.completionRate + '%';
    $('kpi-blocked').textContent = s.blockedCount;
    $('overview-tag').textContent = state.projects.length + ' 個專案・共 ' + s.total + ' 筆任務';
  }

  function renderProjectNav() {
    const links = ['<a href="#overview">總覽</a>'].concat(
      state.projects.map(p => `<a href="#${slugify(p.project)}">${escapeHtml(p.projectLabel || p.project)}</a>`)
    ).concat(['<a href="#partners">夥伴支援</a>']);
    $('project-nav').innerHTML = links.join('');
  }

  function renderOverviewProjectsTable() {
    const tbody = $('overview-projects-body');
    if (!tbody) return;

    if (state.projects.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">還沒有專案</td></tr>';
      return;
    }

    tbody.innerHTML = state.projects.map(p => {
      const todoCount = (p.tasks || []).filter(t => t.status === 'To Do').length;
      return `
      <tr data-id="${escapeHtml(slugify(p.project))}">
        <td class="name-cell">${escapeHtml(p.projectLabel || p.project)}</td>
        <td>${p.total}</td>
        <td>${todoCount}</td>
        <td>${p.completionRate}%</td>
        <td>${p.blocked > 0 ? `<span style="color:var(--bad);font-weight:700;">🚩 ${p.blocked}</span>` : '-'}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-id]').forEach(el => {
      el.addEventListener('click', () => {
        activateSection(el.dataset.id);
        history.replaceState(null, '', '#' + el.dataset.id);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  // ── Render：夥伴支援任務（單一分頁，不分專案）─────────────────────────

  function renderPartnersTable() {
    const tbody = $('partners-body');
    if (!tbody) return;

    if (state.partnerTasks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">還沒有夥伴支援項目，點右上角「+ 新增支援項目」開始吧。</td></tr>';
      return;
    }

    tbody.innerHTML = state.partnerTasks.map(t => {
      const statusCls = 'tag status-' + (t.status || 'To Do').toLowerCase().replace(/\s+/g, '-');
      return `<tr data-id="${escapeHtml(t.id)}">
        <td class="name-cell">${escapeHtml(t.partner)}</td>
        <td>${escapeHtml(t.projectLabel || '-')}</td>
        <td>${escapeHtml(t.taskName || '-')}</td>
        <td>${escapeHtml(t.detail || '')}</td>
        <td><span class="${statusCls}">${escapeHtml(t.status || '-')}</span></td>
        <td>${escapeHtml(t.deadline || '待訂')}</td>
        <td>${escapeHtml(t.note || '')}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-id]').forEach(el => {
      el.addEventListener('click', () => openPartnerModal(el.dataset.id));
    });
  }

  // ── Tabs：每個分類（總覽／單一專案）各自佔一整頁，不是同一長頁往下滾動 ──

  function activateSection(id) {
    const validIds = ['overview', 'partners'].concat(state.projects.map(p => slugify(p.project)));
    if (!validIds.includes(id)) id = 'overview';
    state.activeSection = id;

    const overviewEl = $('overview');
    if (overviewEl) overviewEl.classList.toggle('tab-hidden', id !== 'overview');

    const partnersEl = $('partners');
    if (partnersEl) partnersEl.classList.toggle('tab-hidden', id !== 'partners');

    const filtersEl = $('filters-bar');
    if (filtersEl) filtersEl.classList.toggle('tab-hidden', id === 'partners');

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

  // ── 排序：點表頭可以切換排序欄位／方向，預設依期限（越近越上面）──────────

  function sortTasks(tasks) {
    const { column, dir } = state.sort;
    const mul = dir === 'asc' ? 1 : -1;

    return tasks.slice().sort((a, b) => {
      if (column === 'supportNeed') {
        const aHas = !!(a.supportNeed && a.supportNeed.trim());
        const bHas = !!(b.supportNeed && b.supportNeed.trim());
        if (aHas !== bHas) return (aHas ? -1 : 1) * mul;
        return (a.supportNeed || '').localeCompare(b.supportNeed || '') * mul;
      }
      if (column === 'status') {
        const av = STATUS_ORDER.indexOf(a.status);
        const bv = STATUS_ORDER.indexOf(b.status);
        return ((av === -1 ? 999 : av) - (bv === -1 ? 999 : bv)) * mul;
      }
      if (column === 'priority') {
        return ((Number(a.priority) || 0) - (Number(b.priority) || 0)) * mul;
      }
      if (column === 'deadline') {
        const av = a.deadline || '9999-12-31';
        const bv = b.deadline || '9999-12-31';
        return av.localeCompare(bv) * mul;
      }
      if (column === 'note') {
        return (a.note || '').localeCompare(b.note || '') * mul;
      }
      // name（預設）
      return (a.name || '').localeCompare(b.name || '') * mul;
    });
  }

  function tableHeadHtml() {
    const cells = SORT_COLUMNS.map(col => {
      const active = state.sort.column === col.key;
      const arrow = active ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="sortable-th${active ? ' active' : ''}" data-sort="${col.key}">${col.label}${arrow}</th>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }

  function bindSortHeaderClicks() {
    $('project-sections').addEventListener('click', e => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const col = th.dataset.sort;
      if (state.sort.column === col) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.column = col;
        state.sort.dir = 'asc';
      }
      renderProjectSections();
    });
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
      const visibleTasks = sortTasks(proj.tasks.filter(taskMatchesFilters));
      const blockedInProject = proj.tasks.filter(t => t.blocked);

      const rowsHtml = visibleTasks.length > 0
        ? visibleTasks.map(t => renderTaskRow(t, today)).join('')
        : '<tr><td colspan="6" class="empty-state">沒有符合篩選條件的任務</td></tr>';

      const supportHtml = blockedInProject.length > 0 ? `
        <div class="callout support">
          ${blockedInProject.map(t => `
            <div class="support-item">
              <div class="support-item-title">🚩 ${escapeHtml(t.name)}</div>
              <div class="support-item-meta">${escapeHtml(t.status || '')} · ${escapeHtml(getDueInfo(t.deadline, today, t.status).text)} · 優先度 ${escapeHtml(t.priority)}</div>
              <div class="support-item-need">${escapeHtml(t.supportNeed || '')}</div>
            </div>
          `).join('')}
        </div>` : '';

      return `
        <section id="${slugify(proj.project)}" class="project-card card">
          <div class="project-head">
            <div class="project-name">${escapeHtml(proj.projectLabel || proj.project)}</div>
            <div class="project-progress-chip"><b>${doneProcessingText(proj.done, proj.processing)}</b> / ${proj.total} 已完成（${proj.completionRate}%）${proj.blocked > 0 ? ` · <span style="color:var(--bad);">🚩 ${proj.blocked} 筆需要支援</span>` : ''}</div>
          </div>
          <div class="project-bar-wrap"><div class="project-bar" style="width:${proj.completionRate}%;"></div></div>
          <div class="table-scroll">
            <table>
              <thead>${tableHeadHtml()}</thead>
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
      <td>${escapeHtml(t.note || '')}</td>
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
    renderOverviewProjectsTable();
    renderProjectSections();
    renderPartnersTable();
    activateSection(state.activeSection);
  }

  async function loadAndRender() {
    const btn = $('refresh-btn');
    btn.classList.add('spinning');
    try {
      const data = await fetchData();
      state.tasks = data.tasks || [];
      state.projects = (data.summary && data.summary.projects) || [];
      state.summary = data.summary || null;
      state.partnerTasks = data.partnerTasks || [];
      state.partnerList = data.partnerList || [];
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

  // 只列出 Sheet 上真的存在的專案分頁（value 用原始分頁名稱，選了才會正確對應到既有分頁，
  // 不會因為選到「清單預填名稱」而誤建一個重複的新分頁）。要開新專案就直接打新名稱即可。
  function projectOptions() {
    return state.projects.map(p => {
      const label = p.projectLabel || p.project;
      return `<option value="${escapeHtml(p.project)}">${escapeHtml(label)}</option>`;
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
          <div class="form-row">
            <label>備注（純筆記，跟需要支援無關）</label>
            <textarea id="f-note" placeholder="記錄補充資訊，例如背景說明、聯絡窗口等">${escapeHtml(task ? task.note : '')}</textarea>
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
    state.editingPartnerId = null;
  }

  async function saveTask() {
    const name = $('f-name').value.trim();
    if (!name) { alert('請輸入任務名稱'); return; }

    const existingTask = state.editingId ? state.tasks.find(t => t.id === state.editingId) : null;
    const project = existingTask ? existingTask.project : ($('f-project').value.trim());
    if (!project) { alert('請輸入專案名稱'); return; }

    // 如果打的專案名稱不是既有的分頁，跳出確認，避免手滑或重試造成重複建立分頁
    if (!existingTask) {
      const knownProjects = state.projects.map(p => p.project);
      if (!knownProjects.includes(project)) {
        const ok = confirm('「' + project + '」目前不是既有專案，送出後會自動建立一個新的分頁。\n\n如果這個專案應該已經存在，請按「取消」，改從下拉選單挑選既有專案，避免建立重複分頁。\n\n確定要建立新專案嗎？');
        if (!ok) return;
      }
    }

    const priority = Math.max(1, Math.min(10, parseInt($('f-priority').value, 10) || 5));

    const payload = {
      name,
      priority,
      status: $('f-status').value,
      deadline: $('f-deadline').value,
      supportNeed: $('f-support').value.trim(),
      note: $('f-note').value.trim()
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

  // ── Modal（夥伴支援任務：新增 / 編輯）────────────────────────────────────

  function partnerOptions() {
    return state.partnerList.map(p => `<option value="${escapeHtml(p)}"></option>`).join('');
  }

  function projectSelectOptionsHtml(selected) {
    const opts = ['<option value="">（無）</option>'].concat(
      state.projects.map(p => `<option value="${escapeHtml(p.project)}"${p.project === selected ? ' selected' : ''}>${escapeHtml(p.projectLabel || p.project)}</option>`)
    );
    return opts.join('');
  }

  // 選完專案後，關聯任務只列出「這個專案裡有標記需要支援」的任務，避免清單太長找不到重點
  function taskSelectOptionsHtml(projectName, selectedTaskId) {
    if (!projectName) return '<option value="">（先選專案）</option>';
    const proj = state.projects.find(p => p.project === projectName);
    const tasks = proj ? proj.tasks.filter(t => t.blocked) : [];
    if (tasks.length === 0) return '<option value="">（這個專案目前沒有標記需要支援的任務）</option>';
    const opts = ['<option value="">（無，僅關聯專案）</option>'].concat(
      tasks.map(t => `<option value="${escapeHtml(t.id)}"${t.id === selectedTaskId ? ' selected' : ''}>${escapeHtml(t.name)}</option>`)
    );
    return opts.join('');
  }

  function openPartnerModal(id) {
    state.editingPartnerId = id || null;
    const item = id ? state.partnerTasks.find(t => t.id === id) : null;

    const html = `
      <div class="modal-overlay" id="modal-overlay">
        <div class="modal-box">
          <h3>${item ? '編輯夥伴支援項目' : '新增夥伴支援項目'}</h3>
          <div class="form-row">
            <label>夥伴名</label>
            <input type="text" list="partner-list" id="pf-partner" value="${escapeHtml(item ? item.partner : '')}" placeholder="輸入現有夥伴名，或打新名字新增">
            <datalist id="partner-list">${partnerOptions()}</datalist>
          </div>
          <div class="form-row">
            <label>關聯專案（選填）</label>
            <select id="pf-project">${projectSelectOptionsHtml(item ? item.project : '')}</select>
          </div>
          <div class="form-row">
            <label>關聯任務（選填，只列出該專案裡標記需要支援的任務）</label>
            <select id="pf-task">${taskSelectOptionsHtml(item ? item.project : '', item ? item.taskId : '')}</select>
          </div>
          <div class="form-row">
            <label>支援項目/細節</label>
            <textarea id="pf-detail" placeholder="請這位夥伴支援什麼">${escapeHtml(item ? item.detail : '')}</textarea>
          </div>
          <div class="form-row">
            <label>狀態</label>
            <select id="pf-status">
              ${PARTNER_STATUS_LIST.map(s => `<option value="${s}"${item && item.status === s ? ' selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>期限（預計支援交付日）</label>
            <input type="date" id="pf-deadline" value="${escapeHtml(item ? item.deadline : '')}">
          </div>
          <div class="form-row">
            <label>備注</label>
            <textarea id="pf-note" placeholder="補充資訊">${escapeHtml(item ? item.note : '')}</textarea>
          </div>
          <div class="modal-actions">
            <div>${item ? '<button class="btn-danger" id="btn-delete-partner">刪除</button>' : ''}</div>
            <div class="modal-actions-right">
              <button class="btn-secondary" id="btn-cancel">取消</button>
              <button class="btn-primary" id="btn-save-partner">儲存</button>
            </div>
          </div>
        </div>
      </div>`;

    $('modal-root').innerHTML = html;
    $('btn-cancel').addEventListener('click', closeModal);
    $('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
    $('pf-project').addEventListener('change', e => {
      $('pf-task').innerHTML = taskSelectOptionsHtml(e.target.value, '');
    });
    $('btn-save-partner').addEventListener('click', savePartnerTask);
    if (item) $('btn-delete-partner').addEventListener('click', deletePartnerTaskEntry);
  }

  async function savePartnerTask() {
    const partner = $('pf-partner').value.trim();
    if (!partner) { alert('請輸入夥伴名'); return; }

    const payload = {
      partner,
      project: $('pf-project').value,
      taskId: $('pf-task').value,
      detail: $('pf-detail').value.trim(),
      status: $('pf-status').value,
      deadline: $('pf-deadline').value,
      note: $('pf-note').value.trim()
    };

    const btn = $('btn-save-partner');
    btn.textContent = '儲存中...';
    btn.disabled = true;
    try {
      if (state.editingPartnerId) {
        await postApi('updatePartnerTask', { id: state.editingPartnerId, task: payload });
      } else {
        await postApi('addPartnerTask', { task: payload });
      }
      closeModal();
      await loadAndRender();
    } catch (err) {
      alert('儲存失敗：' + err.message);
      btn.textContent = '儲存';
      btn.disabled = false;
    }
  }

  async function deletePartnerTaskEntry() {
    if (!confirm('確定要刪除這筆夥伴支援項目嗎？')) return;
    try {
      await postApi('deletePartnerTask', { id: state.editingPartnerId });
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
    $('add-partner-btn').addEventListener('click', () => openPartnerModal(null));
    bindNavClicks();
    bindSortHeaderClicks();

    if (window.XCITY_CONFIG && window.XCITY_CONFIG.SHEET_URL) {
      $('sheet-link').href = window.XCITY_CONFIG.SHEET_URL;
    }
  }

  initAuth();
})();
