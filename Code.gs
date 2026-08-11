/**
 * XCITY Marketing Task Board — 後端 API (Google Apps Script)
 * v2 — 2026-08
 *
 * 每個「專案」是 Spreadsheet 裡的一個分頁（Tab），分頁名稱＝專案名稱。
 * 系統分頁（config / debug_log / Overview / Demo，見 SYSTEM_SHEETS）不會被當成專案讀取，
 * 其餘所有分頁都會被視為一個專案，自動彙整成 doGet 回傳的 summary.projects。
 *
 * 每個專案分頁欄位（第一列為標題）：
 *   ID | 任務名稱 | 優先度 | 狀態 | 期限 | 需要支援
 *
 *   - ID：依專案分頁順序自動對應英文字母（第 1 個專案分頁＝A、第 2 個＝B...），
 *         同一分頁內流水號遞增，例如 A1、A2、B1、B2。新增任務時自動產生，不用手動填。
 *   - 優先度：1～10 分整數，分數越高越優先。
 *   - 狀態：To Do / Processing / Waiting / On Hold / Done
 *   - 期限：yyyy-MM-dd，或留空。
 *          留空的意思依狀態而定：Processing（執行中，例如每日排程貼文、投放中的廣告）留空＝沒有固定期限、會一直做下去；
 *          其他狀態留空就只是還沒設定期限。
 *          Processing 且有填日期時，這個日期代表「執行到什麼時候」（例如廣告投放到 8/31），
 *          過了那天畫面上只會顯示「請確認狀態」，不會被當成逾期；
 *          其他狀態（To Do / Waiting）有填日期，維持原本「截止日」的意思，過期會顯示逾期警示。
 *   - 需要支援：空白＝不需要支援；只要有填文字，就代表這個任務卡關、需要支援，
 *              內容就是卡在哪裡 / 需要什麼支援（取代原本的「是否卡關」勾選欄位）。
 *
 * 分頁「config」（兩欄 key/value）：
 *   API_TOKEN                 必填，前端 config.js 要對應
 *   PASSWORD                  選填，前端目前預設不啟用密碼鎖（config.js 的 REQUIRE_PASSWORD = false）
 *   SLACK_BOT_TOKEN           選填，設定後才會推播卡關通知 / 每日摘要
 *   SLACK_CHANNEL_ID          選填
 *   SLACK_VERIFICATION_TOKEN  選填，Slash Command 驗證用
 *
 * 部署方式：
 *   1. 在 Google Sheet 開啟「擴充功能 → Apps Script」，貼上本檔內容
 *   2. 部署 → 新增部署作業 → 網頁應用程式
 *      執行身分：我（你自己）；誰可以存取：任何人
 *   3. 複製部署後的網址，貼到前端 config.js 的 API_URL
 *
 * 前端寫入（新增/編輯/刪除任務）走 doPost，
 * 為避免瀏覽器 CORS preflight，前端 fetch 必須用
 * Content-Type: text/plain;charset=utf-8 夾帶 JSON 字串。
 */

const SHEET_NAME_CONFIG = 'config';
const SHEET_NAME_LOG = 'debug_log';

// 非專案分頁（不會被當成專案讀取）。如果你之後新增其他非專案用途的分頁，把名稱加進這個陣列。
const SYSTEM_SHEETS = ['config', 'debug_log', 'Overview', 'Demo'];

const TIMEZONE = 'Asia/Taipei';
const DASHBOARD_URL = 'https://leo4help.github.io/task-board/dashboard.html'; // 部署後請自行更新
const BOARD_URL = 'https://leo4help.github.io/task-board/'; // 部署後請自行更新

const HEADERS = ['ID', '任務名稱', '優先度', '狀態', '期限', '需要支援'];

const HEADER_MAP = {
  'ID': 'id',
  '任務名稱': 'name',
  '優先度': 'priority',
  '狀態': 'status',
  '期限': 'deadline',
  '需要支援': 'supportNeed'
};

const STATUS_LIST = ['To Do', 'Processing', 'Waiting', 'On Hold', 'Done'];
const DEFAULT_PRIORITY = 5;


