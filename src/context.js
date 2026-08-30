require('dotenv').config();
const fs = require('fs');
const path = require('path');
const logger = require('./lib/logger');

// 相談モード用の「秘書の記憶（業務ブリーフ）」を取得する。
// 機微情報を含むためGitHubには載せない。優先順位:
//   1) 環境変数 SECRETARY_CONTEXT（本番=Renderのシークレットで注入）
//   2) ローカル開発用ファイル context/secretary.local.md（.gitignore済み）
// どちらも無ければ空文字（相談モードは「記憶未設定」として一般回答にフォールバック）。
let cached;

function loadSecretaryContext() {
  // 1) 環境変数（本番）
  const fromEnv = process.env.SECRETARY_CONTEXT;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  // 2) ローカルファイル（開発用）
  try {
    const p = path.join(__dirname, '..', 'context', 'secretary.local.md');
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) return text;
    }
  } catch (err) {
    logger.warn('context', 'ローカル文脈の読み込みに失敗', { error: err.message });
  }
  return '';
}

function getSecretaryContext() {
  if (cached === undefined) {
    cached = loadSecretaryContext();
    logger.info('context', '秘書の記憶を読み込み', {
      source: process.env.SECRETARY_CONTEXT ? 'env' : (cached ? 'file' : 'none'),
      chars: cached.length,
    });
  }
  return cached;
}

module.exports = { getSecretaryContext };
