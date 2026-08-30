require('dotenv').config();
const { google } = require('googleapis');
const { getAuthClient } = require('./lib/google_auth');
const logger = require('./lib/logger');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, maxRetries = 2, delayMs = 3000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status || e?.code;
      if (attempt < maxRetries && (status >= 500 || status === 'ECONNRESET')) {
        logger.warn('calendar', `API失敗、リトライ ${attempt + 1}/${maxRetries}`, { status });
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// 環境変数からカレンダー構成を読む。
//   GOOGLE_CALENDAR_IDS = "koseki.ousama.yakiniku@gmail.com:王様, primary:個人"
//     （カンマ区切り。各要素は "id" か "id:ラベル"。id はカレンダーID＝共有元のメールアドレス or "primary"）
//   未設定なら従来どおり primary 1本（後方互換）。
// カレンダーIDのメールアドレスに ":" は含まれないため、最初の ":" までを id、残りをラベルとする。
function parseCalendarsEnv() {
  const raw = process.env.GOOGLE_CALENDAR_IDS;
  if (!raw || !raw.trim()) {
    return [{ id: 'primary', label: '' }];
  }
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const idx = entry.indexOf(':');
    if (idx === -1) return { id: entry, label: '' };
    return { id: entry.slice(0, idx).trim(), label: entry.slice(idx + 1).trim() };
  });
}

class GoogleCalendarClient {
  constructor() {
    this.calendars = parseCalendarsEnv();
    const def = process.env.GOOGLE_DEFAULT_CALENDAR_ID;
    this.defaultCalendarId = def && def.trim() ? def.trim() : this.calendars[0].id;
    const defCal = this.calendars.find(c => c.id === this.defaultCalendarId);
    this.defaultLabel = defCal ? defCal.label : '';
    // 後方互換のエイリアス（旧コードが this.calendarId を参照しても壊れないように）
    this.calendarId = this.defaultCalendarId;
  }

  labelFor(id) {
    const c = this.calendars.find(x => x.id === id);
    return c ? c.label : '';
  }

  async _getCalendar() {
    const auth = await getAuthClient();
    return google.calendar({ version: 'v3', auth });
  }

  _mapEvent(e, cal) {
    return {
      id: e.id,
      title: e.summary || '（タイトルなし）',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location || '',
      description: e.description || '',
      calendarId: cal.id,
      calLabel: cal.label,
    };
  }

  // 全カレンダーを横断して events.list を実行しマージ（1カレンダーが失敗しても他は返す）
  async _listAcross(params) {
    const calendar = await this._getCalendar();
    const all = [];
    for (const cal of this.calendars) {
      try {
        const res = await withRetry(() => calendar.events.list({ ...params, calendarId: cal.id }));
        for (const e of (res?.data?.items || [])) {
          all.push(this._mapEvent(e, cal));
        }
      } catch (e) {
        logger.warn('calendar', `events.list失敗（${cal.id}）`, { error: e.message });
      }
    }
    all.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return all;
  }