// ════════════════════════════════════════════════════════════════════════════
//  Sheet log
// ════════════════════════════════════════════════════════════════════════════

function logToSheet_(category, message) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sheet = ss.getSheetByName(SHEET_NAME_LOG);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME_LOG);
      sheet.getRange(1, 1, 1, 3).setValues([['timestamp', 'category', 'message']]);
      sheet.setFrozenRows(1);
    }
    const ts = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    const msgStr = (typeof message === 'string') ? message : JSON.stringify(message);
    sheet.appendRow([ts, String(category), msgStr]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 2001) sheet.deleteRows(2, lastRow - 2001);
  } catch (err) {
    Logger.log('logToSheet_ 失敗: ' + err);
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  Config
// ════════════════════════════════════════════════════════════════════════════

function getConfig_(key) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME_CONFIG);
  if (!sheet) throw new Error('找不到 config 分頁');
  const values = sheet.getDataRange().getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) return String(values[i][1]).trim();
  }
  return '';
}


// ════════════════════════════════════════════════════════════════════════════
//  工具
// ════════════════════════════════════════════════════════════════════════════

function isDate_(value) {
  return value !== null && value !== undefined && typeof value === 'object'
    && typeof value.getTime === 'function' && !isNaN(value.getTime());
}

function formatDateString_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (isDate_(value)) return Utilities.formatDate(value, TIMEZONE, 'yyyy-MM-dd');
  const str = String(value).trim();
  if (!str) return '';
  const parsed = new Date(str);
  if (isDate_(parsed)) return Utilities.formatDate(parsed, TIMEZONE, 'yyyy-MM-dd');
  return str;
}

function formatDeadline_(raw) {
  const str = String(raw == null ? '' : raw).trim();
  if (!str) return '';
  // 舊版用 "Endless" 代表沒有固定期限，現在改成留空即可；讀到舊資料時自動轉成空白
  if (str.toLowerCase() === 'endless') return '';
  return formatDateString_(raw);
}

function normalizePriority_(raw) {
  const n = Number(raw);
  if (isNaN(n)) return DEFAULT_PRIORITY;
  return Math.max(1, Math.min(10, Math.round(n)));
}

/**
 * 分頁名稱如果是「專案A_...」「專案B ...」這種「專案＋英文字母」開頭的命名慣例，
 * 呈現時把這段前綴拿掉，只顯示後面真正的專案說明。
 * 分頁本身的名稱（用來找 Tab、當 project 識別碼）完全不受影響，只有顯示用的 label 會被處理。
 */
function displayProjectName_(name) {
  const m = String(name).match(/^專案[A-Za-z]+[_\-\s]*(.*)$/);
  if (m && m[1]) return m[1].trim();
  return name;
}

function getTodayString_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
}

function isSystemSheet_(name) {
  const n = String(name).trim().toLowerCase();
  return SYSTEM_SHEETS.some(s => s.toLowerCase() === n);
}

/** 依「字母」對應第幾個專案分頁：0→A, 1→B ... 25→Z, 26→AA ... */
function numberToLetters_(n) {
  let s = '';
  n = n + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}


// ════════════════════════════════════════════════════════════════════════════
//  專案分頁
// ════════════════════════════════════════════════════════════════════════════

function getProjectSheets_() {
  return SpreadsheetApp.getActive().getSheets().filter(sh => !isSystemSheet_(sh.getName()));
}

function getProjectLetter_(sheetName) {
  const sheets = getProjectSheets_();
  const idx = sheets.findIndex(sh => sh.getName() === sheetName);
  return numberToLetters_(idx === -1 ? sheets.length : idx);
}

function ensureHeaders_(sheet) {
  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const isEmpty = firstRow.every(v => String(v).trim() === '');
  if (isEmpty) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  applyValidation_(sheet);
}

