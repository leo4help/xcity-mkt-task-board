/**
 * Demo 假資料 — 讓 demo.html 可以直接在瀏覽器打開預覽（demo-dashboard.html 只是轉址過去，已跟 demo.html 合併），
 * 不需要先部署 Google Apps Script。
 *
 * 欄位對應 Code.gs v2（每個專案一個分頁）的資料結構：
 * id / name / project / priority(1-10) / status / deadline（留空＝沒有固定期限；Processing 狀態下有日期＝執行到什麼時候）/ supportNeed（空白＝不需要支援）
 *
 * app.js 會偵測 window.XCITY_DEMO_TASKS 是否存在，
 * 存在的話就跳過真正的 fetch，改用這份資料 + 本機運算的 summary。
 * 正式部署（config.js 指向真的 API_URL）時不會載入這個檔案，不影響正式環境。
 */

(function () {
  'use strict';

  const DEMO_TODAY = '2026-08-11';
  const STATUS_LIST = ['To Do', 'Processing', 'Waiting', 'On Hold', 'Done'];

  window.XCITY_DEMO_TASKS = [
    { id: 'A1', name: '談判 KOL A 授權金', project: '專案A_8月 KOL 開箱活動', priority: 8, status: 'Processing', deadline: '2026-08-10', supportNeed: '', note: '窗口：KOL 經紀人 Wendy' },
    { id: 'A2', name: '素材腳本撰寫', project: '專案A_8月 KOL 開箱活動', priority: 5, status: 'Done', deadline: '2026-08-05', supportNeed: '', note: '' },
    { id: 'A3', name: '開箱影片拍攝', project: '專案A_8月 KOL 開箱活動', priority: 9, status: 'Waiting', deadline: '2026-08-13', supportNeed: '需要老闆核准額外預算，KOL 要求加碼 ¥50,000', note: '' },
    { id: 'A4', name: '上架素材審核', project: '專案A_8月 KOL 開箱活動', priority: 3, status: 'To Do', deadline: '2026-08-18', supportNeed: '', note: '' },

    { id: 'B1', name: '首頁 Banner 設計', project: '專案B_官網改版', priority: 6, status: 'Processing', deadline: '2026-08-14', supportNeed: '' },
    { id: 'B2', name: '產品頁 UX 優化', project: '專案B_官網改版', priority: 9, status: 'Waiting', deadline: '2026-08-11', supportNeed: '等 IT 部門開放測試站權限，已催第二次' },
    { id: 'B3', name: 'SEO meta 調整', project: '專案B_官網改版', priority: 2, status: 'To Do', deadline: '', supportNeed: '' },
    { id: 'B4', name: '改版驗收會議', project: '專案B_官網改版', priority: 5, status: 'On Hold', deadline: '2026-08-20', supportNeed: '' },

    { id: 'C1', name: '檔期成效整理', project: '專案C_母親節檔期複盤', priority: 4, status: 'Done', deadline: '2026-08-01', supportNeed: '' },
    { id: 'C2', name: 'ROAS 分析報告', project: '專案C_母親節檔期複盤', priority: 7, status: 'Done', deadline: '2026-08-03', supportNeed: '' },
    { id: 'C3', name: '複盤簡報製作', project: '專案C_母親節檔期複盤', priority: 3, status: 'Processing', deadline: '2026-08-15', supportNeed: '' },

    { id: 'D1', name: '會員招募素材設計', project: '專案D_IG 會員招募', priority: 8, status: 'Processing', deadline: '2026-08-09', supportNeed: '文案需要法務審查用詞，卡在合規確認中' },
    { id: 'D2', name: '招募活動頁製作', project: '專案D_IG 會員招募', priority: 5, status: 'To Do', deadline: '2026-08-16', supportNeed: '' },
    { id: 'D3', name: 'KPI 設定與追蹤', project: '專案D_IG 會員招募', priority: 2, status: 'Done', deadline: '2026-08-06', supportNeed: '' },
    { id: 'D4', name: '每日限動排程', project: '專案D_IG 會員招募', priority: 4, status: 'Processing', deadline: '', supportNeed: '' }
  ];

  // 夥伴支援任務 demo 假資料（對應 Code.gs 的「夥伴支援任務」分頁：夥伴名/關聯專案/關聯任務/支援項目細節/狀態/期限/備注）
  window.XCITY_DEMO_DEFAULT_PARTNERS = ['Andy', 'Charlie', 'Leo', '溫', '培培', '朵朵'];

  window.XCITY_DEMO_PARTNER_TASKS = [
    { id: 'S-1', partner: 'Andy', project: '專案A_8月 KOL 開箱活動', taskId: 'A3', detail: '協助跟老闆爭取額外預算核准', status: 'Doing', deadline: '2026-08-12', note: '' },
    { id: 'S-2', partner: '溫', project: '專案B_官網改版', taskId: 'B2', detail: '請 IT 部門開放測試站權限', status: 'To Do', deadline: '2026-08-13', note: '已催第二次' },
    { id: 'S-3', partner: 'Charlie', project: '專案D_IG 會員招募', taskId: 'D1', detail: '協助法務審查文案用詞', status: 'Done', deadline: '2026-08-08', note: '合規已確認' }
  ];

  // 分頁名稱如果是「專案A_...」這種「專案＋英文字母」開頭的命名慣例，顯示時把前綴拿掉
  function displayProjectName(name) {
    const m = String(name).match(/^專案[A-Za-z]+[_\-\s]*(.*)$/);
    if (m && m[1]) return m[1].trim();
    return name;
  }

  function getProjectSummaries(tasks) {
    const isDone = t => t.status === 'Done';
    const isInProgress = t => t.status === 'Processing';
    const groups = {};
    const order = [];

    tasks.forEach(t => {
      const name = t.project || '未分類';
      if (!groups[name]) {
        groups[name] = { project: name, projectLabel: displayProjectName(name), total: 0, done: 0, processing: 0, blocked: 0, tasks: [] };
        order.push(name);
      }
      groups[name].total++;
      if (isDone(t)) groups[name].done++;
      if (isInProgress(t)) groups[name].processing++;
      if (t.blocked) groups[name].blocked++;
      groups[name].tasks.push(t);
    });

    return order.map(name => {
      const g = groups[name];
      // 達成率把「持續執行中」的任務也算進去（比照已完成），不是只算 Done。
      g.completionRate = g.total > 0 ? Math.round(((g.done + g.processing) / g.total) * 10000) / 100 : 0;
      g.tasks = g.tasks.slice().sort((a, b) => {
        const pDiff = (b.priority || 0) - (a.priority || 0);
        if (pDiff !== 0) return pDiff;
        return (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31');
      });
      return g;
    });
  }

  function buildSummary(tasks) {
    tasks.forEach(t => {
      t.blocked = !!(t.supportNeed && t.supportNeed.trim());
      t.projectLabel = displayProjectName(t.project);
    });

    const today = DEMO_TODAY;
    const isDone = t => t.status === 'Done';
    const isInProgress = t => t.status === 'Processing';
    // Processing 的期限代表「執行到什麼時候」，不是截止日，不列入逾期／今日到期
    const isActive = t => !isDone(t) && t.status !== 'On Hold' && !isInProgress(t);

    const total = tasks.length;
    const doneCount = tasks.filter(isDone).length;
    const inProgressCount = tasks.filter(isInProgress).length;
    const blockedCount = tasks.filter(t => t.blocked).length;
    const overdue = tasks.filter(t => t.deadline && isActive(t) && t.deadline < today);
    const dueToday = tasks.filter(t => t.deadline && isActive(t) && t.deadline === today);

    const byStatus = {};
    STATUS_LIST.forEach(s => byStatus[s] = 0);
    tasks.forEach(t => { const s = t.status || '未定義'; byStatus[s] = (byStatus[s] || 0) + 1; });

    const byProject = {};
    tasks.forEach(t => { const p = t.project || '未分類'; byProject[p] = (byProject[p] || 0) + 1; });

    const blockedTasks = tasks
      .filter(t => t.blocked)
      .map(t => ({ id: t.id, name: t.name, project: t.project, projectLabel: t.projectLabel, priority: t.priority, status: t.status, deadline: t.deadline, supportNeed: t.supportNeed }));

    return {
      total,
      doneCount,
      inProgressCount,
      // 達成率把「持續執行中」的任務也算進去（比照已完成），不是只算 Done。
      completionRate: total > 0 ? Math.round(((doneCount + inProgressCount) / total) * 10000) / 100 : 0,
      overdueCount: overdue.length,
      dueTodayCount: dueToday.length,
      blockedCount,
      byStatus,
      byProject,
      projects: getProjectSummaries(tasks),
      blockedTasks,
      today
    };
  }

  window.XCITY_DEMO_BUILD_SUMMARY = buildSummary;
})();
