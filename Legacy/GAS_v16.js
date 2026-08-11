/**
 * XCITY Task API - v16
 *
 * v16 改動（相對於 v15）：
 * - 通知平台從 LINE 改為 Slack
 * - 移除所有 LINE API 呼叫（reply / push / Flex Message）
 * - 新增 callSlackPostMessage_()：使用 Slack Bot Token 發送 Block Kit 訊息
 * - 新增 buildSlackBlocks_()：將 LINE Flex Message 邏輯轉換為 Slack Block Kit
 * - doPost 改為處理 Slack Slash Command（/task、/今日任務、/xcity）
 * - Config key 對應：
 *     舊 → 新
 *     CHANNEL_ACCESS_TOKEN → SLACK_BOT_TOKEN
 *     LINE_GROUP_ID        → SLACK_CHANNEL_ID
 *     CHANNEL_SECRET       → SLACK_VERIFICATION_TOKEN（選填）
 *     WEBHOOK_TOKEN        → 已廢棄，改用 SLACK_VERIFICATION_TOKEN
 * - 保留：API_TOKEN（doGet 驗證用）、所有 task 資料讀取邏輯、排程觸發器
 */


const SHEET_NAME_TASKS = 'Master Task Board';
const SHEET_NAME_CONFIG = 'config';
const SHEET_NAME_LOG = 'debug_log';
const TIMEZONE = 'Asia/Taipei';
const DASHBOARD_URL = 'https://leo4help.github.io/task-board/';
const TASK_URL = 'https://tinyurl.com/xcity-task';

const MAX_MESSAGE_LEN = 4800;
const LOG_MAX_ROWS = 2001;

// Slack 不支援顏色，改用 emoji 代表各成員
const OWNER_EMOJI = {
  'Ryota':   '🔵',
  'Charlie': '🟢',
  'Leo':     '🟣',
  '培培':    '🟠',
  '溫':      '🔴',
};

function getOwnerEmoji_(owner) {
  return OWNER_EMOJI[owner] || '⚪';
}


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
      sheet.setColumnWidth(1, 160);
      sheet.setColumnWidth(2, 140);
      sheet.setColumnWidth(3, 800);
    }
    const ts = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    const msgStr = (typeof message === 'string') ? message : JSON.stringify(message);
    sheet.appendRow([ts, String(category), msgStr]);

    const lastRow = sheet.getLastRow();
    if (lastRow > LOG_MAX_ROWS) {
      sheet.deleteRows(2, lastRow - LOG_MAX_ROWS);
    }
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


function setConfig_(key, value) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME_CONFIG);
  if (!sheet) throw new Error('找不到 config 分頁');
  const values = sheet.getDataRange().getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}


function isDate_(value) {
  return value !== null
    && value !== undefined
    && typeof value === 'object'
    && typeof value.getTime === 'function'
    && !isNaN(value.getTime());
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


function getTodayString_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
}


function getTomorrowString_() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return Utilities.formatDate(tomorrow, TIMEZONE, 'yyyy-MM-dd');
}


function getSevenDaysLaterString_() {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}


function getAllTasks_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME_TASKS);
  if (!sheet) throw new Error('找不到 Master Task Board 分頁');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => String(h).trim());

  const headerMap = {
    '週次': 'week',
    '任務性質 (Type)': 'type',
    '負責人': 'owner',
    '優先級': 'priority',
    '執行狀態': 'status',
    '任務名稱': 'name',
    'Due Day': 'dueDay',
    '備註': 'note',
    'Date': 'date'
  };

  const dateFields = ['dueDay', 'date'];

  const tasks = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const hasContent = row.some(cell => String(cell).trim() !== '');
    if (!hasContent) continue;

    const task = { _rowIndex: i + 1 };
    headers.forEach((header, idx) => {
      const field = headerMap[header];
      if (!field) return;
      const raw = row[idx];
      if (dateFields.indexOf(field) !== -1) {
        task[field] = formatDateString_(raw);
      } else if (isDate_(raw)) {
        task[field] = Utilities.formatDate(raw, TIMEZONE, 'yyyy-MM-dd');
      } else {
        task[field] = String(raw).trim();
      }
    });

    tasks.push(task);
  }

  return tasks;
}


