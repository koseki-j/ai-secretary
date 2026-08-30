require('dotenv').config();
const ai = require('./ai');
const { GoogleCalendarClient } = require('./calendar');
const { GmailClient } = require('./gmail');
const todo = require('./todo');
const { LineClient, formatCalendarEvents, formatGmailList } = require('./line');
const briefing = require('./briefing');
const { getSecretaryContext } = require('./context');
const logger = require('./lib/logger');

const sessions = new Map();
const processingUsers = new Map(); // userId -> timestamp
const lineClient = new LineClient();
const calendarClient = new GoogleCalendarClient();
const gmailClient = new GmailClient();

// Unknown reply variants
const UNKNOWN_REPLIES = [
  'すみません、もう少し詳しく教えていただけますか？\n\n例:\n・「明日の予定教えて」\n・「未読メール見せて」\n・「TODOに○○を追加して」',
  '申し訳ございません、うまく理解できませんでした。別の言い方でお試しください。\n\n例:\n・「今週の予定は？」\n・「田中さんへのメールを下書きして」',
  'もう一度教えていただけますか？\n\nできること:\n📅 予定の確認・追加・変更・削除\n📧 メールの確認・返信下書き\n📋 TODOの管理',
];

const AFFIRMATIVE = /^(はい|yes|ok|OK|おけ|おk|おK|イエス|よい|よし|いいよ|いいです|送信|する|お願い|おねがい|お願いします|大丈夫|よろしく|確定|登録|追加|削除|合ってる|正しい|それで|問題ない|返信OK|返信ok|送って|やって|けして|消して|消去|削除して|いいよ|ええ|そう|そうして|それで|うん|ん)/i;
const NEGATIVE = /^(いいえ|no|キャンセル|やめて|やめる|中止|取り消し)/i;

// 不動産物件紹介メール除外フィルター（1箇所で管理）
const EXCLUDE_REAL_ESTATE =
  '-subject:(物件紹介 OR 新着物件 OR 物件情報 OR 不動産情報 OR 賃貸物件 OR 売買物件 OR マンション情報 OR "物件のご紹介" OR "新着のご案内" OR "おすすめ物件" OR "物件特集" OR テラスハウス OR アパート OR 利回り OR 満室 OR 空室 OR 戸数 OR 収益物件 OR 投資物件)' +
  ' -from:(homes.co.jp OR suumo.jp OR athome.co.jp OR chintai.com OR realestate)';

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
const RRULE_WD = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };
const RRULE_WD_JA = { SU:'日', MO:'月', TU:'火', WE:'水', TH:'木', FR:'金', SA:'土' };

// RRULE文字列から次回実施日を計算（FREQ=MONTHLY;BYDAY=2FR など）
function calcNextRruleDate(rrule) {
  const now = jstNow();
  const mByday = rrule.match(/BYDAY=(-?\d+)([A-Z]{2})/);
  if (!mByday) {
    // フォールバック: 今日
    return toDateStr(now);
  }
  const nth = parseInt(mByday[1]);
  const wd = RRULE_WD[mByday[2]] ?? 5; // デフォルト金曜

  function findNthWeekdayInMonth(year, month, n, weekday) {
    let d = new Date(year, month, 1);
    let count = 0;
    while (d.getMonth() === month) {
      if (d.getDay() === weekday) {
        count++;
        if (count === n) return d;
      }
      d.setDate(d.getDate() + 1);
    }
    return null;
  }

  let d = findNthWeekdayInMonth(now.getFullYear(), now.getMonth(), nth, wd);
  if (!d || d <= now) {
    // 来月を使う
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    d = findNthWeekdayInMonth(next.getFullYear(), next.getMonth(), nth, wd);
  }
  return d ? toDateStr(d) : toDateStr(now);
}

// RRULE を日本語に変換
function formatRrule(rrule) {
  const mByday = rrule && rrule.match(/BYDAY=(-?\d+)([A-Z]{2})/);
  if (mByday) {
    const nth = parseInt(mByday[1]);
    const wdJa = RRULE_WD_JA[mByday[2]] || mByday[2];
    return `毎月第${nth}${wdJa}曜日`;
  }
  if (/FREQ=WEEKLY/.test(rrule)) return '毎週';
  if (/FREQ=MONTHLY/.test(rrule)) return '毎月';
  return rrule;
}

function jstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// メッセージから期限日を抽出（JST基準）
function extractDueDate(msg) {
  const now = jstNow();
  const year = now.getFullYear();

  // 「3/25」「3月25日」「03/25」などにマッチ
  const mMD = msg.match(/(\d{1,2})[\/月](\d{1,2})日?(?:まで|までに)?/);
  if (mMD) {
    const month = parseInt(mMD[1]);
    const day = parseInt(mMD[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let d = new Date(year, month - 1, day);
      if (d < now) d = new Date(year + 1, month - 1, day); // 過去なら来年
      return toDateStr(d);
    }
  }
  // 「今日」「本日」
  if (/今日|本日/.test(msg)) return toDateStr(now);
  // 「明日」
  if (/明日/.test(msg)) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return toDateStr(d);
  }
  // 「明後日」
  if (/明後日/.test(msg)) {
    const d = new Date(now); d.setDate(d.getDate() + 2); return toDateStr(d);
  }
  // 「今週〇曜」「来週〇曜」
  const mWD = msg.match(/(今週|来週)?(月|火|水|木|金|土|日)曜/);
  if (mWD) {
    const wdMap = { 日:0,月:1,火:2,水:3,木:4,金:5,土:6 };
    const target = wdMap[mWD[2]];
    const d = new Date(now);
    let diff = target - d.getDay();
    if (mWD[1] === '来週') diff += 7;
    else if (diff <= 0) diff += 7; // 今週で当日以前なら次週
    d.setDate(d.getDate() + diff);
    return toDateStr(d);
  }
  return null;
}

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      pendingAction:         null,
      pendingData:           {},
      pendingDataTimestamp:  null, // when pendingAction was set
      pendingAmbiguous:      null,   // ambiguous_question を聞いた後の元メッセージ
      lastMessages:          [],
      lastEmails:            [],     // gmail_list 後に保存
      lastTodos:             [],     // todo_list 後に保存
      lastEvents:            [],     // calendar_list/check 後に保存
      lastDraftId:           null,
      lastDraftPreview:      '',
      lastDraftInfo:         null,
    });
  }
  return sessions.get(userId);
}

// ①②③からTODOを解決
function resolveTodoRef(msg, lastTodos) {
  for (let i = 0; i < NUM_CHARS.length; i++) {
    if (msg.includes(NUM_CHARS[i]) && lastTodos[i]) return { todo: lastTodos[i], num: i + 1 };
  }
  const m = msg.match(/([1-9１-９])(?:番|番目|つ目)?(?:の)?(?:タスク|TODO)/);
  if (m) {
    const idx = parseInt(m[1]) - 1;
    if (lastTodos[idx]) return { todo: lastTodos[idx], num: idx + 1 };
  }
  return null;
}

// 「①」「②」などの番号からメールを解決する
const NUM_CHARS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
function resolveEmailRef(msg, lastEmails) {
  for (let i = 0; i < NUM_CHARS.length; i++) {
    if (msg.includes(NUM_CHARS[i]) && lastEmails[i]) {
      return lastEmails[i];
    }
  }
  const m = msg.match(/([1-9１-９])(?:番|番目|つ目)/);
  if (m) {
    const idx = parseInt(m[1]) - 1;
    if (lastEmails[idx]) return lastEmails[idx];
  }
  return null;
}

