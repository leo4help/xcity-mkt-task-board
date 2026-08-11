/**
 * XCITY Task API - Slack API.gs
 *
 * 此檔案為 Slack 專屬模組，與 Line API.gs 共存於同一 GAS 專案。
 * 共用常數與函式（SHEET_NAME_TASKS、getConfig_、getAllTasks_ 等）
 * 皆由 Line API.gs 提供，此檔案不重複宣告。
 *
 * Config 分頁需新增（不覆蓋現有 LINE 設定）：
 *   SLACK_BOT_TOKEN          → Slack Bot User OAuth Token（xoxb-...）
 *   SLACK_CHANNEL_ID         → 頻道 ID（如 C0BALFHE9UP）
 *   SLACK_VERIFICATION_TOKEN → 選填，Slash Command 驗證用
 */


// Slack 用 emoji 代替 LINE 的顏色標籤（Ryota 已移除）
const OWNER_EMOJI = {
  'Charlie':  '🟢',
  'Leo':      '🟣',
  '培培':     '🟠',
  '溫':       '🔴',
  'Andy':     '🔵',
  'Charlene': '🩷',
  'Ellen':    '🟡',
  '朵朵':     '🩵',
  'Sophia':   '🟤',
};

// Slack Member ID（U 開頭）→ @mention 用
// ⚠️ 目前填入的是 D 開頭的 DM ID，需更換為 U 開頭的 Member ID 才能正常 @mention
// 取得方式：點對方頭像 → View full profile → ⋯ → Copy member ID
const OWNER_SLACK_UID = {
  'Charlie':  'U0BAXBWATL1',
  'Leo':      'U0BAP63M7A7',
  '培培':     'U0BAE2LPBK9',
  '溫':       '',              // 尚未加入
  'Andy':     'U0BBPQYHYCQ',
  'Charlene': 'U0BBPQ9549W',
  'Ellen':    'U0BBPR163PA',
  '朵朵':     'U0BAP64AZLK',
  'Sophia':   'U0BAS585Q21',
  '全體':     '!channel',
};

function getOwnerEmoji_(owner) {
  return OWNER_EMOJI[owner] || '⚪';
}


// ════════════════════════════════════════════════════════════════════════════
//  doPost：處理 Slack Slash Command（/task、/今日任務、/xcity）
//
//  Slack App 設定：
//  Slash Commands → Request URL 填入此 GAS webapp 的部署 URL
// ════════════════════════════════════════════════════════════════════════════

function doPost(e) {
  // ⚡ 此函式不做任何 Sheet 讀取，確保在 Slack 3 秒 timeout 前回應
  try {
    // Slack SSL 驗證 ping
    if (e && e.parameter && e.parameter.ssl_check === '1') {
      return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
    }

    const command     = (e && e.parameter && e.parameter.command)      || '';
    const responseUrl = (e && e.parameter && e.parameter.response_url) || '';

    if (command === '/task' || command === '/今日任務' || command === '/xcity') {
      // 將 response_url 存入 Script Properties（快速，不碰 Sheet）
      PropertiesService.getScriptProperties().setProperty('PENDING_RESPONSE_URL', responseUrl);
      // 1 秒後非同步執行實際工作
      ScriptApp.newTrigger('sendSlackSlashResponse_').timeBased().after(1000).create();
      // 立刻回 200，Slack 不會 timeout
      return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
    }

    return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);

  } catch (err) {
    return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
  }
}


// 非同步觸發：建構訊息後透過 response_url 發送
function sendSlackSlashResponse_() {
  // 刪除此次觸發器（避免累積）
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendSlackSlashResponse_') {
      ScriptApp.deleteTrigger(t);
    }
  });

  try {
    const props       = PropertiesService.getScriptProperties();
    const responseUrl = props.getProperty('PENDING_RESPONSE_URL') || '';
    props.deleteProperty('PENDING_RESPONSE_URL');

    if (!responseUrl) {
      logToSheet_('slack-error', 'PENDING_RESPONSE_URL 為空');
      return;
    }

    const blocks  = buildSlackBlocks_();
    const payload = { response_type: 'in_channel', text: '📋 XCITY 任務提醒', blocks: blocks };
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const res = UrlFetchApp.fetch(responseUrl, options);
    logToSheet_('slack-slash-ok', 'response_url 回應完成：' + res.getResponseCode());
  } catch (err) {
    logToSheet_('slack-slash-fail', 'sendSlackSlashResponse_ 失敗: ' + err);
  }
}


