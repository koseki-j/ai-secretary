require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./lib/logger');

if (!process.env.ANTHROPIC_API_KEY) {
  logger.warn('ai', 'ANTHROPIC_API_KEY が未設定です。AI機能は利用できません。');
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

const WEEKDAY_JA = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

function padZ(n) { return String(n).padStart(2, '0'); }
function jstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}
function toJstIso(d) {
  return `${d.getFullYear()}-${padZ(d.getMonth()+1)}-${padZ(d.getDate())}T${padZ(d.getHours())}:${padZ(d.getMinutes())}:00+09:00`;
}
function toDateStr(d) {
  return `${d.getFullYear()}-${padZ(d.getMonth()+1)}-${padZ(d.getDate())}`;
}
function getMondayOfWeek(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  return mon;
}
function nextWeekdayFrom(base, targetDow) {
  const d = new Date(base);
  let diff = targetDow - d.getDay();
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return toDateStr(d);
}

const FALLBACK = {
  actions: [{ action: 'unknown', params: {}, needs_confirm: false }],
  reply: 'すみません、もう一度おっしゃっていただけますか？',
  ambiguous: false,
  ambiguous_question: '',
};

function withTimeout(promise, ms, errorMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
  ]);
}

function parseApiResponse(text) {
  // マークダウンコードブロックを除去
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // 前後に説明文が混入してもJSONだけ抽出
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) text = jsonMatch[0].trim();
  logger.debug('ai', 'parseIntent raw', { text: text.slice(0, 400) });
  const parsed = JSON.parse(text);

  // 旧フォーマット互換（action が直接ある場合）
  if (!Array.isArray(parsed.actions) && parsed.action) {
    parsed.actions = [{
      action: parsed.action,
      params: parsed.params || {},
      needs_confirm: !!parsed.needs_confirm,
    }];
  }
  if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    parsed.actions = [{ action: 'unknown', params: {}, needs_confirm: false }];
  }

  return {
    actions:            parsed.actions,
    reply:              parsed.reply              || '',
    ambiguous:          !!parsed.ambiguous,
    ambiguous_question: parsed.ambiguous_question || '',
  };
}