  async listEvents(date, rangeDays = 1) {
    const start = new Date(`${date}T00:00:00+09:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + rangeDays);
    return this._listAcross({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
  }

  async checkConflict(start, end) {
    // 境界値（ぴったり終わる/始まる）を重複と判定しないよう1分のバッファを設ける
    const tMin = new Date(new Date(start).getTime() + 60000).toISOString();
    const tMax = new Date(new Date(end).getTime() - 60000).toISOString();
    // 全カレンダーを横断して重複検知（個人と店の予定衝突も拾う）
    return this._listAcross({ timeMin: tMin, timeMax: tMax, singleEvents: true });
  }

  async addEvent(title, start, end, description = '') {
    if (new Date(start) >= new Date(end)) {
      throw new Error('終了時刻が開始時刻より前または同じです');
    }
    const conflicts = await this.checkConflict(start, end);
    if (conflicts.length > 0) {
      return { success: false, conflict: conflicts, event: null };
    }
    return this.addEventForce(title, start, end, description).then(r => ({
      success: true, conflict: [], event: r.event,
    }));
  }

  // 新規予定を追加。calendarId 未指定なら既定カレンダー（GOOGLE_DEFAULT_CALENDAR_ID）へ。
  async addEventForce(title, start, end, description = '', location = '', calendarId = null) {
    if (new Date(start) >= new Date(end)) {
      throw new Error('終了時刻が開始時刻より前または同じです');
    }
    const targetId = calendarId || this.defaultCalendarId;
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      const requestBody = {
        summary: title,
        description,
        start: { dateTime: start, timeZone: 'Asia/Tokyo' },
        end: { dateTime: end, timeZone: 'Asia/Tokyo' },
      };
      if (location) requestBody.location = location;
      const res = await calendar.events.insert({ calendarId: targetId, requestBody });
      return {
        success: true,
        event: {
          id: res?.data?.id,
          title: res?.data?.summary,
          start: res?.data?.start?.dateTime,
          end: res?.data?.end?.dateTime,
          calendarId: targetId,
          calLabel: this.labelFor(targetId),
        },
      };
    });
  }

  // キーワード・日付でイベント検索（delete/update前の検索用）。全カレンダー横断。
  async searchEvents(keyword, dateStr = null) {
    const now = new Date();
    const from = dateStr
      ? new Date(`${dateStr}T00:00:00+09:00`)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7); // 1週間前から
    const to = dateStr
      ? new Date(`${dateStr}T23:59:59+09:00`)
      : new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000); // 30日間
    return this._listAcross({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      q: keyword, // Google Calendar APIの全文検索
    });
  }

  async deleteEvent(eventId, calendarId = null) {
    const targetId = calendarId || this.defaultCalendarId;
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      await calendar.events.delete({ calendarId: targetId, eventId });
      return { success: true };
    });
  }

  async updateEvent(eventId, updates = {}, calendarId = null) {
    const targetId = calendarId || this.defaultCalendarId;
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      const body = {};
      if (updates.title) body.summary = updates.title;
      if (updates.start) body.start = { dateTime: updates.start, timeZone: 'Asia/Tokyo' };
      if (updates.end)   body.end   = { dateTime: updates.end,   timeZone: 'Asia/Tokyo' };
      const res = await calendar.events.patch({ calendarId: targetId, eventId, requestBody: body });
      return {
        success: true,
        event: {
          id: res?.data?.id,
          title: res?.data?.summary,
          start: (res?.data?.start || {}).dateTime || (res?.data?.start || {}).date,
          end:   (res?.data?.end   || {}).dateTime || (res?.data?.end   || {}).date,
          calendarId: targetId,
          calLabel: this.labelFor(targetId),
        },
      };
    });
  }

  // 毎月第N曜日などの繰り返しカレンダーイベントを作成（既定カレンダーへ）
  // rrule例: "FREQ=MONTHLY;BYDAY=2FR" （毎月第2金曜）
  async addRecurringEvent(title, rrule, startDate, startTime = '09:00', endTime = '09:30', description = '', calendarId = null) {
    const targetId = calendarId || this.defaultCalendarId;
    return withRetry(async () => {
      const calendar = await this._getCalendar();
      const res = await calendar.events.insert({
        calendarId: targetId,
        requestBody: {
          summary: title,
          description,
          start: { dateTime: `${startDate}T${startTime}:00`, timeZone: 'Asia/Tokyo' },
          end:   { dateTime: `${startDate}T${endTime}:00`,   timeZone: 'Asia/Tokyo' },
          recurrence: [`RRULE:${rrule}`],
        },
      });
      return {
        success: true,
        event: { id: res?.data?.id, title: res?.data?.summary, rrule, calendarId: targetId },
      };
    });
  }

  async getTodayEvents() {
    const today = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).replace(/\//g, '-');
    return this.listEvents(today, 1);
  }

  async getTomorrowEvents() {
    // JST基準で「明日」の日付を取得（Date.now()+86400000はDST/UTC境界で誤る可能性があるため修正）
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    now.setDate(now.getDate() + 1);
    const tomorrow = now.toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).replace(/\//g, '-');
    return this.listEvents(tomorrow, 1);
  }
}

module.exports = { GoogleCalendarClient };