/** 幫「優先度」「狀態」欄位加上下拉選單（資料驗證），方便直接在 Sheet 上手動編輯 */
function applyValidation_(sheet) {
  const numRows = 400;
  const statusRule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_LIST, true).setAllowInvalid(true).build();
  sheet.getRange(2, 4, numRows, 1).setDataValidation(statusRule); // D 欄＝狀態
  const priorityRule = SpreadsheetApp.newDataValidation().requireNumberBetween(1, 10).setAllowInvalid(true).build();
  sheet.getRange(2, 3, numRows, 1).setDataValidation(priorityRule); // C 欄＝優先度
}

function getOrCreateProjectSheet_(projectName) {
  const name = String(projectName || '').trim();
  if (!name) throw new Error('缺少專案名稱');
  if (isSystemSheet_(name)) throw new Error('這個名稱是系統保留分頁，不能當作專案名稱：' + name);
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    ensureHeaders_(sheet);
  }
  return sheet;
}


// ════════════════════════════════════════════════════════════════════════════
//  讀取任務
// ════════════════════════════════════════════════════════════════════════════

function readTasksFromSheet_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => String(h).trim());
  const projectName = sheet.getName();

  const tasks = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const hasContent = row.some(cell => String(cell).trim() !== '');
    if (!hasContent) continue;

    const task = { _sheetName: projectName, _rowIndex: i + 1, project: projectName, projectLabel: displayProjectName_(projectName) };
    headers.forEach((header, idx) => {
      const field = HEADER_MAP[header];
      if (!field) return;
      const raw = row[idx];
      if (field === 'deadline') {
        task.deadline = formatDeadline_(raw);
      } else if (field === 'priority') {
        task.priority = normalizePriority_(raw);
      } else if (isDate_(raw)) {
        task[field] = Utilities.formatDate(raw, TIMEZONE, 'yyyy-MM-dd');
      } else {
        task[field] = String(raw).trim();
      }
    });

    if (!task.id) continue; // 沒有 ID 的空白列跳過
    task.supportNeed = task.supportNeed || '';
    task.blocked = task.supportNeed.trim() !== '';
    if (task.priority === undefined) task.priority = DEFAULT_PRIORITY;
    tasks.push(task);
  }
  return tasks;
}

function getAllTasks_() {
  const sheets = getProjectSheets_();
  let all = [];
  sheets.forEach(sh => { all = all.concat(readTasksFromSheet_(sh)); });
  return all;
}

function findTaskLocation_(id) {
  const sheets = getProjectSheets_();
  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s];
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) continue;
    const headers = values[0].map(h => String(h).trim());
    const idCol = headers.indexOf('ID');
    if (idCol === -1) continue;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idCol]).trim() === String(id).trim()) {
        return { sheet: sheet, rowIndex: i + 1 };
      }
    }
  }
  return null;
}

function getTaskById_(id) {
  const loc = findTaskLocation_(id);
  if (!loc) return null;
  const tasks = readTasksFromSheet_(loc.sheet);
  return tasks.find(t => t.id === id) || null;
}

function generateTaskId_(sheet) {
  const letter = getProjectLetter_(sheet.getName());
  const values = sheet.getDataRange().getValues();
  let maxNum = 0;
  if (values.length > 1) {
    const headers = values[0].map(h => String(h).trim());
    const idCol = headers.indexOf('ID');
    if (idCol !== -1) {
      const re = new RegExp('^' + letter + '(\\d+)$');
      for (let i = 1; i < values.length; i++) {
        const m = String(values[i][idCol]).trim().match(re);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
      }
    }
  }
  return letter + (maxNum + 1);
}


// ════════════════════════════════════════════════════════════════════════════
//  摘要統計（以專案為主體）
// ════════════════════════════════════════════════════════════════════════════

function getSummary_(tasks) {
  const today = getTodayString_();
  const isDone = t => t.status === 'Done';
  const isInProgress = t => t.status === 'Processing';
  // Processing 的期限代表「執行到什麼時候」，不是「要完成的截止日」，
  // 所以不列入逾期／今日到期的計算，避免跟真正需要留意的任務混在一起。
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
    completionRate: total > 0 ? Math.round((doneCount / total) * 10000) / 100 : 0,
    overdueCount: overdue.length,
    dueTodayCount: dueToday.length,
    blockedCount,
    byStatus,
    byProject,
    projects: getProjectSummaries_(tasks),
    blockedTasks,
    today
  };
}