// AIがメール本文にヘッダー行（件名:/Subject:/To:等）を混入した場合に除去
function cleanEmailBody(text) {
  return text
    .replace(/^(?:件名|Subject|宛先|To|From|差出人)[：:]\s*.+(\r?\n)?/gim, '')
    .replace(/^\s*\r?\n/, '') // 先頭の空行を除去
    .trim();
}

function clearPending(session) {
  session.pendingAction = null;
  session.pendingData = {};
  session.pendingDataTimestamp = null;
}

function setPending(session, action, data) {
  session.pendingAction = action;
  session.pendingData = data;
  session.pendingDataTimestamp = Date.now();
}

function dateLabel(dateStr) {
  // 正午JST(03:00 UTC)で曜日計算 → UTC環境でも日付ずれが起きない
  const d = new Date(dateStr + 'T12:00:00+09:00');
  const [, mm, dd] = dateStr.split('-').map(Number);
  const wd = WEEKDAY_JA[d.getDay()];
  return `${mm}月${dd}日（${wd}）`;
}

// 予定の確認メッセージ用時刻フォーマット（JST固定）
function formatEventLabel(params) {
  const s = new Date(params.start).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
  const e = new Date(params.end).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = params.start.slice(0, 10);
  return `${dateLabel(dateStr)} ${s}〜${e}`;
}