async function parseIntent(userMessage, context = {}) {
  const {
    recentMessages = [],
    pendingAction = null,
    lastMentionedEmails = [],
    lastMentionedEvents = [],
  } = context;

  // ── 日付計算（リアルタイム）────────────────────────────
  const now = jstNow();
  const nowIso    = toJstIso(now);
  const todayStr  = toDateStr(now);
  const dowIdx    = now.getDay(); // 0=日〜6=土
  const dowFull   = WEEKDAY_JA[dowIdx];

  const thisMonday = getMondayOfWeek(now);
  const thisMondayStr = toDateStr(thisMonday);

  const nextMonday = new Date(thisMonday); nextMonday.setDate(thisMonday.getDate() + 7);
  const nextMondayStr = toDateStr(nextMonday);

  const weekAfterNext = new Date(thisMonday); weekAfterNext.setDate(thisMonday.getDate() + 14);
  const weekAfterNextStr = toDateStr(weekAfterNext);

  const tomorrow  = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const dayAfter  = new Date(now); dayAfter.setDate(now.getDate() + 2);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const dayBefore = new Date(now); dayBefore.setDate(now.getDate() - 2);

  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const lastDayStr = toDateStr(lastDay);
  const daysLeftInMonth = lastDay.getDate() - now.getDate() + 1;

  const nextMonth1 = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonthStr = toDateStr(nextMonth1);

  // 直近の各曜日
  const wd = {
    日: nextWeekdayFrom(now, 0), 月: nextWeekdayFrom(now, 1), 火: nextWeekdayFrom(now, 2),
    水: nextWeekdayFrom(now, 3), 木: nextWeekdayFrom(now, 4), 金: nextWeekdayFrom(now, 5),
    土: nextWeekdayFrom(now, 6),
  };

  // ── コンテキスト情報 ────────────────────────────────────
  let ctxSection = '';
  if (lastMentionedEmails.length > 0) {
    const list = lastMentionedEmails.slice(0, 3)
      .map((e, i) => `  ${i+1}. id="${e.id}" from="${e.from}" subject="${e.subject}"`)
      .join('\n');
    ctxSection += `\n### 直前に表示したメール（返信時に reply_to_id に使用）\n${list}\n`;
  }
  if (lastMentionedEvents.length > 0) {
    const list = lastMentionedEvents.slice(0, 3)
      .map((e, i) => `  ${i+1}. title="${e.title}" start="${(e.start||'').slice(0,16)}"`)
      .join('\n');
    ctxSection += `\n### 直前に表示した予定（変更・削除時に keyword に使用）\n${list}\n`;
  }

  // ── システムプロンプト ───────────────────────────────────
  const systemPrompt = `あなたはAI秘書の自然言語解析エンジンです。ユーザーの口語・あいまい表現を解析し、必ず以下のJSON形式【のみ】で応答してください。マークダウンコードブロック・説明文は一切出力禁止。

現在日時(JST): ${nowIso}
今日の曜日: ${dowFull}（インデックス ${dowIdx}、0=日 1=月 2=火 3=水 4=木 5=金 6=土）
${ctxSection}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## レスポンスJSON形式

{
  "actions": [
    { "action": "アクション名", "params": {}, "needs_confirm": false }
  ],
  "reply": "ユーザーへの一言返答（日本語・簡潔に）",
  "ambiguous": false,
  "ambiguous_question": ""
}

- actions: 配列。通常1要素。「予定もTODOも教えて」など複合指示は複数要素
- ambiguous: 意図が判断不能な場合 true
- ambiguous_question: ambiguous=true の時のみ、次に何を聞けば判断できるかを記載

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 利用可能アクション

action                | 主なparams
----------------------|------------------------------------------------------------
calendar_list         | date:"YYYY-MM-DD", range_days:1〜30
calendar_add          | title, start:"YYYY-MM-DDTHH:mm:ss+09:00", end:"...", description, location(ZoomリンクやURL)
calendar_add_multi    | events:[{title,start,end,description}]
calendar_update       | keyword, date(省略可), new_title, new_start, new_end
calendar_delete       | keyword, date(省略可)
calendar_check        | date:"YYYY-MM-DD"（その日の空き状況確認）
calendar_add_recurring| title, rrule, start_date, start_time, end_time, description
gmail_list            | max:5, query:""
gmail_draft           | to, subject, body, reply_to_id
gmail_send            | draft_id
gmail_read            | message_id
todo_add              | title, due_date:"YYYY-MM-DD or null", priority:"high|normal|low"
todo_list             | filter:"all|today|pending|completed"
todo_done_by_keyword  | keyword
todo_done_by_num      | num:1
todo_delete_by_title  | titles:[]
todo_note             | keyword, note
todo_setup_recurring  | todos:[], reminder_title, reminder_rrule, reminder_description
briefing              | {}
consult               | {}（予定/メール/TODOのどれにも当てはまらない業務相談・質問・意見だし・雑談。会長の焼肉/不動産の相談はこれ）
unknown               | {}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 日時変換（計算済み — 必ずこの値を使うこと）

| 表現              | 日付/値                                      |
|-------------------|----------------------------------------------|
| 今日              | ${todayStr}                                  |
| 明日              | ${toDateStr(tomorrow)}                       |
| 明後日            | ${toDateStr(dayAfter)}                       |
| 昨日              | ${toDateStr(yesterday)}                      |
| 一昨日            | ${toDateStr(dayBefore)}                      |
| 今週（月〜日）    | date:${thisMondayStr}, range_days:7          |
| 来週              | date:${nextMondayStr}, range_days:7          |
| 再来週            | date:${weekAfterNextStr}, range_days:7       |
| 今月残り          | date:${todayStr}, range_days:${daysLeftInMonth} |
| 来月              | date:${nextMonthStr}, range_days:30          |
| 月末              | ${lastDayStr}                                |
| 直近の月曜        | ${wd['月']}                                  |
| 直近の火曜        | ${wd['火']}                                  |
| 直近の水曜        | ${wd['水']}                                  |
| 直近の木曜        | ${wd['木']}                                  |
| 直近の金曜        | ${wd['金']}                                  |
| 直近の土曜        | ${wd['土']}                                  |
| 直近の日曜        | ${wd['日']}                                  |
| 今週の月曜        | ${thisMondayStr}                             |
| 今週の金曜        | ${wd['金']}（今週内）                        |
| 来週の月曜        | ${nextMondayStr}                             |

### 時刻変換
| 表現           | 時刻  |
|----------------|-------|
| 朝一・朝イチ   | 09:00 |
| 午前中         | 10:00 |
| 昼・ランチ     | 12:00 |
| 午後（指定なし）| 13:00|
| 夕方           | 17:00 |
| 夜             | 19:00 |
| 夜遅く         | 21:00 |
| X時            | X:00（ビジネス時間外かつ曖昧な場合は午後として解釈）|
| X時半          | X:30  |
| X時Y分         | X:Y   |
| X分後          | 現在時刻+X分 |
| 1時間後        | 現在時刻+60分 |

### デフォルト期間
- calendar_add: end が未指定 → start + 1時間
- リマインダー: end → start + 30分

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## あいまい表現 → action マッピング

### カレンダー系
| ユーザー表現の例                          | action          | 主なparams                           |
|-------------------------------------------|-----------------|--------------------------------------|
| 今週どんな感じ？詰まってる？ヤバい？      | calendar_list   | date:${thisMondayStr}, range_days:7  |
| 来週ヤバい？忙しい？詰まってる？          | calendar_list   | date:${nextMondayStr}, range_days:7  |
| 明後日空いてる？フリー？                  | calendar_check  | date:${toDateStr(dayAfter)}          |
| 木曜何か入ってる？あったっけ？            | calendar_list   | date:${wd['木']}, range_days:1       |
| 田中さんとMTG、水曜15時でどう？          | calendar_add    | 重複確認あり                         |
| スケジュール入れて\nイタンジMTG\n4/4 11:30-12:30\nhttps://zoom.us/j/xxx | calendar_add | title:"イタンジMTG", start:"${todayStr.slice(0,4)}-04-04T11:30:00+09:00", end:"${todayStr.slice(0,4)}-04-04T12:30:00+09:00", location:"https://zoom.us/j/xxx" |
| 予定追加\nオンライン面談 5/10 15:00-16:00\nZoom: https://zoom.us/j/yyy | calendar_add | title:"オンライン面談", start:"...", end:"...", location:"https://zoom.us/j/yyy" |
| 来週月曜の件、30分早めて                  | calendar_update | keyword:文脈から, new_start:計算     |
| 今日のランチのやつキャンセル              | calendar_delete | keyword:ランチ, date:${todayStr}     |
| 今月あと何日空いてる？                    | calendar_list   | date:${todayStr}, range_days:${daysLeftInMonth} |
| 朝一で何がある？何があるんだっけ          | calendar_list   | date:${todayStr}, range_days:1       |
| 今日の最初の予定                          | calendar_list   | date:${todayStr}, range_days:1       |

### メール系
| ユーザー表現の例                          | action          | 主なparams                           |
|-------------------------------------------|-----------------|--------------------------------------|
| 未読たまってる？来てない？                | gmail_list      | max:5, query:"in:inbox is:unread"    |
| 山田さんからメール来てない？              | gmail_list      | query:"from:山田 in:inbox"           |
| 最近来た重要そうなメール                  | gmail_list      | max:5, query:"in:inbox is:unread"    |
| さっきのメールに了承って返しといて        | gmail_draft     | reply_to_id:直前メールのid, body:了承の旨 |
| 来週水曜の件は対応可と伝えて              | gmail_draft     | reply_to_id:文脈から, body:対応可の旨 |
| 前向きに検討しますと丁寧に断っておいて    | gmail_draft     | body:婉曲的にお断りの旨              |

### TODO系
| ユーザー表現の例                          | action              | 主なparams                           |
|-------------------------------------------|---------------------|--------------------------------------|
| あとで提案書作らないと                    | todo_add            | title:"提案書作成"                   |
| 田中さんへの電話忘れないようにしといて    | todo_add            | title:"田中さんへ電話"               |
| 今日中にやること一覧                      | todo_list           | filter:"today"                       |
| 提案書のやつ終わった                      | todo_done_by_keyword| keyword:"提案書"                     |
| もう全部終わったっけ？                    | todo_list           | filter:"pending"                     |
| 明日締め切りのやつある？                  | todo_list           | filter:"pending"                     |

### 複合・総合系
| ユーザー表現の例                          | actions                                        |
|-------------------------------------------|------------------------------------------------|
| 今日の予定とTODOまとめて教えて            | [calendar_list(今日), todo_list(today)]        |
| 今日どんな感じ？今日のまとめ              | briefing                                       |
| 今週ヤバそう？忙しい？                    | calendar_list(今週)                            |
| 朝一で何があるんだっけ                    | calendar_list(今日)                            |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 文脈の引き継ぎ

${lastMentionedEmails.length > 0
  ? `「さっきのメール」「直近のメール」「そのメール」「それ」→ reply_to_id: "${lastMentionedEmails[0]?.id || ''}"（直前メール1件目のid）`
  : '（直前のメールなし）'}
${lastMentionedEvents.length > 0
  ? `「さっきの予定」「その予定」「それ」→ keyword: "${lastMentionedEvents[0]?.title || ''}"（直前予定1件目のタイトル）`
  : '（直前の予定なし）'}

指示語（「それ」「その件」「あれ」「さっきの」）は必ず上記コンテキストから解決すること。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## ambiguous（判断不能）の処理

ただし ambiguous は「予定・メール・TODOのどの操作か」が絞れない場合に限る。**予定・メール・TODOの操作ではなく、業務の相談・質問・意見だし・雑談（例：「10月の価格改定どう思う？」「原価率どう改善する？」「あけぼのの融資どうだっけ」「今日調子でないな」）は ambiguous でも unknown でもなく action:"consult" を返すこと**（reply は空でよい。consultハンドラが本文を生成する）。

**【consultは必ず単独】** consult は他のアクションと同じ actions 配列に絶対に混ぜない。1つの発話は「操作（calendar/todo/gmail）」か「相談（consult）」のどちらか一方に分類する。会話履歴に過去の予定追加などが残っていても、**今回の発話が相談・質問なら consult 単独**を返し、履歴の予定を calendar_add で蒸し返さないこと。逆に今回が予定追加なら calendar_add 単独（consultを足さない）。

操作系で、どの操作か特定できない場合のみ unknown でなく ambiguous:true にして、何を聞けば判断できるかを ambiguous_question に記載すること。

例:
- 「田中さんの件どうする？」→ { ambiguous:true, ambiguous_question:"田中さんの件というのは、予定・メール・TODOのどれでしょうか？" }
- 「明日の午後って」（動詞なし）→ { ambiguous:true, ambiguous_question:"明日の午後について、予定の確認ですか？それとも何か追加しますか？" }
- 「あの件ってどうなった？」→ { ambiguous:true, ambiguous_question:"「あの件」というのは、どの件でしょうか？" }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 絶対ルール（違反禁止）

【最重要A】明示的依頼の原則:
- **今回のユーザー発話に含まれていない固有名詞・イベント名・日時は絶対にアクションに使用しない**
- 直前の会話履歴・通知・システムメッセージの内容を「ユーザーの依頼」として扱わない
- 「〇〇をTodoいれて」→ todo_add のみ。カレンダーは絶対に実行しない
- 「〇〇をカレンダーに入れて」→ calendar_add のみ。TODOは絶対に実行しない
- 複数アクションは、現在の発話でユーザーが**両方を明示した場合のみ**実行する

【最重要B】todo_add のタイトル抽出ルール:
- title は**必ず現在のユーザー発話の文字列から**抽出すること
- 会話履歴に出てきた過去のtodoタイトルを流用・再利用することは絶対禁止
- 「〇〇をtodoに入れて」→ title = "〇〇"（発話中の〇〇をそのまま使う）
- 「〇〇」がなく動詞だけの場合 → ambiguous にして「何をTODOに追加しますか？」と確認

【最重要C】曖昧な発話の扱い:
- todo/カレンダー/メールのどのアクションか判断できない発話（トリガーワードがない）→ ambiguous: true
- 「〇〇に入力」「〇〇を確認」のみで動詞が不明 → ambiguous にして「TODOに追加しますか？それとも別の操作ですか？」と確認
- ただし「〇〇をtodoに入れて」のようにtodoが明示されている場合は確認不要でtodo_add

1. 「未読」「メール来てない？」「たまってる？」 → gmail_list（calendar系にしない）
2. 「TODO」「タスク」「やること」「忘れないようにしといて」「あとで〜しないと」→ todo系
3. 「予定」「MTG」「ミーティング」「アポ」「スケジュール」「リマインダー」 → calendar系
4. todo_done（id指定）は絶対に使わない。必ず todo_done_by_keyword を使うこと
5. 「キャンセル」「なかったことに」「削除」（カレンダー文脈） → calendar_delete
6. 独立した複数操作 → actions に複数要素（ただし最重要ルールを必ず守ること）
7. reply は日本語・1〜2文・簡潔に
8. 「〇〇を早めて/遅らせて」→ calendar_update（new_start を計算）
9. 「〇〇分早めて」で元の予定時刻が不明なら ambiguous にして確認
10. calendar_add_multi: 「月曜と火曜に別々の予定」など複数の異なる日時への追加
11. 「🔴[高]」「🟡[中]」「🟢[低]」ラベルを含む行 → TODO一覧のコピペ。「消して」「削除」が伴う場合は必ず todo_delete_by_title（calendar系に絶対しない）
12. 「これ消して」「↑消して」など指示語のみ + TODOフォーマット行 → todo_delete_by_title。titles に各行のタイトル部分を入れること
13. 「TODOに追加してカレンダーにも反映」「TODOとカレンダー両方に入れて」→ actions に todo_setup_recurring + calendar_add_multi の両方を返すこと（両方の明示が必須）
14. calendar_add で長文メッセージ（招待メール転送など）が来た場合：
    - 1行目の「スケジュール入れて」「予定入れて」「カレンダーに追加」はトリガーワード（無視してよい）
    - 最初に現れる名詞句をイベントタイトルとして抽出
    - 「M/D（曜）HH:MM-HH:MM」形式の日時を抽出して JST の ISO 文字列に変換
    - https:// から始まるURLがあれば location フィールドに設定（Zoomリンク等）
    - 残りの説明文は description フィールドに設定
    例: 「明日のTODOで月次レポート・経費精算を入れて、カレンダーにも10:00-10:30で反映して」
    → actions: [
        {action:"todo_setup_recurring", params:{todos:[{title:"月次レポート",due_date:"YYYY-MM-DD"},{title:"経費精算",due_date:"YYYY-MM-DD"}]}},
        {action:"calendar_add_multi", params:{events:[{title:"月次レポート",start:"YYYY-MM-DDT10:00:00+09:00",end:"YYYY-MM-DDT10:30:00+09:00"},{title:"経費精算",start:"YYYY-MM-DDT10:00:00+09:00",end:"YYYY-MM-DDT10:30:00+09:00"}]}}
      ]`;

  // メッセージ履歴（最大2往復 = 4件）古い文脈の混入を防ぐ
  const messages = [];
  for (const m of recentMessages.slice(-4)) {
    messages.push(m);
  }
  messages.push({ role: 'user', content: userMessage });

  try {
    const response = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: 1200,
        system: systemPrompt,
        messages,
      }),
      30000,
      'Claude API タイムアウト（30秒）'
    );

    const text = response?.content?.[0]?.text?.trim() || '';
    return parseApiResponse(text);
  } catch (err) {
    logger.error('ai', 'parseIntent error', { error: err.message });

    // Handle rate limit with retry
    if (err?.status === 429) {
      logger.warn('ai', 'レート制限。60秒待ってリトライ');
      await new Promise(r => setTimeout(r, 60000));
      try {
        const retryResponse = await withTimeout(
          client.messages.create({
            model: MODEL,
            max_tokens: 1200,
            system: systemPrompt,
            messages,
          }),
          30000,
          'Claude API タイムアウト（リトライ）'
        );
        const retryText = retryResponse?.content?.[0]?.text?.trim() || '';
        return parseApiResponse(retryText);
      } catch (retryErr) {
        logger.error('ai', 'リトライも失敗', { error: retryErr.message });
      }
    }

    // Always return FALLBACK, never throw
    const replyMsg = err.message.includes('タイムアウト')
      ? '少し時間をおいてから再度お試しください'
      : 'すみません、もう少し時間をおいてお試しください';
    return { ...FALLBACK, reply: replyMsg };
  }
}