function getSummary_(tasks) {
  const today = getTodayString_();

  const isDone      = t => t.status && t.status.indexOf('Done')     !== -1;
  const isCancelled = t => t.status && t.status.indexOf('Canceled') !== -1;
  const isActive    = t => !isDone(t) && !isCancelled(t);

  const doneCount = tasks.filter(isDone).length;
  const total     = tasks.length;

  const overdue  = tasks.filter(t => t.dueDay && isActive(t) && t.dueDay < today);
  const dueToday = tasks.filter(t => t.dueDay && isActive(t) && t.dueDay === today);

  const byStatus = {};
  tasks.forEach(t => {
    const s = t.status || '未定義';
    byStatus[s] = (byStatus[s] || 0) + 1;
  });

  const byOwner = {};
  tasks.forEach(t => {
    const o = t.owner || '未指派';
    if (!byOwner[o]) byOwner[o] = { total: 0, done: 0 };
    byOwner[o].total++;
    if (isDone(t)) byOwner[o].done++;
  });

  return {
    total,
    doneCount,
    completionRate: total > 0 ? Math.round((doneCount / total) * 10000) / 100 : 0,
    overdueCount:   overdue.length,
    dueTodayCount:  dueToday.length,
    byStatus,
    byOwner,
    today
  };
}


// ════════════════════════════════════════════════════════════════════════════
//  doGet
// ════════════════════════════════════════════════════════════════════════════

function doGet(e) {
  try {
    const expectedToken = getConfig_('API_TOKEN');
    const providedToken = (e && e.parameter && e.parameter.token) || '';

    if (!expectedToken) return jsonResponse_({ error: 'API_TOKEN 未設定在 config 分頁' });
    if (providedToken !== expectedToken) return jsonResponse_({ error: 'Invalid token' });

    const action = (e && e.parameter && e.parameter.action) || 'all';
    const tasks  = getAllTasks_();

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
//  doPost（v16：處理 Slack Slash Command）
//
//  Slack 傳來的是 application/x-www-form-urlencoded，
//  GAS 會自動解析到 e.parameter，不需手動 JSON.parse。
//
//  設定方式：
//  1. 在 Slack App 的 Slash Commands 頁面新增指令（如 /task）
//  2. Request URL 填入此 GAS webapp 的 URL
//  3. 將 Slack App 的 Verification Token 存入 config 分頁的 SLACK_VERIFICATION_TOKEN
//
//  注意：Slack 要求在 3 秒內回應，若任務量很大導致超時，
//        可改用 response_url 做延遲回應（需額外實作）。
// ════════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    // Slack SSL 驗證 ping
    const sslCheck = (e && e.parameter && e.parameter.ssl_check);
    if (sslCheck === '1') {
      return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
    }

    // 驗證 Slack Verification Token（選填，建議設定）
    const verificationToken = getConfig_('SLACK_VERIFICATION_TOKEN');
    const providedToken = (e && e.parameter && e.parameter.token) || '';
    if (verificationToken && providedToken !== verificationToken) {
      logToSheet_('auth-fail', 'Slack token 驗證失敗，已忽略');
      return slackEphemeral_('驗證失敗，請確認 SLACK_VERIFICATION_TOKEN 設定是否正確。');
    }

    const command   = (e && e.parameter && e.parameter.command)    || '';
    const text      = (e && e.parameter && e.parameter.text)       || '';
    const channelId = (e && e.parameter && e.parameter.channel_id) || '';
    const userId    = (e && e.parameter && e.parameter.user_id)    || '';

    logToSheet_('slash-command', JSON.stringify({ command, text, channelId, userId }));

    if (command === '/task' || command === '/今日任務' || command === '/xcity') {
      const blocks = buildSlackBlocks_();
      return slackInChannel_(blocks);
    }

    logToSheet_('skip', '未知指令：' + command);
    return slackEphemeral_('未知指令：' + command + '。可用指令：/task');

  } catch (err) {
    logToSheet_('error', 'doPost 異常: ' + err);
    return slackEphemeral_('發生錯誤，請稍後再試：' + err);
  }
}