async function executePending(session, replyToken) {
  const { pendingAction, pendingData } = session;
  clearPending(session);

  switch (pendingAction) {
    case 'calendar_add':
    case 'calendar_add_force': {
      const { title, start, end, description, location } = pendingData;
      try {
        await calendarClient.addEventForce(title, start, end, description || '', location || '');
        const label = formatEventLabel({ start, end });
        const locLine = location ? `\n📍 ${location}` : '';
        await lineClient.replyMessage(replyToken, `✅ カレンダーに登録しました\n${title}\n${label}${locLine}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `❌ 追加に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'gmail_send': {
      const { draftId } = pendingData;
      try {
        await gmailClient.sendDraft(draftId);
        await lineClient.replyMessage(replyToken, '✅ 送信しました');
      } catch (e) {
        await lineClient.replyMessage(replyToken, `送信に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'calendar_delete': {
      const { eventId } = pendingData;
      try {
        await calendarClient.deleteEvent(eventId);
        await lineClient.replyMessage(replyToken, '🗑 削除しました');
      } catch (e) {
        await lineClient.replyMessage(replyToken, `削除に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'todo_delete': {
      const { id, title } = pendingData;
      try {
        await todo.delete(id);
        await lineClient.replyMessage(replyToken, `🗑 削除しました${title ? `\n${title}` : ''}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'calendar_update': {
      const { eventId, updates } = pendingData;
      try {
        const result = await calendarClient.updateEvent(eventId, updates);
        const label = formatEventLabel({ start: result.event.start, end: result.event.end });
        await lineClient.replyMessage(replyToken, `✅ 変更しました\n${result.event.title}\n${label}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `変更に失敗しました: ${e.message}`);
      }
      return;
    }

    case 'todo_delete_by_title': {
      const { toDelete } = pendingData;
      try {
        for (const t of toDelete) {
          await todo.delete(t.id);
        }
        const deletedList = toDelete.map(t => `・${t.title}`).join('\n');
        await lineClient.replyMessage(replyToken,
          `🗑 ${toDelete.length}件のTODOを削除しました\n${deletedList}`
        );
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
      }
      return;
    }

    default:
      await lineClient.replyMessage(replyToken, 'キャンセルしました');
  }
}

// メール一覧取得の共通処理
async function fetchAndShowEmails(session, replyToken, max = 5) {
  const emails = await gmailClient.listUnread(max, `in:inbox is:unread ${EXCLUDE_REAL_ESTATE}`);
  session.lastEmails = emails;
  await lineClient.replyMessage(replyToken, formatGmailList(emails));
}

// メッセージから「N件」「N通」を抽出する
function parseEmailCount(msg) {
  const m = msg.match(/(\d+)[件通]/);
  return m ? Math.min(parseInt(m[1]), 10) : 5; // 最大10件に制限
}

// ────────────────────────────────────────────────────────────
// 複数action一括実行用：結果テキストを返す（replyMessage は呼ばない）
// read-only系の action のみ対応（add/update/delete は確認が必要なため単一actionで処理）
// ────────────────────────────────────────────────────────────
async function resolveActionText(actionItem, session, userMessage) {
  const { action, params } = actionItem;

  switch (action) {
    case 'calendar_list': {
      const rangeDays = params.range_days || 1;
      let events = await calendarClient.listEvents(params.date, rangeDays);
      if (/残り|これから|あと|まだ/.test(userMessage) && rangeDays === 1) {
        const nowJst = jstNow();
        events = events.filter(e => e.end && new Date(e.end) > nowJst);
      }
      session.lastEvents = events; // 文脈保持
      const label = rangeDays > 1 ? `${dateLabel(params.date)}〜` : dateLabel(params.date);
      return formatCalendarEvents(events, label, rangeDays);
    }

    case 'calendar_check': {
      const events = await calendarClient.listEvents(params.date, 1);
      session.lastEvents = events;
      const dl = dateLabel(params.date);
      if (!events.length) return `📅 ${dl}は終日空いています ✅`;
      const lines = [`📅 ${dl}の埋まっている時間:`, '━━━━━━━━━━'];
      for (const e of events) {
        const s = e.start ? new Date(e.start).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        const en = e.end ? new Date(e.end).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        lines.push(`${s && en ? `${s}〜${en} ` : ''}${e.title}`);
      }
      return lines.join('\n');
    }

    case 'todo_list': {
      const rawFilter = params.filter || 'pending';
      const filter = rawFilter === 'all' ? 'pending' : rawFilter;
      const items = await todo.list(filter);
      if (filter === 'pending') session.lastTodos = items;
      const msg = await todo.formatList(items);
      return filter === 'completed' ? msg.replace('📋 TODO', '✅ 完了済みTODO') : msg;
    }

    case 'gmail_list': {
      const baseQuery = params.query || 'in:inbox is:unread';
      const emails = await gmailClient.listUnread(params.max || 5, `${baseQuery} ${EXCLUDE_REAL_ESTATE}`);
      session.lastEmails = emails;
      return formatGmailList(emails);
    }

    // ── 書き込み系: 確認不要で即実行（multi-action モードでのみ呼ばれる）──

    case 'todo_add': {
      // 単一TODO追加（確認なし）
      const added = await todo.add(params.title, params.due_date || null, params.priority || 'normal');
      const dueStr = params.due_date
        ? `\n期限: ${params.due_date.slice(5).replace('-','/')}`
        : '';
      return `✅ TODOに追加しました\n${added.title}${dueStr}`;
    }

    case 'todo_setup_recurring': {
      // 複数TODO一括追加（カレンダーリマインダーはmulti-actionでは別actionに任せる）
      const todos = params.todos || [];
      if (!todos.length) return null;
      const addedTitles = [];
      for (const item of todos) {
        const added = await todo.add(item.title, item.due_date || null, item.priority || 'normal');
        addedTitles.push(added.title);
      }
      const todoList = addedTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
      return `✅ ${addedTitles.length}件のTODOを登録しました\n━━━━━━━━━━\n${todoList}`;
    }

    case 'calendar_add': {
      // 単一予定追加（multi-action時は確認なしで即追加）
      await calendarClient.addEventForce(params.title, params.start, params.end, params.description || '');
      const label = formatEventLabel(params);
      return `📅 カレンダーに追加しました\n「${params.title}」${label ? '\n' + label : ''}`;
    }

    case 'calendar_add_multi': {
      // 複数予定一括追加
      const events = params.events || [];
      if (!events.length) return null;
      const added = [];
      const failed = [];
      for (const ev of events) {
        try {
          await calendarClient.addEventForce(ev.title, ev.start, ev.end, ev.description || '');
          added.push(`・${ev.title} ${formatEventLabel({ start: ev.start, end: ev.end })}`);
        } catch (err) {
          failed.push(`・${ev.title}（失敗: ${err.message}）`);
        }
      }
      let msg = `📅 ${added.length}件の予定を追加しました\n${added.join('\n')}`;
      if (failed.length) msg += `\n\n⚠️ 失敗:\n${failed.join('\n')}`;
      return msg;
    }

    default:
      // 削除・更新・送信など破壊的操作は multi-action では実行しない（単一action で確認フローへ）
      return null;
  }
}

async function dispatch(userId, userMessage, replyToken) {
  // Check cooldown (3 second debounce per user)
  const lastProcess = processingUsers.get(userId);
  if (lastProcess && Date.now() - lastProcess < 3000) {
    await lineClient.replyMessage(replyToken, '処理中です、少々お待ちください ⏳');
    return;
  }
  processingUsers.set(userId, Date.now());

  const session = getSession(userId);

  // Check pendingAction expiry (5 minutes)
  if (session.pendingAction && session.pendingDataTimestamp) {
    if (Date.now() - session.pendingDataTimestamp > 5 * 60 * 1000) {
      clearPending(session);
      await lineClient.replyMessage(replyToken, 'お待たせしました。前の操作がタイムアウトしました。もう一度お願いいたします。');
      return;
    }
  }

  // Check pendingAmbiguous expiry (5 minutes)
  if (session.pendingAmbiguous && session.pendingAmbiguous.timestamp) {
    if (Date.now() - session.pendingAmbiguous.timestamp > 5 * 60 * 1000) {
      session.pendingAmbiguous = null;
    }
  }

  // 表記ゆれを正規化（To do / to-do → TODO）
  userMessage = userMessage.replace(/[Tt]o[\s\-]?[Dd]o/g, 'TODO');

  // ── ambiguous_question への回答処理 ──────────────────────
  // 前回「田中さんの件というのは？」などを返した場合、元メッセージ+回答でコンテキストに追加して再解釈
  if (session.pendingAmbiguous) {
    const { originalMessage } = session.pendingAmbiguous;
    session.pendingAmbiguous = null;
    // 元のメッセージをlastMessagesに追加してコンテキストとして渡す
    session.lastMessages.push({ role: 'user', content: originalMessage });
    session.lastMessages.push({ role: 'assistant', content: 'どのような内容でしょうか？' });
    // userMessage（ユーザーの回答）はそのまま続けて処理
  }

  // 肯定応答
  if (session.pendingAction && AFFIRMATIVE.test(userMessage.trim())) {
    await executePending(session, replyToken);
    return;
  }

  // 否定応答
  if (session.pendingAction && NEGATIVE.test(userMessage.trim())) {
    clearPending(session);
    await lineClient.replyMessage(replyToken, 'キャンセルしました');
    return;
  }

  // 「ドラフトに署名/本文を追加」→ 現在の下書きを更新して再プレビュー
  if (session.lastDraftId && /署名|本文.*追加|追記|ドラフト.*修正|下書き.*修正/.test(userMessage)) {
    try {
      // 既存ドラフトを取得してAIで本文を更新
      const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。既存のメール本文に指示の内容を追加・修正してください。本文のみ出力してください。`;
      const instruction = userMessage;
      // Note: gmailClient.getDraft は実装されていないため、AIに指示だけ渡して新規ドラフトを作成
      // lastDraftPreview があれば利用
      const prevPreview = session.lastDraftPreview || '';
      const userPrompt = `以下のメール本文に指示を適用してください。\n指示: ${instruction}\n\n既存本文（冒頭のみ）:\n${prevPreview}`;
      const newBody = cleanEmailBody(await ai.generateReply(systemPrompt, userPrompt));
      // 新しいドラフトを作成（既存は削除せず上書き用に新規作成）
      const draftInfo = session.lastDraftInfo || {};
      const draft = await gmailClient.createDraft(
        draftInfo.to || '',
        draftInfo.subject || '（件名なし）',
        newBody,
        draftInfo.replyToId || null
      );
      const previewMsg = `署名を追加しました。送信しますか？\n\n─────\n${draft.preview}…\n─────`;
      setPending(session, 'gmail_send', { draftId: draft.draftId });
      session.lastDraftId = draft.draftId;
      session.lastDraftPreview = draft.preview;
      await lineClient.replyMessage(replyToken, previewMsg);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `下書き修正に失敗しました: ${e.message}`);
    }
    return;
  }

  // 「②をアーカイブ」→ 番号でメール参照して即アーカイブ（確認なし）
  const archiveRef = resolveEmailRef(userMessage, session.lastEmails || []);
  if (archiveRef && /アーカイブ|archive/i.test(userMessage)) {
    try {
      await gmailClient.archiveMessage(archiveRef.id);
      await lineClient.replyMessage(replyToken, `📦 アーカイブしました\n「${archiveRef.subject}」`);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `アーカイブに失敗しました: ${e.message}`);
    }
    return;
  }

  // 「タスク名 + 消して/けして/削除して」→ TODOキーワードなしでも削除処理（例：「アパート挨拶けして」）
  if (/消して|けして|削除/.test(userMessage) && !/メール|カレンダー|予定/.test(userMessage)) {
    const keyword = userMessage
      .replace(/消して|けして|削除して?/g, '')
      .replace(/[をがはもで]/g, '')
      .trim();
    if (keyword.length > 1) {
      try {
        const allPending = await todo.list('pending');
        // 部分一致検索：キーワードの各文字列を2文字以上の断片に分割してすべて試す
        const keywordParts = keyword.split(/[\s　]/).filter(w => w.length >= 2);
        // キーワード全体が2文字以上なら丸ごとも候補に（重複除去）
        if (keyword.length >= 2 && !keywordParts.includes(keyword)) keywordParts.unshift(keyword);
        const matches = allPending.filter(t =>
          keyword.includes(t.title) ||
          t.title.includes(keyword) ||
          keywordParts.some(w => t.title.includes(w))
        );
        if (matches.length > 0) {
          const previewList = matches.map(t => `・${t.title}`).join('\n');
          setPending(session, 'todo_delete_by_title', { toDelete: matches });
          await lineClient.replyMessage(replyToken,
            `以下の${matches.length}件のTODOを削除しますか？\n━━━━━━━━━━\n${previewList}`
          );
          return;
        }
        // ★マッチなし → AIに渡さず「見つかりません」で返す（AI誤動作防止）
        await lineClient.replyMessage(replyToken,
          `「${keyword}」に該当するTODOは見つかりませんでした\n\nTODO一覧を確認しますか？`
        );
        return;
      } catch (e) {
        logger.error('dispatcher', 'todo delete search error', { error: e.message });
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
        return;
      }
    }
  }

  // 「①のタスクを完了/削除にして」→ 番号でTODO参照
  const todoRef = resolveTodoRef(userMessage, session.lastTodos || []);
  if (todoRef) {
    if (/完了|終わった|done|済み/i.test(userMessage)) {
      try {
        await todo.complete(todoRef.todo.id);
        await lineClient.replyMessage(replyToken, `✅ 完了しました\n${todoRef.todo.title}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO完了に失敗しました: ${e.message}`);
      }
      return;
    }
    if (/削除|消して|消す|delete/i.test(userMessage)) {
      setPending(session, 'todo_delete', { id: todoRef.todo.id, title: todoRef.todo.title });
      await lineClient.replyMessage(replyToken, `「${todoRef.todo.title}」を削除しますか？`);
      return;
    }
  }

  // 「直近/最新のメールに返信」→ lastEmails[0] を使用
  if (/直近|最新|さっき.*メール|最初|最後|一番上/.test(userMessage) && /返信|返事|返答|reply/i.test(userMessage)) {
    const latestEmail = (session.lastEmails || [])[0];
    if (latestEmail) {
      try {
        const original = await gmailClient.readMessage(latestEmail.id);
        const instruction = userMessage.replace(/直近|最新|さっき|最初|最後|一番上|のメール|に返信して?|返信ドラフト.*作って?/g, '').trim();
        const bodyInstruction = userMessage.match(/[『「](.*?)[』」]/) ? userMessage.match(/[『「](.*?)[』」]/)[1] : instruction;
        const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。簡潔・丁寧なメール文面を作成してください。署名は不要です。本文のみ出力してください。`;
        const userPrompt = `以下の指示でメールを返信してください。\n指示: ${bodyInstruction}\n\n--- 返信元メール ---\nFrom: ${original.from}\n件名: ${original.subject}\n本文:\n${original.body.slice(0, 500)}`;
        const bodyText = cleanEmailBody(await ai.generateReply(systemPrompt, userPrompt));
        const subject = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`;
        const draft = await gmailClient.createDraft(original.from, subject, bodyText, latestEmail.id);
        const previewMsg = `以下の内容で下書き保存しました。送信しますか？\n\n宛先: ${original.from}\n件名: ${subject}\n─────\n${draft.preview}…\n─────`;
        setPending(session, 'gmail_send', { draftId: draft.draftId });
        session.lastDraftId = draft.draftId;
        session.lastDraftPreview = draft.preview;
        session.lastDraftInfo = { to: original.from, subject, replyToId: latestEmail.id };
        await lineClient.replyMessage(replyToken, previewMsg);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `返信の作成に失敗しました: ${e.message}`);
      }
      return;
    }
  }

  // 「①に〇〇と返信して/返事して」→ 番号でメール参照して返信処理
  // lastEmailsが空でも番号+返信パターンがあれば自動取得してから処理
  let refEmail = resolveEmailRef(userMessage, session.lastEmails || []);
  if (!refEmail && /[①-⑩]/.test(userMessage) && /返信|返事|返答|reply/i.test(userMessage)) {
    try {
      const fetched = await gmailClient.listUnread(5, `in:inbox is:unread ${EXCLUDE_REAL_ESTATE}`);
      session.lastEmails = fetched;
      refEmail = resolveEmailRef(userMessage, fetched);
    } catch (e) {
      logger.warn('dispatcher', 'メール自動取得失敗', { error: e.message });
    }
  }
  if (refEmail && /返信|返事|返答|reply/i.test(userMessage)) {
    try {
      const original = await gmailClient.readMessage(refEmail.id);
      const instruction = userMessage.replace(/[①-⑩]|[1-9]番(目)?|に返信して?|に返事して?|に返答して?|返信して?|返事して?|返答して?|に$/, '').trim();
      const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。簡潔・丁寧なメール文面を作成してください。署名は不要です。本文のみ出力してください。`;
      const userPrompt = `以下の指示でメールを返信してください。\n指示: ${instruction}\n\n--- 返信元メール ---\nFrom: ${original.from}\n件名: ${original.subject}\n本文:\n${original.body.slice(0, 500)}`;
      const bodyText = cleanEmailBody(await ai.generateReply(systemPrompt, userPrompt));
      const subject = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`;
      const draft = await gmailClient.createDraft(original.from, subject, bodyText, refEmail.id);
      const previewMsg = `以下の内容で下書き保存しました。送信しますか？\n\n宛先: ${original.from}\n件名: ${subject}\n─────\n${draft.preview}…\n─────`;
      setPending(session, 'gmail_send', { draftId: draft.draftId });
      session.lastDraftId = draft.draftId;
      session.lastDraftPreview = draft.preview;
      session.lastDraftInfo = { to: original.from, subject, replyToId: refEmail.id };
      await lineClient.replyMessage(replyToken, previewMsg);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `返信の作成に失敗しました: ${e.message}`);
    }
    return;
  }

  // TODO操作をキーワードで確実に判定
  // ※ 「TODO」という文字列がなくても、TODOリスト形式（🟡[中]...）があればTODOコンテキストと判定
  const hasTodoKeyword = /TODO|タスク/i.test(userMessage);
  // ※ emoji を文字クラス [] に入れるとサロゲートペア問題が起きるため交替形式 (A|B|C) を使う
  const hasTodoListFormat = /(🔴|🟡|🟢)\s*\[(?:高|中|低)\]/.test(userMessage);
  if (hasTodoKeyword || hasTodoListFormat) {
    // ── 削除を最優先でルーティング（「下記のtodo消して」「これ消して＋TODO一覧」バグ対策）──
    if (/消して|削除|消去|delete/i.test(userMessage)) {
      try {
        // タイトル抽出：TODOフォーマット行（🟡[中] タイトル）と番号付き箇条書きの両方に対応
        const titleLines = userMessage
          .split(/\n/)
          .map(l => {
            // TODO一覧フォーマット: 🟡 [中] タイトル（期限: X/X）  ※交替形式で emoji を安全にマッチ
            const todoFmt = l.match(/(🔴|🟡|🟢)\s*\[(?:高|中|低)\]\s*(.+?)(?:（期限:.*?）)?\s*$/);
            if (todoFmt) return todoFmt[2].trim(); // グループ2がタイトル
            // 番号付きリスト: 1. タイトル、① タイトル、・タイトル
            return l.replace(/^[\s　]*(?:[\d①-⑩]+[\.。、\s　]|[・•]\s*)/, '').trim();
          })
          .filter(l => l.length > 2 && !/TODO|消して|削除|下記|これ/i.test(l));

        // 「完了済み」を削除対象にする場合は completed フィルターを使う
        const deleteCompleted = /完了済み|済みタスク|completedタスク/i.test(userMessage);
        const filter = deleteCompleted ? 'completed' : 'pending';
        const isDeleteAll = titleLines.length === 0 && /全部|全て|すべて|all/i.test(userMessage);

        if (isDeleteAll || titleLines.length > 0 || deleteCompleted) {
          const allTodos = await todo.list(filter);
          const toDelete = isDeleteAll || (deleteCompleted && titleLines.length === 0)
            ? allTodos
            : allTodos.filter(t =>
                titleLines.some(target => {
                  const coreTitle = t.title.replace(/^【[^】]*】/, '').trim();
                  const coreTarget = target.replace(/^【[^】]*】/, '').trim();
                  if (!coreTarget) return false;
                  return t.title.includes(target) ||
                    coreTitle.includes(coreTarget) ||
                    coreTarget.includes(coreTitle);
                })
              );

          if (!toDelete.length) {
            await lineClient.replyMessage(replyToken,
              `該当するTODOが見つかりませんでした\n検索ワード: ${titleLines.join('、') || '(全件)'}`
            );
            return;
          }
          const previewList = toDelete.map(t => `・${t.title}`).join('\n');
          setPending(session, 'todo_delete_by_title', { toDelete });
          await lineClient.replyMessage(replyToken,
            `以下の${toDelete.length}件のTODOを削除しますか？\n━━━━━━━━━━\n${previewList}`
          );
          return;
        }
      } catch (e) {
        logger.error('dispatcher', 'todo_delete keyword error', { error: e.message });
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
        return;
      }
      // タイトルが抽出できなかった場合はAIへフォールスルー
    }

    if (/追加|ついか|加えて|入れて|add|登録/i.test(userMessage)) {
      // シンプルな1件追加（「TODOに〇〇を追加」形式）のみ直接処理
      // 複数項目・リマインド付きはAIへフォールスルー
      const flat = userMessage.replace(/\n|\r/g, ' ').trim();
      const hasMultipleItems = /[①-⑩]|（\d）|\(\d\)/.test(userMessage);
      const hasReminder = /リマインド|毎月|繰り返し|第[一二三四五]?[1-5]?金曜|毎週/.test(userMessage);

      // マルチライン: 「1行目=タイトル\n最終行=todoを追加して」パターンを優先処理
      let multilineTitle = null;
      const msgLines = userMessage.trim().split(/[\n\r]+/);
      if (!hasMultipleItems && !hasReminder && msgLines.length >= 2) {
        const lastLine = msgLines[msgLines.length - 1];
        // 「todoに入れて」「タスクに追加して」など（にへをが を許容）
        if (/(?:todo|タスク)[をがにへ]?[\s　]*(追加|加えて|入れて)/i.test(lastLine)) {
          const candidate = msgLines.slice(0, -1).join(' ').replace(/[「」『』【】]/g, '').trim();
          if (candidate.length > 1) multilineTitle = candidate;
        }
      }

      // 「TODOに TITLE を 入れて」パターン
      const mTodoFirst = !hasMultipleItems && !hasReminder && !multilineTitle
        ? flat.match(/(?:TODO|タスク)[にへ]?[\s　]*(.+?)[\s　]*[をが]?[\s　]*(追加|加えて|入れて|add|登録)/i)
        : null;
      // 「TITLE を TODOに 入れて」パターン（自然な語順）
      const mTitleFirst = !hasMultipleItems && !hasReminder && !multilineTitle
        ? flat.match(/^(.+?)[をが][\s　]*(?:TODO|タスク)[をがにへ]?[\s　]*(追加|加えて|入れて|add|登録)/i)
        : null;
      // 「TITLE + TODO + 追加」パターン（区切り文字なし: 「まつど売却活動Todo追加」など）
      const mConcatTodo = !hasMultipleItems && !hasReminder && !multilineTitle
        ? flat.match(/^(.+?)(?:TODO|タスク)[にへをが]?[\s　]*(追加|加えて|入れて|add|登録)/i)
        : null;
      const m = mTodoFirst || mTitleFirst || mConcatTodo;

      // タイトル候補を決定（マルチライン優先 → 正規表現 → フォールスルー）
      let rawTitle = multilineTitle || (m ? m[1].trim() : null);
      if (rawTitle) {
        // 期限は全メッセージから抽出
        const dueDate = extractDueDate(userMessage);
        const cleanTitle = rawTitle
          .replace(/(\d{1,2})[\/月](\d{1,2})日?(?:まで|までに)?/g, '')
          .replace(/今日|本日|明日|明後日/g, '')
          .replace(/(今週|来週)?(月|火|水|木|金|土|日)曜(?:まで|までに)?/g, '')
          .replace(/期限(で|に|は|まで)?/g, '')
          .replace(/まで(に)?/g, '')
          .replace(/[「」『』【】]/g, '')
          .replace(/\s*[をが]\s*/g, '')
          .replace(/[\s　]+/g, ' ')
          .trim();
        const title = cleanTitle || rawTitle;
        // タイトルが助詞1文字だけの場合はAIへフォールスルー
        if (title.length <= 1) {
          rawTitle = null; // フォールスルーへ
        } else {
          try {
            const added = await todo.add(title, dueDate, 'normal');
            const dueStr = dueDate ? `\n期限: ${dueDate.slice(5).replace('-','/')}` : '';
            await lineClient.replyMessage(replyToken, `✅ TODOに追加しました\n${added.title}${dueStr}`);
            // 追加後に会話履歴をクリア（タイトルが次の発話に混入するのを防ぐ）
            session.lastMessages = [];
          } catch (e) {
            logger.error('dispatcher', 'todo_add error', { error: e.message });
            await lineClient.replyMessage(replyToken, `TODO追加に失敗しました: ${e.message}`);
          }
          return;
        }
      }
      // 複数項目・リマインド付き・タイトル取れない場合はAIへフォールスルー
    } else if (/完了|終わった|done|済み/.test(userMessage)) {
      // TODO完了もAIへフォールスルー
    } else if (/見せて|一覧|リスト|確認|表示|は？|教えて|出して|ちょうだい|見たい|どんな感じ/.test(userMessage)) {
      // 「済み/完了タスク」はAIへ（completedフィルターが必要）
      if (!/済み|完了/.test(userMessage)) {
        try {
          const items = await todo.list('pending');
          session.lastTodos = items; // ①番号解決用に保存
          await lineClient.replyMessage(replyToken, await todo.formatList(items));
        } catch (e) {
          await lineClient.replyMessage(replyToken, `TODO一覧の取得に失敗しました: ${e.message}`);
        }
        return;
      }
    }
    // それ以外はAIへフォールスルー（複雑な要求はAIが解釈）
  }

  // カレンダーキーワード → スケジュール表示（AI誤解釈防止）
  if (
    /スケジュール|予定|カレンダー/.test(userMessage) &&
    /確認|見せて|出して|チェック|教えて|表示|一覧/.test(userMessage) &&
    !/追加|登録|作成|変更|削除|入れて/.test(userMessage) &&
    !/TODO|タスク/i.test(userMessage)  // TODO/タスクが含まれる場合はカレンダーに横取りさせない
  ) {
    try {
      const isTomorrow = /明日/.test(userMessage) && !/明後日/.test(userMessage);
      const isWeek = /一週間|1週間|今週|週間|7日/.test(userMessage);
      // new Date() → 'Asia/Tokyo' で直接変換（jstNow()経由だとUTC環境で二重変換になり翌日になるバグを防ぐ）
      let baseDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
      if (isTomorrow) {
        const [y, m, d] = baseDate.split('-').map(Number);
        const tom = new Date(y, m - 1, d + 1);
        baseDate = `${tom.getFullYear()}-${String(tom.getMonth()+1).padStart(2,'0')}-${String(tom.getDate()).padStart(2,'0')}`;
      }
      const days = isWeek ? 7 : 1;
      const events = await calendarClient.listEvents(baseDate, days);
      const text = formatCalendarEvents(events, dateLabel(baseDate), days);
      await lineClient.replyMessage(replyToken, text);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `スケジュールの取得に失敗しました: ${e.message}`);
    }
    return;
  }

  // メールキーワードは確実にメール一覧へ（todo追加・完了などと混同しないよう限定）
  if (/未読メール|メール見せて|メールチェック|inbox/i.test(userMessage)) {
    try {
      const maxCount = parseEmailCount(userMessage);
      await fetchAndShowEmails(session, replyToken, maxCount);
    } catch (e) {
      await lineClient.replyMessage(replyToken, `メールの取得に失敗しました: ${e.message}`);
    }
    return;
  }

  // 意図解釈（AI）
  const intent = await ai.parseIntent(userMessage, {
    recentMessages:       session.lastMessages,
    pendingAction:        session.pendingAction,
    lastMentionedEmails:  session.lastEmails  || [],
    lastMentionedEvents:  session.lastEvents  || [],
  });

  session.lastMessages.push({ role: 'user', content: userMessage });
  if (session.lastMessages.length > 4) session.lastMessages.shift();

  // ── ambiguous（判断不能）応答の処理 ─────────────────────
  if (intent.ambiguous && intent.ambiguous_question) {
    session.pendingAmbiguous = { originalMessage: userMessage, timestamp: Date.now() };
    await lineClient.replyMessage(replyToken, intent.ambiguous_question);
    return;
  }

  // ── 複数action の順次実行 ────────────────────────────────
  let actions = Array.isArray(intent.actions)
    ? intent.actions
    : [{ action: intent.action || 'unknown', params: intent.params || {}, needs_confirm: false }];

  // 【明示的依頼の原則】ユーザー発話にTODOのみ指示 → calendar_add系を除去
  // ユーザー発話にカレンダーのみ指示 → todo_add系を除去（混入バグ防止）
  if (actions.length > 1) {
    const msgHasTodoOnly  = /todo|タスク|やること|忘れない|追加して/i.test(userMessage) &&
                            !/カレンダー|スケジュール|予定.*入れ|登録/i.test(userMessage);
    const msgHasCalOnly   = /カレンダー.*入れ|スケジュール.*入れ|予定.*入れ|登録/i.test(userMessage) &&
                            !/todo|タスク|todoも|カレンダーにも/i.test(userMessage);
    if (msgHasTodoOnly) {
      // TODOのみ指示 → calendar系・gmail系をすべて除去（メール一覧が混入するバグ防止）
      actions = actions.filter(a => !['calendar_add','calendar_add_multi','calendar_add_force','gmail_list','gmail_draft','gmail_send'].includes(a.action));
    }
    if (msgHasCalOnly) {
      actions = actions.filter(a => !['todo_add','todo_setup_recurring'].includes(a.action));
    }
  }

  if (actions.length > 1) {
    // 書き込み系actionがある場合は一覧表示をスキップ（追加時にリスト不要）
    const hasWriteAction = actions.some(a =>
      ['todo_add', 'todo_setup_recurring', 'calendar_add', 'calendar_add_multi'].includes(a.action)
    );
    // カレンダー表示のみ求めている場合はtodo_listをスキップ
    const hasCalendarList = actions.some(a => a.action === 'calendar_list' || a.action === 'calendar_check');
    const results = [];
    for (const actionItem of actions) {
      if (hasWriteAction && (actionItem.action === 'todo_list' || actionItem.action === 'calendar_list')) continue;
      if (hasCalendarList && actionItem.action === 'todo_list') continue;
      try {
        const text = await resolveActionText(actionItem, session, userMessage);
        if (text) results.push(text);
      } catch (e) {
        logger.error('dispatcher', 'multi-action error', { error: e.message });
      }
    }
    if (results.length > 0) {
      await lineClient.replyMessages(replyToken, results.slice(0, 5));
    } else {
      await lineClient.replyMessage(replyToken, intent.reply || 'すみません、もう一度おっしゃっていただけますか？');
    }
    return;
  }

  // ── 単一action の処理 ───────────────────────────────────
  const { action, params } = actions[0];
  const reply = intent.reply;

  switch (action) {
    case 'calendar_list': {
      try {
        const rangeDays = params.range_days || 1;
        let events = await calendarClient.listEvents(params.date, rangeDays);
        // 「残り予定」「これから」などのキーワードがある場合は現在時刻以降のみ表示
        if (/残り|これから|あと|まだ/.test(userMessage) && rangeDays === 1) {
          const nowJst = jstNow();
          events = events.filter(e => e.end && new Date(e.end) > nowJst);
        }
        session.lastEvents = events; // 文脈引き継ぎ用に保存
        const label = rangeDays > 1 ? `${dateLabel(params.date)}〜` : dateLabel(params.date);
        const text = formatCalendarEvents(events, label, rangeDays);
        await lineClient.replyMessage(replyToken, text);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダーの取得に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_check': {
      // 特定日の空き確認（予定一覧＋空き時間帯を表示）
      try {
        const events = await calendarClient.listEvents(params.date, 1);
        session.lastEvents = events;
        const dl = dateLabel(params.date);
        if (!events.length) {
          await lineClient.replyMessage(replyToken, `📅 ${dl}は終日空いています ✅`);
          break;
        }
        const lines = [`📅 ${dl}の状況:`, '━━━━━━━━━━'];
        for (const e of events) {
          const s  = e.start ? new Date(e.start).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
          const en = e.end   ? new Date(e.end).toLocaleTimeString('ja-JP',   { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
          lines.push(`🔴 ${s && en ? `${s}〜${en} ` : ''}${e.title}`);
        }
        await lineClient.replyMessage(replyToken, lines.join('\n'));
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダーの取得に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_add': {
      try {
        // 重複チェック（失敗しても確認フローは継続する）
        let conflicts = [];
        try {
          conflicts = await calendarClient.checkConflict(params.start, params.end);
        } catch (_) { /* 認証エラー等でも確認フローは続行 */ }

        const label = formatEventLabel(params);
        const locLine = params.location ? `\n📍 ${params.location}` : '';
        if (conflicts.length > 0) {
          const conflictNames = conflicts.map(c => c.title).join('、');
          setPending(session, 'calendar_add_force', params);
          await lineClient.replyMessage(replyToken, `⚠️ 重複があります\n「${conflictNames}」が入っています。それでも追加しますか？\n\n${params.title}\n${label}${locLine}`);
          return;
        }
        setPending(session, 'calendar_add', params);
        await lineClient.replyMessage(replyToken, `「${params.title}」を\n${label}に追加してよいですか？${locLine}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダー追加に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_delete': {
      // キーワードで検索してから確認
      try {
        const found = await calendarClient.searchEvents(params.keyword || '', params.date || null);
        if (!found.length) {
          await lineClient.replyMessage(replyToken, `「${params.keyword}」に該当する予定が見つかりませんでした`);
          break;
        }
        if (found.length === 1) {
          const ev = found[0];
          const label = formatEventLabel({ start: ev.start, end: ev.end });
          setPending(session, 'calendar_delete', { eventId: ev.id });
          await lineClient.replyMessage(replyToken, `この予定を削除しますか？\n「${ev.title}」\n${label}`);
        } else {
          // 複数ヒット → 最初の3件を表示して絞り込み依頼
          const list = found.slice(0, 3).map((ev, i) => {
            const label = formatEventLabel({ start: ev.start, end: ev.end });
            return `${NUM_CHARS[i]} ${ev.title} ${label}`;
          }).join('\n');
          session.lastEvents = found.slice(0, 3);
          await lineClient.replyMessage(replyToken, `複数の予定が見つかりました。どれを削除しますか？\n${list}`);
        }
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダー検索に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_update': {
      // キーワードで検索してから変更
      try {
        const found = await calendarClient.searchEvents(params.keyword || '', params.date || null);
        if (!found.length) {
          await lineClient.replyMessage(replyToken, `「${params.keyword}」に該当する予定が見つかりませんでした`);
          break;
        }
        const ev = found[0]; // 最も近い1件を使用
        const updates = {};
        if (params.new_title) updates.title = params.new_title;
        if (params.new_start) updates.start = params.new_start;
        if (params.new_end)   updates.end   = params.new_end;
        // 開始時刻のみ変更の場合、元の長さを維持して終了時刻を自動計算（JST形式で返す）
        if (params.new_start && !params.new_end && ev.end) {
          const origDuration = new Date(ev.end).getTime() - new Date(ev.start).getTime();
          const newEndMs = new Date(params.new_start).getTime() + origDuration;
          // JST offset を維持した ISO 文字列に変換
          const newEndDate = new Date(newEndMs);
          const jstOffset = 9 * 60;
          const localMs = newEndDate.getTime() + jstOffset * 60000;
          const d = new Date(localMs);
          updates.end = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}T${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:00+09:00`;
        }
        const newStart = updates.start || ev.start;
        const newEnd   = updates.end   || ev.end;
        const label = formatEventLabel({ start: newStart, end: newEnd });
        setPending(session, 'calendar_update', { eventId: ev.id, updates });
        await lineClient.replyMessage(replyToken,
          `「${ev.title}」を以下の内容に変更してよいですか？\n${label}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダー変更に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'gmail_list': {
      try {
        const baseQuery = params.query || 'in:inbox is:unread';
        const emails = await gmailClient.listUnread(params.max || 5, `${baseQuery} ${EXCLUDE_REAL_ESTATE}`);
        session.lastEmails = emails;
        await lineClient.replyMessage(replyToken, formatGmailList(emails));
      } catch (e) {
        await lineClient.replyMessage(replyToken, `メールの取得に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'gmail_draft': {
      try {
        let originalInfo = '';
        if (params.reply_to_id) {
          const original = await gmailClient.readMessage(params.reply_to_id);
          originalInfo = `差出人: ${original.from}\n件名: ${original.subject}\n本文:\n${original.body.slice(0, 500)}`;
        }
        const systemPrompt = `あなたは日本語のビジネスメールを書くアシスタントです。簡潔・丁寧なメール文面を作成してください。署名は不要です。本文のみ出力してください。`;
        const userPrompt = params.body + (originalInfo ? `\n\n--- 返信元メール ---\n${originalInfo}` : '');
        const bodyText = cleanEmailBody(await ai.generateReply(systemPrompt, userPrompt));
        const subject = params.subject || '（件名なし）';
        const draft = await gmailClient.createDraft(params.to, subject, bodyText, params.reply_to_id || null);
        const previewMsg = `以下の内容で下書き保存しました。送信しますか？\n\n─────\n${draft.preview}…\n─────`;
        setPending(session, 'gmail_send', { draftId: draft.draftId });
        session.lastDraftId = draft.draftId;
        session.lastDraftPreview = draft.preview;
        session.lastDraftInfo = { to: params.to, subject: params.subject, replyToId: params.reply_to_id || null };
        await lineClient.replyMessage(replyToken, previewMsg);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `メール下書き作成に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'gmail_send': {
      if (params.draft_id) {
        try {
          await gmailClient.sendDraft(params.draft_id);
          await lineClient.replyMessage(replyToken, '✅ 送信しました');
        } catch (e) {
          await lineClient.replyMessage(replyToken, `送信に失敗しました: ${e.message}`);
        }
      } else {
        await lineClient.replyMessage(replyToken, 'draft_idが指定されていません');
      }
      break;
    }

    case 'gmail_read': {
      try {
        const msg = await gmailClient.readMessage(params.message_id);
        const text = `📧 ${msg.subject}\nFrom: ${msg.from}\n${msg.date}\n\n${msg.body.slice(0, 500)}`;
        await lineClient.replyMessage(replyToken, text);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `メール読み取りに失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_add': {
      try {
        const added = await todo.add(params.title, params.due_date || null, params.priority || 'normal');
        const dueStr = added.due_date ? `\n期限: ${added.due_date.slice(5).replace('-', '/')}` : '';
        await lineClient.replyMessage(replyToken, `✅ TODOに追加しました\n${added.title}${dueStr}`);
        // 追加直後に会話履歴をクリア（タイトルが次の発話に混入するのを防ぐ）
        session.lastMessages = [];
      } catch (e) {
        console.error('[todo_add] error:', e.message);
        await lineClient.replyMessage(replyToken, `TODO追加に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_list': {
      try {
        // 'all' は使わない（完了済みは混ぜない）
        const rawFilter = params.filter || 'pending';
        const filter = rawFilter === 'all' ? 'pending' : rawFilter;
        const items = await todo.list(filter);
        if (filter === 'pending') session.lastTodos = items; // ①番号解決用に保存
        const msg = await todo.formatList(items);
        // 完了済み一覧のヘッダーを変える
        const displayMsg = filter === 'completed'
          ? msg.replace('📋 TODO', '✅ 完了済みTODO')
          : msg;
        await lineClient.replyMessage(replyToken, displayMsg);
      } catch (e) {
        logger.error('dispatcher', 'todo_list error', { error: e.message });
        await lineClient.replyMessage(replyToken, `TODO一覧の取得に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_done': {
      try {
        const result = await todo.complete(params.id);
        await lineClient.replyMessage(replyToken, result.success ? '✅ 完了しました' : '該当するTODOが見つかりません');
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO完了に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_done_by_keyword': {
      // タイトルの一部でTODOを検索して完了にする（「提案書のタスクを完了にして」など）
      const keyword = params.keyword || '';
      if (!keyword) {
        await lineClient.replyMessage(replyToken, 'どのタスクを完了にするか教えてください');
        break;
      }
      try {
        const completed = await todo.completeByKeyword(keyword);
        if (!completed) {
          await lineClient.replyMessage(replyToken,
            `「${keyword}」に該当するタスクが見つかりません。\nTODOリストを確認してください。`);
          break;
        }
        await lineClient.replyMessage(replyToken, `✅ 完了しました\n${completed.title}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO完了に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_done_by_num': {
      // ①②③ 番号指定で完了
      const num = parseInt(params.num) - 1;
      const targetTodo = (session.lastTodos || [])[num];
      if (!targetTodo) {
        await lineClient.replyMessage(replyToken, `${params.num}番のTODOが見つかりません。先にTODO一覧を表示してください`);
        break;
      }
      try {
        await todo.complete(targetTodo.id);
        await lineClient.replyMessage(replyToken, `✅ 完了しました\n${targetTodo.title}`);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `TODO完了に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_delete': {
      setPending(session, 'todo_delete', { id: params.id });
      await lineClient.replyMessage(replyToken, 'このTODOを削除しますか？');
      break;
    }

    case 'todo_delete_by_title': {
      // タイトルの部分一致でTODOを検索して削除（確認ステップあり）
      const rawTitles = (params.titles || []).filter(t => t && t.trim().length > 0);
      // isDeleteAll: 明示的に「全部」系キーワードがある場合のみ全削除
      // （titlesが空でも「全部」キーワードがなければ全削除しない安全設計）
      const isDeleteAll = rawTitles.length === 0 && /全部|全て|すべて|all/i.test(userMessage);
      // 完了済みタスクを削除対象にする場合
      const deleteCompleted = /完了済み|済みタスク|completedタスク/i.test(userMessage);
      const filter = deleteCompleted ? 'completed' : 'pending';

      if (!isDeleteAll && rawTitles.length === 0 && !deleteCompleted) {
        await lineClient.replyMessage(replyToken,
          '削除するタスクを指定してください\n例: 「提案書のTODOを消して」「完了済みタスクを削除して」'
        );
        break;
      }

      try {
        const allTodos = await todo.list(filter);
        const toDelete = isDeleteAll || (deleteCompleted && rawTitles.length === 0)
          ? allTodos
          : allTodos.filter(t =>
              rawTitles.some(target => {
                const coreTitle = t.title.replace(/^【[^】]*】/, '').trim();
                const coreTarget = target.replace(/^【[^】]*】/, '').trim();
                if (!coreTarget) return false;
                return t.title.includes(target) ||
                  coreTitle.includes(coreTarget) ||
                  coreTarget.includes(coreTitle);
              })
            );

        if (!toDelete.length) {
          await lineClient.replyMessage(replyToken,
            `該当するTODOが見つかりませんでした\n検索ワード: ${rawTitles.join('、') || '(全件)'}`
          );
          break;
        }

        const previewList = toDelete.map(t => `・${t.title}`).join('\n');
        setPending(session, 'todo_delete_by_title', { toDelete });
        await lineClient.replyMessage(replyToken,
          `以下の${toDelete.length}件のTODOを削除しますか？\n━━━━━━━━━━\n${previewList}`
        );
      } catch (e) {
        logger.error('dispatcher', 'todo_delete_by_title error', { error: e.message });
        await lineClient.replyMessage(replyToken, `TODO削除に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_setup_recurring': {
      // 複数TODO一括登録 + 毎月繰り返しカレンダーリマインダー作成
      try {
        const todos = params.todos || [];
        const addedTitles = [];
        for (const item of todos) {
          const added = await todo.add(item.title, item.due_date || null, item.priority || 'normal');
          addedTitles.push(added.title);
        }

        let calMsg = '';
        if (params.reminder_rrule) {
          // 次の第N曜日を計算してリマインダーを作成
          const startDate = calcNextRruleDate(params.reminder_rrule);
          await calendarClient.addRecurringEvent(
            params.reminder_title || '毎月定例リマインド',
            params.reminder_rrule,
            startDate,
            '09:00',
            '09:30',
            params.reminder_description || addedTitles.join('\n')
          );
          calMsg = `\n\n📅 カレンダーに毎月の繰り返しリマインドを登録しました\n「${params.reminder_title || '毎月定例リマインド'}」`;
        }

        const todoList = addedTitles.map((t, i) => `${i+1}. ${t}`).join('\n');
        await lineClient.replyMessage(replyToken,
          `✅ ${addedTitles.length}件のTODOを登録しました\n━━━━━━━━━━\n${todoList}${calMsg}`
        );
      } catch (e) {
        logger.error('dispatcher', 'todo_setup_recurring error', { error: e.message });
        await lineClient.replyMessage(replyToken, `TODO登録に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_add_recurring': {
      // 繰り返しカレンダーイベントの作成
      try {
        const startDate = params.start_date || calcNextRruleDate(params.rrule || 'FREQ=MONTHLY;BYDAY=2FR');
        const result = await calendarClient.addRecurringEvent(
          params.title,
          params.rrule,
          startDate,
          params.start_time || '09:00',
          params.end_time || '09:30',
          params.description || ''
        );
        await lineClient.replyMessage(replyToken,
          `✅ 毎月の繰り返しリマインドを登録しました\n📅 ${result.event.title}\n（${formatRrule(params.rrule)}）`
        );
      } catch (e) {
        await lineClient.replyMessage(replyToken, `カレンダー登録に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'calendar_add_multi': {
      // 複数予定を一括追加（確認ステップなしで連続追加）
      const events = params.events || [];
      if (!events.length) {
        await lineClient.replyMessage(replyToken, '追加する予定が指定されていません');
        break;
      }
      try {
        const added = [];
        const failed = [];
        for (const ev of events) {
          try {
            await calendarClient.addEventForce(ev.title, ev.start, ev.end, ev.description || '');
            added.push(`・${ev.title} ${formatEventLabel({ start: ev.start, end: ev.end })}`);
          } catch (err) {
            failed.push(`・${ev.title}（失敗: ${err.message}）`);
          }
        }
        let msg = `✅ ${added.length}件の予定を追加しました\n${added.join('\n')}`;
        if (failed.length) msg += `\n\n⚠️ 失敗した予定:\n${failed.join('\n')}`;
        await lineClient.replyMessage(replyToken, msg);
      } catch (e) {
        await lineClient.replyMessage(replyToken, `予定の追加に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'todo_note': {
      // タスクにメモ/覚書を追加（todo.addNote() に委譲して認証重複を解消）
      try {
        const keyword = params.keyword || '';
        const note = params.note || '';
        if (!note) {
          await lineClient.replyMessage(replyToken, 'メモの内容を指定してください');
          break;
        }
        const target = await todo.addNote(keyword, note);
        if (!target) {
          await lineClient.replyMessage(replyToken,
            `「${keyword}」に該当するタスクが見つかりません。\nTODO一覧を確認してください。`);
          break;
        }
        await lineClient.replyMessage(replyToken, `📝 メモを追加しました\n${target.title}\n\n「${note}」`);
      } catch (e) {
        logger.error('dispatcher', 'todo_note error', { error: e.message });
        await lineClient.replyMessage(replyToken, `メモの追加に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'briefing': {
      // replyTokenは30秒で失効するため、まず受付返答してからpushで送信
      await lineClient.replyMessage(replyToken, '📋 ブリーフィングを生成中です…');
      try {
        const messages = await briefing.generateMorning();
        await lineClient.pushMessages(messages);
      } catch (e) {
        await lineClient.pushMessage(`ブリーフィング生成に失敗しました: ${e.message}`);
      }
      break;
    }

    case 'consult': {
      // 相談モード：秘書の記憶を背景に自然文で回答
      const answer = await ai.consult(userMessage, {
        secretaryContext: getSecretaryContext(),
        recentMessages: (session.lastMessages || []).slice(0, -1), // 末尾=今の発話は consult 内で付与するので除く
      });
      await lineClient.replyMessage(replyToken,
        answer || reply || 'すみません、うまく言葉が出てきませんでした。もう一度お願いできますか？');
      break;
    }

    case 'unknown':
    default: {
      // 操作意図が無い発話は相談モードで拾う（記憶があれば秘書として回答）
      const answer = await ai.consult(userMessage, {
        secretaryContext: getSecretaryContext(),
        recentMessages: (session.lastMessages || []).slice(0, -1),
      });
      const helpText = reply || UNKNOWN_REPLIES[Math.floor(Math.random() * UNKNOWN_REPLIES.length)];
      await lineClient.replyMessage(replyToken, answer || helpText);
    }
  }
}

module.exports = { dispatch };
