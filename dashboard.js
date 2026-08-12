(function() {
  'use strict';

  const AUTH_KEY = 'xcity_marketing_auth_token';
  const AUTH_EXPIRY_DAYS = 7;
  const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 分鐘自動重新整理
  const STATUS_ORDER = ['To Do', 'Processing', 'Waiting', 'On Hold', 'Done'];

  const SORT_COLUMNS = [
    { key: 'name', label: '任務名稱' },
    { key: 'status', label: '狀態' },
    { key: 'priority', label: '優先度' },
    { key: 'deadline', label: '期限' },
    { key: 'supportNeed', label: '需要支援' },
    { key: 'note', label: '備注' }
  ];

  let activeSection = (location.hash || '#overview').slice(1);
  let lastProjects = [];
  let lastToday = '';
  let sortState = { column: 'deadline', dir: 'asc' }; // 預設用期限排序，越近的排越上面

  const $ = (id) => document.getElementById(id);

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
    $('refresh-btn').addEventListener('click', loadAndRender);
    if (window.XCITY_CONFIG && window.XCITY_CONFIG.SHEET_URL) {
      $('sheet-link').href = window.XCITY_CONFIG.SHEET_URL;
    }
    bindNavClicks();
    bindSortHeaderClicks();
    loadAndRender();
    setInterval(loadAndRender, AUTO_REFRESH_MS);
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
    if (!requirePassword || checkAuth()) {
      unlock();
      return;
    }
    $('lock-screen').style.display = 'flex';
    $('lock-submit').addEventListener('click', tryPassword);
    $('lock-input').addEventListener('keydown', e => { if (e.key === 'Enter') tryPassword(); });
    setTimeout(() => $('lock-input').focus(), 100);
  }

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

  function isDemoMode() {
    return Array.isArray(window.XCITY_DEMO_TASKS) && typeof window.XCITY_DEMO_BUILD_SUMMARY === 'function';
  }

  async function fetchData() {
    if (isDemoMode()) {
      return { tasks: window.XCITY_DEMO_TASKS, summary: window.XCITY_DEMO_BUILD_SUMMARY(window.XCITY_DEMO_TASKS) };
    }
    if (!window.XCITY_CONFIG || !window.XCITY_CONFIG.API_URL || !window.XCITY_CONFIG.API_TOKEN) {
      throw new Error('config.js 未正確設定 API_URL 或 API_TOKEN');
    }
    const url = window.XCITY_CONFIG.API_URL + '?token=' + encodeURIComponent(window.XCITY_CONFIG.API_TOKEN) + '&action=all';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  function renderProjectNav(projects) {
    const links = ['<a href="#overview">總覽</a>'].concat(
      projects.map(p => `<a href="#${slugify(p.project)}">${escapeHtml(p.projectLabel || p.project)}</a>`)
    );
    $('project-nav').innerHTML = links.join('');
  }

  // ── Tabs：每個分類（總覽／單一專案）各自佔一整頁，不是同一長頁往下滾動 ──

  function activateSection(id) {
    const validIds = ['overview'].concat(lastProjects.map(p => slugify(p.project)));
    if (!validIds.includes(id)) id = 'overview';
    activeSection = id;

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

  // ── 排序：點表頭可以切換排序欄位／方向，預設依期限（越近越上面）──────────

  function sortTasks(tasks) {
    const { column, dir } = sortState;
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
      return (a.name || '').localeCompare(b.name || '') * mul;
    });
  }

  function tableHeadHtml() {
    const cells = SORT_COLUMNS.map(col => {
      const active = sortState.column === col.key;
      const arrow = active ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="sortable-th${active ? ' active' : ''}" data-sort="${col.key}">${col.label}${arrow}</th>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }

  function bindSortHeaderClicks() {
    $('project-sections').addEventListener('click', e => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const col = th.dataset.sort;
      if (sortState.column === col) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.column = col;
        sortState.dir = 'asc';
      }
      renderProjectSections(lastProjects, lastToday);
      activateSection(activeSection);
    });
  }

  function renderKPIs(summary) {
    $('kpi-total').textContent = summary.total;
    $('kpi-total-sub').textContent = summary.projects.length + ' 個專案';

    $('kpi-doing').textContent = summary.inProgressCount;
    $('kpi-doing-sub').textContent = '待處理 ' + (summary.byStatus['To Do'] || 0) + ' 筆';

    $('kpi-done').textContent = summary.doneCount + ' / ' + summary.inProgressCount;
    $('kpi-rate-sub').textContent = '達成率 ' + summary.completionRate + '%（已完成 + 持續執行）';

    $('kpi-blocked').textContent = summary.blockedCount;
    $('kpi-overdue-sub').textContent = '逾期 ' + summary.overdueCount + ' 筆・今日到期 ' + summary.dueTodayCount + ' 筆';

    $('overview-tag').textContent = summary.today;
  }

  function renderOverviewCallout(summary) {
    const rows = [];
    rows.push(`<div class="row">本週共有 <span class="figure">${summary.projects.length}</span> 個專案在進行，累積 <span class="figure">${summary.total}</span> 筆任務</div>`);
    rows.push(`<div class="row">已完成 <span class="figure">${summary.doneCount}</span> 筆（達成率 ${summary.completionRate}%）</div>`);
    if (summary.blockedCount > 0) {
      rows.push(`<div class="row">🚩 有 <span class="figure">${summary.blockedCount}</span> 筆任務需要支援（詳見各專案卡片）</div>`);
    } else {
      rows.push(`<div class="row">🎉 目前沒有需要支援的任務</div>`);
    }
    $('overview-callout').innerHTML = rows.join('');
  }

  function renderProjectSections(projects, today) {
    lastToday = today;

    if (projects.length === 0) {
      $('project-sections').innerHTML = '<div class="empty-state">目前還沒有任務</div>';
      return;
    }

    const html = projects.map(proj => {
      const blockedTasks = proj.tasks.filter(t => t.blocked);

      const rows = sortTasks(proj.tasks).map(t => {
        const statusCls = 'tag status-' + (t.status || 'To Do').toLowerCase().replace(/\s+/g, '-');
        const priCls = 'priority-' + priorityBand(t.priority);
        const due = getDueInfo(t.deadline, today, t.status);
        return `<tr>
          <td class="name-cell">${escapeHtml(t.name)}</td>
          <td><span class="${statusCls}">${escapeHtml(t.status || '-')}</span></td>
          <td><span class="tag priority-chip ${priCls}">${escapeHtml(t.priority)}</span></td>
          <td><span class="due-pill ${due.cls}">${escapeHtml(due.text)}</span></td>
          <td>${t.blocked ? escapeHtml(t.supportNeed) : ''}</td>
          <td>${escapeHtml(t.note || '')}</td>
        </tr>`;
      }).join('');

      const supportHtml = blockedTasks.length > 0 ? `
        <div class="callout support">
          ${blockedTasks.map(t => `
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
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${supportHtml}
        </section>`;
    }).join('');

    $('project-sections').innerHTML = html;
  }

  async function loadAndRender() {
    const btn = $('refresh-btn');
    btn.classList.add('spinning');
    try {
      const data = await fetchData();
      const summary = data.summary;
      const now = new Date();
      $('last-updated').textContent = '最後更新：' + now.toLocaleString('zh-TW', { hour12: false }) + '　·　每 5 分鐘自動更新';

      lastProjects = summary.projects;
      renderKPIs(summary);
      renderProjectNav(summary.projects);
      renderOverviewCallout(summary);
      renderProjectSections(summary.projects, summary.today);
      activateSection(activeSection);
    } catch (err) {
      console.error(err);
      $('project-sections').innerHTML = `<div class="error">載入失敗：${escapeHtml(err.message)}<br><br>請檢查 config.js 的 API_URL 和 API_TOKEN 是否正確。</div>`;
    } finally {
      btn.classList.remove('spinning');
    }
  }

  initAuth();
})();