// ────────────────────────────────────────────────────────────
// 相談モード：予定/メール/TODO以外の業務相談・質問・雑談に、
// 「秘書の記憶（業務ブリーフ）」を背景に持って自然文で答える。
// ────────────────────────────────────────────────────────────
async function consult(userMessage, options = {}) {
  const { secretaryContext = '', recentMessages = [] } = options;
  const now = jstNow();
  const dowFull = WEEKDAY_JA[now.getDay()];

  const memorySection = secretaryContext
    ? `## あなたが持っている記憶・前提（会長の事業状況）\n${secretaryContext}`
    : `（記憶がまだ設定されていません。その場合はその旨を一言添え、一般的な範囲で丁寧に答えてください）`;

  const systemPrompt = `あなたは小関淳さん（本人の希望で「会長」と呼ぶ）の専属AI秘書です。会長は山形で焼肉店（王様の焼肉／大衆焼肉けむすけ）を経営し、不動産賃貸も手掛ける大家です。あなたの背後にはCFO兼経営企画・不動産財務・命術/養生顧問のチームがいる想定で、窓口としてまとめて答えます。

現在日時(JST): ${toDateStr(now)}（${dowFull}）

## 応答スタイル
- LINEでのやり取りなので簡潔・実務的に。必要なら箇条書き。長くなりすぎない。
- 参謀であって決裁者ではない。判断材料と選択肢を示し、最終判断は会長に委ねる。
- 数字は目的の手段。可能なら「この一手が守りたい人・時間にどう効くか」も一言添える。
- 税務の確定判断はしない（顧問税理士の領分）。分からないこと・最新の数字が要ることは断定せず、「PCの資料で確認しましょう」等と正直に促す。
- あなたはLINE上の秘書で、PC内のファイルやGoogleドライブの中身はまだ直接読めない。資料本体が要る質問はその旨を伝える。

${memorySection}`;

  const messages = [];
  for (const m of recentMessages.slice(-4)) messages.push(m);
  messages.push({ role: 'user', content: userMessage });

  try {
    const response = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: 1200,
        system: systemPrompt,
        messages,
      }),
      30000,
      'Claude API タイムアウト（30秒）'
    );
    return response?.content?.[0]?.text?.trim() || '';
  } catch (err) {
    logger.error('ai', 'consult error', { error: err.message });
    return '';
  }
}

