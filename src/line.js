require('dotenv').config();
const { messagingApi, validateSignature } = require('@line/bot-sdk');
const logger = require('./lib/logger');

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
const MAX_MSG_LENGTH = 4500;
const MAX_REPLY_MESSAGES = 5;

function splitMessage(text, maxLength = MAX_MSG_LENGTH) {
  // Reserve space for page number suffix like "\n（10/10）" = up to 10 chars
  const SUFFIX_RESERVE = 12;
  const effectiveMax = maxLength - SUFFIX_RESERVE;
  if (text.length <= maxLength) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= effectiveMax) {
      parts.push(remaining);
      break;
    }
    // Find last newline within effectiveMax
    let cutAt = remaining.lastIndexOf('\n', effectiveMax);
    if (cutAt <= 0) cutAt = effectiveMax; // No newline found, hard cut
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\n/, '');
  }
  // Add page numbers if multiple parts
  if (parts.length > 1) {
    return parts.map((p, i) => `${p}\n（${i + 1}/${parts.length}）`);
  }
  return parts;
}

class LineClient {
  constructor() {
    this.client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
    this.channelSecret = process.env.LINE_CHANNEL_SECRET;
    this.userId = process.env.LINE_USER_ID;
  }

  async replyMessage(replyToken, text) {
    if (!text || typeof text !== 'string') text = '（メッセージなし）';
    const parts = splitMessage(text);
    const messages = parts.slice(0, MAX_REPLY_MESSAGES).map(t => ({ type: 'text', text: t }));
    try {
      return await this.client.replyMessage({ replyToken, messages });
    } catch (e) {
      // If replyToken expired, fall back to pushMessage
      if (e?.statusCode === 400 || e?.message?.includes('Invalid reply token')) {
        logger.warn('line', 'replyToken期限切れ、pushMessageにフォールバック');
        for (const part of parts) {
          await this.pushMessage(part).catch(() => {});
        }
        return;
      }
      throw e;
    }
  }

  async replyMessages(replyToken, texts) {
    const messages = texts.slice(0, MAX_REPLY_MESSAGES).map(text => ({ type: 'text', text }));
    try {
      return await this.client.replyMessage({ replyToken, messages });
    } catch (e) {
      if (e?.statusCode === 400 || e?.message?.includes('Invalid reply token')) {
        logger.warn('line', 'replyMessages: replyToken期限切れ、pushMessageにフォールバック');
        for (const text of texts) {
          await this.pushMessage(text).catch(() => {});
        }
        return;
      }
      throw e;
    }
  }

  async pushMessage(text) {
    if (!this.userId) {
      logger.warn('line', 'LINE_USER_ID未設定 pushMessageスキップ');
      return;
    }
    if (!text || typeof text !== 'string') text = '（メッセージなし）';
    const parts = splitMessage(text);
    for (const part of parts) {
      await this._pushWithRetry({ to: this.userId, messages: [{ type: 'text', text: part }] });
    }
  }

  async _pushWithRetry(payload, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.pushMessage(payload);
      } catch (e) {
        if (attempt < maxRetries && (e?.statusCode === 429 || e?.statusCode >= 500)) {
          const wait = e?.statusCode === 429 ? 1000 : 500;
          logger.warn('line', `pushMessage失敗リトライ ${attempt + 1}`, { status: e?.statusCode });
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
  }

  async pushMessages(texts) {
    const chunks = [];
    for (let i = 0; i < texts.length; i += 5) {
      chunks.push(texts.slice(i, i + 5));
    }
    for (const chunk of chunks) {
      const messages = chunk.map(text => ({ type: 'text', text }));
      await this._pushWithRetry({ to: this.userId, messages });
    }
  }

  async pushToGroup(groupId, text) {
    if (!groupId) {
      logger.warn('line', 'pushToGroup: groupId未指定 スキップ');
      return;
    }
    if (!text || typeof text !== 'string') text = '（メッセージなし）';
    const parts = splitMessage(text);
    for (const part of parts) {
      await this._pushWithRetry({ to: groupId, messages: [{ type: 'text', text: part }] });
    }
  }

  verifySignature(body, signature) {
    return validateSignature(body, this.channelSecret, signature);
  }
}

function formatCalendarEvents(events, dateLabel = '', rangeDays = 1) {
  // 複数日の場合は日付ごとにグループ化して表示
  if (rangeDays > 1) {
    if (!events || events.length === 0) {
      return `📅 ${dateLabel}\n予定はありません`;
    }
    // 日付ごとにグループ化
    const groups = {};
    for (const e of events) {
      const dateKey = (e.start || '').slice(0, 10);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(e);
    }
    const lines = [`📅 ${dateLabel}（${events.length}件）`, '━━━━━━━━━━'];
    for (const dateKey of Object.keys(groups).sort()) {
      lines.push(_dateLabel(dateKey));
      for (const e of groups[dateKey]) {
        const s = e.start ? _formatTime(e.start) : '';
        const en = e.end ? _formatTime(e.end) : '';
        const timeStr = s && en ? `  ${s}〜${en} ` : '  ';
        const tag = e.calLabel ? `[${e.calLabel}] ` : '';
        lines.push(`${timeStr}${tag}${e.title}`);
      }
    }
    return lines.join('\n');
  }

  // 1日分の通常表示
  if (!events || events.length === 0) {
    return `📅 ${dateLabel}\n予定はありません`;
  }
  const lines = [`📅 ${dateLabel}の予定（${events.length}件）`, '━━━━━━━━━━'];
  for (const e of events) {
    const start = e.start ? _formatTime(e.start) : '';
    const end = e.end ? _formatTime(e.end) : '';
    const timeStr = start && end ? `${start}〜${end} ` : '';
    const tag = e.calLabel ? `[${e.calLabel}] ` : '';
    lines.push(`${timeStr}${tag}${e.title}`);
  }
  return lines.join('\n');
}

function _formatTime(isoStr) {
  if (!isoStr || isoStr.length <= 10) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
}

function _dateLabel(isoStr) {
  // 正午JST(03:00 UTC)で曜日計算 → UTC環境でも日付ずれが起きない
  const d = new Date(isoStr + 'T12:00:00+09:00');
  const [, mm, dd] = isoStr.split('-').map(Number);
  const wd = WEEKDAY_JA[d.getDay()];
  return `${mm}月${dd}日（${wd}）`;
}

function formatGmailList(emails) {
  if (!emails || emails.length === 0) return '📧 未読メールはありません';

  const lines = [`📧 未読メール（${emails.length}件）`, '━━━━━━━━━━'];
  const nums = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  emails.forEach((e, i) => {
    const sender = e.from.replace(/<.*>/, '').trim().replace(/"/g, '') || e.from;
    const dateStr = e.date ? _shortDate(e.date) : '';
    lines.push(`${nums[i] || `${i + 1}.`} ${sender}「${e.subject}」（${dateStr}）`);
  });
  return lines.join('\n');
}

function _shortDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).replace('/', '/');
  } catch {
    return '';
  }
}

module.exports = { LineClient, formatCalendarEvents, formatGmailList, splitMessage };