/**
 * 以「專案」為主體的分組摘要 — 前端呈現的核心資料結構。
 * 每個專案（＝一個分頁）包含自己的任務清單、完成度、卡關數。
 * 任務依優先度（高到低）排序，優先度相同時依期限排序。
 */
function getProjectSummaries_(tasks) {
  const isDone = t => t.status === 'Done';
  const groups = {};
  const order = [];

  tasks.forEach(t => {
    const name = t.project || '未分類';
    if (!groups[name]) {
      groups[name] = { project: name, projectLabel: displayProjectName_(name), total: 0, done: 0, blocked: 0, tasks: [] };
      order.push(name);
    }
    groups[name].total++;
    if (isDone(t)) groups[name].done++;
    if (t.blocked) groups[name].blocked++;
    groups[name].tasks.push(t);
  });

  return order.map(name => {
    const g = groups[name];
    g.completionRate = g.total > 0 ? Math.round((g.done / g.total) * 10000) / 100 : 0;
    g.tasks.sort((a, b) => {
      const pDiff = (b.priority || 0) - (a.priority || 0);
      if (pDiff !== 0) return pDiff;
      return (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31');
    });
    return g;
  });
}


// ════════════════════════════════════════════════════════════════════════════
//  doGet — 讀取
// ════════════════════════════════════════════════════════════════════════════

function doGet(e) {
  try {
    const expectedToken = getConfig_('API_TOKEN');
    const providedToken = (e && e.parameter && e.parameter.token) || '';
    if (!expectedToken) return jsonResponse_({ error: 'API_TOKEN 未設定在 config 分頁' });
    if (providedToken !== expectedToken) return jsonResponse_({ error: 'Invalid token' });

    const action = (e && e.parameter && e.parameter.action) || 'all';
    const tasks = getAllTasks_();

    let payload;
    if (action === 'tasks') {
      payload = { tasks };
    } else if (action === 'summary') {
      payload = { summary: getSummary_(tasks) };
    } else {
      payload = { tasks, summary: getSummary_(tasks), updatedAt: new Date().toISOString() };
    }
    return jsonResponse_(payload);
  } catch (err) {
    return jsonResponse_({ error: String(err) });
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  doPost — 寫入（新增/編輯/刪除）+ Slack Slash Command
// ════════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;

    if (raw) {
      let body;
      try {
        body = JSON.parse(raw);
      } catch (parseErr) {
        body = null;
      }
      if (body && body.action) {
        return handleApiWrite_(body);
      }
    }

    return handleSlackSlashCommand_(e);
  } catch (err) {
    logToSheet_('error', 'doPost 異常: ' + err);
    return jsonResponse_({ error: String(err) });
  }
}


function handleApiWrite_(body) {
  const expectedToken = getConfig_('API_TOKEN');
  if (!expectedToken || body.token !== expectedToken) {
    return jsonResponse_({ error: 'Invalid token' });
  }

  const action = body.action;
  try {
    if (action === 'addTask') {
      const task = addTask_(body.task || {});
      return jsonResponse_({ ok: true, task });
    }
    if (action === 'updateTask') {
      const task = updateTask_(body.id, body.task || {});
      return jsonResponse_({ ok: true, task });
    }
    if (action === 'deleteTask') {
      deleteTask_(body.id);
      return jsonResponse_({ ok: true });
    }
    return jsonResponse_({ error: '未知的 action：' + action });
  } catch (err) {
    logToSheet_('error', 'handleApiWrite_ 失敗: ' + err);
    return jsonResponse_({ error: String(err) });
  }
}


/** 新增任務一定要指定 project（專案分頁名稱），分頁不存在會自動建立 */
function addTask_(data) {
  const sheet = getOrCreateProjectSheet_(data.project);
  const id = generateTaskId_(sheet);
  const deadline = formatDeadline_(data.deadline);
  const priority = normalizePriority_(data.priority);

  const row = [id, data.name || '', priority, data.status || 'To Do', deadline, data.supportNeed || ''];
  sheet.appendRow(row);

  if (data.supportNeed) {
    notifyBlocked_({ id, name: row[1], project: sheet.getName(), supportNeed: row[5] });
  }

  logToSheet_('add', id + ' / ' + data.name + ' @ ' + sheet.getName());
  return getTaskById_(id);
}


/** 編輯任務不支援換專案（換分頁），專案是新增當下就固定的 */
function updateTask_(id, data) {
  if (!id) throw new Error('缺少 id');
  const loc = findTaskLocation_(id);
  if (!loc) throw new Error('找不到任務 ID：' + id);
  const sheet = loc.sheet;

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());
  const before = getTaskById_(id);
  const wasBlocked = before ? !!before.blocked : false;

  const fieldToHeader = { name: '任務名稱', priority: '優先度', status: '狀態', deadline: '期限', supportNeed: '需要支援' };

  Object.keys(fieldToHeader).forEach(field => {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      const col = headers.indexOf(fieldToHeader[field]);
      if (col === -1) return;
      let value = data[field];
      if (field === 'priority') value = normalizePriority_(value);
      if (field === 'deadline') value = formatDeadline_(value);
      sheet.getRange(loc.rowIndex, col + 1).setValue(value);
    }
  });

  const after = getTaskById_(id);
  const nowBlocked = after ? !!after.blocked : false;
  if (nowBlocked && !wasBlocked) notifyBlocked_(after);

  logToSheet_('update', id + ' / ' + JSON.stringify(data));
  return after;
}