async function generateReply(systemPrompt, userMessage) {
  try {
    const response = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      30000,
      'Claude API タイムアウト（30秒）'
    );
    return response?.content?.[0]?.text?.trim() || '';
  } catch (err) {
    logger.error('ai', 'generateReply error', { error: err.message });
    throw err;
  }
}

module.exports = { parseIntent, generateReply, consult };

// ────────────────────────────────────────────────────────────
// テスト実行: node src/ai.js
// ────────────────────────────────────────────────────────────
if (require.main === module) {
  const testCases = [
    '今週どんな感じ？',
    '明後日空いてる？',
    '来週月曜の14時に田中さんとMTG入れて',
    '未読たまってる？',
    'さっきのメールに了承って返しといて',
    '提案書作るの忘れないようにしといて、期限明日',
    '今日の予定とTODOまとめて教えて',
    '田中さんの件どうする？',
    '朝一で何があるんだっけ',
  ];

  (async () => {
    console.log('=== 自然言語理解テスト ===\n');
    for (const msg of testCases) {
      const result = await parseIntent(msg, {});
      console.log(`入力: 「${msg}」`);
      console.log(`→ actions: ${result.actions.map(a => a.action).join(', ')}`);
      if (result.ambiguous) {
        console.log(`→ 確認質問: ${result.ambiguous_question}`);
      } else {
        const p = result.actions[0]?.params || {};
        const pStr = Object.entries(p).slice(0,3).map(([k,v]) => `${k}:${JSON.stringify(v)}`).join(', ');
        if (pStr) console.log(`→ params: ${pStr}`);
      }
      console.log(`→ 返答: ${result.reply}\n`);
    }
    process.exit(0);
  })();
}