function slackInChannel_(blocks) {
  const altText = blocks.length > 0 && blocks[0].text
    ? (blocks[0].text.text || 'XCITY 任務提醒')
    : 'XCITY 任務提醒';
  return ContentService
    .createTextOutput(JSON.stringify({ response_type: 'in_channel', text: altText, blocks: blocks }))
    .setMimeType(ContentService.MimeType.JSON);
}


function slackEphemeral_(text) {
  return ContentService
    .createTextOutput(JSON.stringify({ response_type: 'ephemeral', text: text }))
    .setMimeType(ContentService.MimeType.JSON);
}


function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ════════════════════════════════════════════════════════════════════════════
//  Slack API 低階呼叫
// ════════════════════════════════════════════════════════════════════════════

/**
 * 用 Bot Token 發訊息到指定頻道。
 * Config key：SLACK_BOT_TOKEN、SLACK_CHANNEL_ID
 */
function callSlackPostMessage_(blocks) {
  const token = getConfig_('SLACK_BOT_TOKEN');
  if (!token) throw new Error('SLACK_BOT_TOKEN 未設定（config 分頁）');

  const channelId = getConfig_('SLACK_CHANNEL_ID');
  if (!channelId) throw new Error('SLACK_CHANNEL_ID 未設定（config 分頁）');

  const dateLabel = Utilities.formatDate(new Date(), TIMEZONE, 'M月d日');
  const weekLabel = getWeekLabel_();
  const fallbackText = '📋 XCITY 任務提醒｜' + weekLabel + '｜' + dateLabel;

  const payload = {
    channel: channelId,
    text: fallbackText,   // 通知預覽文字（blocks 不支援通知 preview）
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

  const res  = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', options);
  const code = res.getResponseCode();
  const body = res.getContentText();
  const json = JSON.parse(body);

  if (code !== 200 || !json.ok) {
    logToSheet_('slack-api-fail', 'chat.postMessage ' + code + ': ' + body);
    throw new Error('Slack 推送失敗：' + (json.error || body));
  }
  return body;
}


// ════════════════════════════════════════════════════════════════════════════
//  Slack Block Kit 訊息組裝（對應 v15 的 buildFlexReminderMessage_）
// ════════════════════════════════════════════════════════════════════════════

function buildSlackBlocks_() {
  const tasks          = getAllTasks_();
  const today          = getTodayString_();
  const tomorrow       = getTomorrowString_();
  const sevenDaysLater = getSevenDaysLaterString_();

  const isDone      = t => t.status && t.status.indexOf('Done')     !== -1;
  const isCancelled = t => t.status && t.status.indexOf('Canceled') !== -1;
  const isActive    = t => !isDone(t) && !isCancelled(t);

  const overdue = tasks
    .filter(t => t.dueDay && isActive(t) && t.dueDay < today)
    .sort((a, b) => a.dueDay.localeCompare(b.dueDay));

  const dueToday    = tasks.filter(t => t.dueDay && isActive(t) && t.dueDay === today);
  const dueTomorrow = tasks.filter(t => t.dueDay && isActive(t) && t.dueDay === tomorrow);

  const dueIn7Days = tasks
    .filter(t => t.dueDay && isActive(t) && t.dueDay > tomorrow && t.dueDay <= sevenDaysLater)
    .sort((a, b) => a.dueDay.localeCompare(b.dueDay));

  const dateLabel = Utilities.formatDate(new Date(), TIMEZONE, 'M月d日');
  const weekLabel = getWeekLabel_();

  const blocks = [];

  // ── Header ──────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📋 XCITY 任務提醒｜' + weekLabel + '｜' + dateLabel, emoji: true }
  });
  blocks.push({ type: 'divider' });

  // ── 組裝單筆任務的 mrkdwn 字串 ──────────────────────────────────────────
  function taskLine(t, overdueCount) {
    const emoji  = getOwnerEmoji_(t.owner);
    const owner  = t.owner  || '?';
    const name   = t.name   || '（無名稱）';
    const week   = t.week   || '-';
    const status = t.status || '-';
    const meta   = overdueCount != null
      ? week + '｜逾期 ' + overdueCount + ' 天（' + t.dueDay + '）'
      : week + '｜' + status;
    return emoji + ' *[' + owner + ']* ' + name + '\n_' + meta + '_';
  }

  function taskLineIn7(t) {
    const emoji    = getOwnerEmoji_(t.owner);
    const owner    = t.owner || '?';
    const name     = t.name  || '（無名稱）';
    const week     = t.week  || '-';
    const d1       = new Date(t.dueDay);
    const d2       = new Date(today);
    const diffDays = Math.round((d1 - d2) / (1000 * 60 * 60 * 24));
    const meta     = week + '｜' + diffDays + ' 天後（' + t.dueDay + '）';
    return emoji + ' *[' + owner + ']* ' + name + '\n_' + meta + '_';
  }

  function pushSection(text) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text } });
  }

  function pushDividerIfNeeded() {
    // 超過 2 個 block（header + divider）才需要分隔線
    if (blocks.length > 2) blocks.push({ type: 'divider' });
  }

  // ── Body ────────────────────────────────────────────────────────────────
  const hasAny = overdue.length > 0 || dueToday.length > 0 || dueTomorrow.length > 0 || dueIn7Days.length > 0;

  if (!hasAny) {
    pushSection('🎉 目前沒有逾期或即將到期的任務，大家辛苦了！');
  } else {
    if (overdue.length > 0) {
      pushSection('*⚠️ 逾期任務 ' + overdue.length + ' 筆*');
      overdue.forEach(t => pushSection(taskLine(t, daysBetween_(t.dueDay, today))));
    }
    if (dueToday.length > 0) {
      pushDividerIfNeeded();
      pushSection('*📌 今日到期 ' + dueToday.length + ' 筆*');
      dueToday.forEach(t => pushSection(taskLine(t, null)));
    }
    if (dueTomorrow.length > 0) {
      pushDividerIfNeeded();
      pushSection('*⏰ 明日到期 ' + dueTomorrow.length + ' 筆*');
      dueTomorrow.forEach(t => pushSection(taskLine(t, null)));
    }
    if (dueIn7Days.length > 0) {
      pushDividerIfNeeded();
      pushSection('*📅 七天內到期 ' + dueIn7Days.length + ' 筆*');
      dueIn7Days.forEach(t => pushSection(taskLineIn7(t)));
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text:  { type: 'plain_text', text: '查看完整看板', emoji: true },
        url:   DASHBOARD_URL,
        style: 'primary'
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '更新任務狀態', emoji: true },
        url:  TASK_URL
      }
    ]
  });

  return blocks;
}