function deleteTask_(id) {
  if (!id) throw new Error('缺少 id');
  const loc = findTaskLocation_(id);
  if (!loc) throw new Error('找不到任務 ID：' + id);
  loc.sheet.deleteRow(loc.rowIndex);
  logToSheet_('delete', id);
}


function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ════════════════════════════════════════════════════════════════════════════
//  Slack — 卡關通知 + Slash Command + 每日摘要
// ════════════════════════════════════════════════════════════════════════════

function callSlackPostMessage_(blocks, fallbackText) {
  const token = getConfig_('SLACK_BOT_TOKEN');
  const channelId = getConfig_('SLACK_CHANNEL_ID');
  if (!token || !channelId) return; // 未設定就靜默跳過，不影響主流程

  const payload = {
    channel: channelId,
    text: fallbackText || 'XCITY Marketing 任務通知',
    blocks: blocks,
    unfurl_links: false,
    unfurl_media: false
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', options);
  const json = JSON.parse(res.getContentText());
  if (!json.ok) logToSheet_('slack-api-fail', res.getContentText());
}


function notifyBlocked_(task) {
  try {
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '🚧 *任務卡關*\n*' + (task.name || '（無名稱）') + '*\n專案：' + (displayProjectName_(task.project) || '-') +
            '\n*需要支援：* ' + (task.supportNeed || '（未填寫）')
        }
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '查看看板', emoji: true }, url: BOARD_URL, style: 'primary' }
        ]
      }
    ];
    callSlackPostMessage_(blocks, '🚧 任務卡關：' + (task.name || ''));
  } catch (err) {
    logToSheet_('slack-notify-fail', String(err));
  }
}


function handleSlackSlashCommand_(e) {
  const sslCheck = (e && e.parameter && e.parameter.ssl_check);
  if (sslCheck === '1') {
    return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
  }

  const verificationToken = getConfig_('SLACK_VERIFICATION_TOKEN');
  const providedToken = (e && e.parameter && e.parameter.token) || '';
  if (verificationToken && providedToken !== verificationToken) {
    return slackEphemeral_('驗證失敗，請確認 SLACK_VERIFICATION_TOKEN 設定是否正確。');
  }

  const command = (e && e.parameter && e.parameter.command) || '';
  if (command === '/task' || command === '/marketing') {
    return slackInChannel_(buildDailyBlocks_());
  }
  return slackEphemeral_('未知指令：' + command);
}


function slackInChannel_(blocks) {
  return ContentService
    .createTextOutput(JSON.stringify({ response_type: 'in_channel', blocks: blocks }))
    .setMimeType(ContentService.MimeType.JSON);
}