function slackInChannel_(blocks) {
  const fallback = '📋 XCITY 任務提醒';
  return ContentService
    .createTextOutput(JSON.stringify({ response_type: 'in_channel', text: fallback, blocks: blocks }))
    .setMimeType(ContentService.MimeType.JSON);
}


function slackEphemeral_(text) {
  return ContentService
    .createTextOutput(JSON.stringify({ response_type: 'ephemeral', text: text }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ════════════════════════════════════════════════════════════════════════════
//  Slack API：發訊息到頻道
// ════════════════════════════════════════════════════════════════════════════

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
    text: fallbackText,
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
//  Slack Block Kit 訊息組裝
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

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📋 XCITY 任務提醒｜' + weekLabel + '｜' + dateLabel, emoji: true }
  });
  blocks.push({ type: 'divider' });

  function taskLine(t, overdueCount) {
    const emoji   = getOwnerEmoji_(t.owner);
    const owner   = t.owner  || '?';
    const uid     = OWNER_SLACK_UID[owner];
    const mention = uid ? (uid.startsWith('!') ? ' <' + uid + '>' : ' <@' + uid + '>') : '';
    const name    = t.name   || '（無名稱）';
    const week    = t.week   || '-';
    const status  = t.status || '-';
    const meta    = overdueCount != null
      ? week + '｜逾期 ' + overdueCount + ' 天（' + t.dueDay + '）'
      : week + '｜' + status;
    return emoji + ' *[' + owner + ']* ' + name + mention + '\n_' + meta + '_';
  }

  function taskLineIn7(t) {
    const emoji    = getOwnerEmoji_(t.owner);
    const owner    = t.owner || '?';
    const uid      = OWNER_SLACK_UID[owner];
    const mention  = uid ? ' <@' + uid + '>' : '';
    const name     = t.name  || '（無名稱）';
    const week     = t.week  || '-';
    const diffDays = Math.round((new Date(t.dueDay) - new Date(today)) / (1000 * 60 * 60 * 24));
    const meta     = week + '｜' + diffDays + ' 天後（' + t.dueDay + '）';
    return emoji + ' *[' + owner + ']* ' + name + mention + '\n_' + meta + '_';
  }

  function pushSection(text) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text } });
  }

  function pushDividerIfNeeded() {
    if (blocks.length > 2) blocks.push({ type: 'divider' });
  }

  // Body
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

  // Footer
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
//  排程推播（由 Line API.gs 的 trigger 呼叫，或另設獨立 trigger）
// ════════════════════════════════════════════════════════════════════════════

function sendSlackReminder() {
  const channelId = getConfig_('SLACK_CHANNEL_ID');
  if (!channelId) {
    logToSheet_('slack-scheduled', 'sendSlackReminder 跳過：SLACK_CHANNEL_ID 未設定');
    return;
  }
  try {
    const blocks = buildSlackBlocks_();
    callSlackPostMessage_(blocks);
    logToSheet_('slack-scheduled', '✅ Slack 推播完成 → ' + channelId);
  } catch (err) {
    logToSheet_('slack-scheduled-fail', 'sendSlackReminder 失敗: ' + err);
    throw err;
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  測試
// ════════════════════════════════════════════════════════════════════════════

function testSlackDryRun() {
  const blocks = buildSlackBlocks_();
  Logger.log('Block 數量：' + blocks.length);
  Logger.log(JSON.stringify(blocks, null, 2));
}

function testSlackSend() {
  const channelId = getConfig_('SLACK_CHANNEL_ID');
  Logger.log('SLACK_CHANNEL_ID: ' + (channelId || '未設定'));
  Logger.log('SLACK_BOT_TOKEN:  ' + (getConfig_('SLACK_BOT_TOKEN') ? '已設定' : '未設定'));
  if (channelId) {
    sendSlackReminder();
    Logger.log('已推送到頻道');
  } else {
    Logger.log('沒有 Channel ID，未推送');
  }
}