// ════════════════════════════════════════════════════════════════════════════
//  工具
// ════════════════════════════════════════════════════════════════════════════

function daysBetween_(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  return Math.round(Math.abs((d2 - d1) / (1000 * 60 * 60 * 24)));
}


function getWeekLabel_() {
  const now   = new Date();
  const tzStr = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd');
  const [y, m, d] = tzStr.split('-').map(Number);
  const date  = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo    = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return 'W' + String(weekNo).padStart(2, '0');
}


// ════════════════════════════════════════════════════════════════════════════
//  排程入口（唯一會呼叫 Slack push 的地方）
// ════════════════════════════════════════════════════════════════════════════

function sendReminder() {
  const channelId = getConfig_('SLACK_CHANNEL_ID');
  if (!channelId) {
    logToSheet_('scheduled', 'sendReminder 跳過：SLACK_CHANNEL_ID 未設定');
    return;
  }
  try {
    const blocks = buildSlackBlocks_();
    callSlackPostMessage_(blocks);
    logToSheet_('scheduled', '✅ sendReminder 推播完成 → ' + channelId);
  } catch (err) {
    logToSheet_('scheduled-fail', 'sendReminder 失敗: ' + err);
    throw err;
  }
}


function sendMorningReminder() { sendReminder(); }
function sendEveningReminder() { sendReminder(); }
function sendDailyReminder()   { sendReminder(); }