function slackEphemeral_(text) {
  return ContentService
    .createTextOutput(JSON.stringify({ response_type: 'ephemeral', text: text }))
    .setMimeType(ContentService.MimeType.JSON);
}


function buildDailyBlocks_() {
  const tasks = getAllTasks_();
  const summary = getSummary_(tasks);
  const dateLabel = Utilities.formatDate(new Date(), TIMEZONE, 'M月d日');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📋 Marketing 任務摘要｜' + dateLabel, emoji: true } },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*進行中：* ' + summary.inProgressCount +
          '　*待處理：* ' + (summary.byStatus['To Do'] || 0) +
          '　*完成率：* ' + summary.completionRate + '%' +
          '\n*今日到期：* ' + summary.dueTodayCount +
          '　*逾期：* ' + summary.overdueCount +
          '　*卡關中：* ' + summary.blockedCount
      }
    }
  ];

  if (summary.blockedTasks.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*🚧 卡關中，需要支援*' } });
    summary.blockedTasks.forEach(t => {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '• *' + t.name + '*（' + (t.projectLabel || t.project || '未分類') + '・優先度 ' + t.priority + '）\n  ' + (t.supportNeed || '（未填寫需求）') }
      });
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: '查看老闆儀表板', emoji: true }, url: DASHBOARD_URL, style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: '打開任務看板', emoji: true }, url: BOARD_URL }
    ]
  });

  return blocks;
}


function sendDailyReminder() {
  const channelId = getConfig_('SLACK_CHANNEL_ID');
  if (!channelId) {
    logToSheet_('scheduled', 'sendDailyReminder 跳過：SLACK_CHANNEL_ID 未設定');
    return;
  }
  try {
    callSlackPostMessage_(buildDailyBlocks_(), '📋 Marketing 任務摘要');
    logToSheet_('scheduled', '✅ sendDailyReminder 完成');
  } catch (err) {
    logToSheet_('scheduled-fail', String(err));
  }
}


function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendDailyReminder') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyReminder')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .nearMinute(0)
    .inTimezone(TIMEZONE)
    .create();
  Logger.log('✅ 已建立：每天 09:00 (Asia/Taipei) sendDailyReminder');
}


// ════════════════════════════════════════════════════════════════════════════
//  初始化 / 維護 / 測試
// ════════════════════════════════════════════════════════════════════════════

/** 第一次使用請執行一次：建立 config 分頁；如果目前完全沒有專案分頁，會順便建一個範例分頁 */
function setupSheet() {
  const ss = SpreadsheetApp.getActive();

  let configSheet = ss.getSheetByName(SHEET_NAME_CONFIG);
  if (!configSheet) {
    configSheet = ss.insertSheet(SHEET_NAME_CONFIG);
    configSheet.getRange(1, 1, 5, 2).setValues([
      ['API_TOKEN', 'xcity-marketing-' + Math.random().toString(36).slice(2, 10)],
      ['PASSWORD', '888xcity'],
      ['SLACK_BOT_TOKEN', ''],
      ['SLACK_CHANNEL_ID', ''],
      ['SLACK_VERIFICATION_TOKEN', '']
    ]);
  }

  if (getProjectSheets_().length === 0) {
    const sample = ss.insertSheet('範例專案_請改成你的專案名稱');
    ensureHeaders_(sample);
    sample.appendRow(['A1', '範例任務：把這個分頁改名成你的專案名稱', 5, 'To Do', '', '']);
  }

  Logger.log('✅ 初始化完成，請至 config 分頁填入設定值，並把範例分頁改成你的專案');
}

/** 已經手動建過專案分頁的話，執行這個補上「優先度／狀態」下拉選單 */
function applyValidationToAllProjectSheets() {
  getProjectSheets_().forEach(applyValidation_);
  Logger.log('✅ 已套用下拉選單到所有專案分頁');
}

function testGetTasks() {
  Logger.log(JSON.stringify(getAllTasks_(), null, 2));
}

function testGetSummary() {
  Logger.log(JSON.stringify(getSummary_(getAllTasks_()), null, 2));
}