// ════════════════════════════════════════════════════════════════════════════
//  Trigger 檢視
// ════════════════════════════════════════════════════════════════════════════

function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log('目前共有 ' + triggers.length + ' 個觸發器：');
  triggers.forEach((t, i) => {
    Logger.log((i + 1) + '. ' + t.getHandlerFunction() + ' | ' + t.getEventType() + ' | uid=' + t.getUniqueId());
  });
}


// ════════════════════════════════════════════════════════════════════════════
//  測試
// ════════════════════════════════════════════════════════════════════════════

function testSheetLog() {
  logToSheet_('test', '這是一筆測試 log，時間：' + new Date());
  Logger.log('已寫入 debug_log 分頁');
}


function testSendReminderDryRun() {
  const blocks = buildSlackBlocks_();
  Logger.log('Block 數量：' + blocks.length);
  Logger.log(JSON.stringify(blocks, null, 2));
}


function testSendReminder() {
  const channelId = getConfig_('SLACK_CHANNEL_ID');
  Logger.log('SLACK_CHANNEL_ID: ' + (channelId || '未設定'));
  if (channelId) {
    sendReminder();
    Logger.log('已推送到頻道');
  } else {
    Logger.log('沒有 Channel ID，未推送');
  }
}


function testGetTasks() {
  const tasks = getAllTasks_();
  Logger.log('共 ' + tasks.length + ' 筆任務');
  Logger.log(JSON.stringify(tasks.slice(0, 3), null, 2));
}


function testGetSummary() {
  const tasks = getAllTasks_();
  Logger.log(JSON.stringify(getSummary_(tasks), null, 2));
}


function testGetConfig() {
  Logger.log('API_TOKEN: '                + (getConfig_('API_TOKEN')                ? '已設定' : '未設定'));
  Logger.log('SLACK_BOT_TOKEN: '          + (getConfig_('SLACK_BOT_TOKEN')          ? '已設定' : '未設定'));
  Logger.log('SLACK_CHANNEL_ID: '         + (getConfig_('SLACK_CHANNEL_ID')         || '未設定'));
  Logger.log('SLACK_VERIFICATION_TOKEN: ' + (getConfig_('SLACK_VERIFICATION_TOKEN') ? '已設定' : '未設定（選填）'));
  Logger.log('今天（台灣時區）：'          + getTodayString_());
  Logger.log('明天（台灣時區）：'          + getTomorrowString_());
  Logger.log('7 天後（台灣時區）：'        + getSevenDaysLaterString_());
  Logger.log('本週：'                     + getWeekLabel_());
}


function setupMorningTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const handler = t.getHandlerFunction();
    if (handler === 'sendReminder'
      || handler === 'sendMorningReminder'
      || handler === 'sendEveningReminder'
      || handler === 'sendDailyReminder') {
      ScriptApp.deleteTrigger(t);
      Logger.log('已刪除舊觸發器：' + handler);
    }
  });

  ScriptApp.newTrigger('sendMorningReminder')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .nearMinute(30)
    .inTimezone('Asia/Taipei')
    .create();

  Logger.log('✅ 已建立：每天 08:30 (Asia/Taipei) sendMorningReminder');
}
