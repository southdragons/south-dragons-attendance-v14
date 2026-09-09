/** South Dragons_J.B.C. 出欠管理 — spreadsheet-bound Apps Script (V8). */
var SD_SHEET_CACHE = {};
var SD_SCHEMA = {
  players: ['player_id', 'name', 'active', 'joined_at', 'retired_at'],
  events: ['event_id', 'date', 'title', 'start_time', 'end_time', 'location', 'note', 'created_by_name', 'created_at', 'updated_at', 'active'],
  attendance: ['event_id', 'player_id', 'status', 'comment', 'updated_at'],
  settings: ['key', 'value']
};

/** Run once from the editor attached to your new spreadsheet. Safe to rerun. */
function setupSouthDragons() {
  SD_SHEET_CACHE = {};
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('対象スプレッドシートの「拡張機能 → Apps Script」から実行してください。');
    Object.keys(SD_SCHEMA).forEach(function(name) {
      var sheet = ss.getSheetByName(name);
      if (sheet && sheet.getLastRow()) checkHeaders_(sheet, name);
    });
    var props = PropertiesService.getScriptProperties();
    var savedId = props.getProperty('SPREADSHEET_ID');
    if (savedId && savedId !== ss.getId()) throw new Error('別のスプレッドシートがすでに設定されています。');
    Object.keys(SD_SCHEMA).forEach(function(name) {
      var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
      if (!sheet.getLastRow()) sheet.getRange(1, 1, 1, SD_SCHEMA[name].length).setValues([SD_SCHEMA[name]]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, SD_SCHEMA[name].length).setBackground('#174d36').setFontColor('#ffffff').setFontWeight('bold');
    });
    ss.setSpreadsheetTimeZone('Asia/Tokyo');
    props.setProperty('SPREADSHEET_ID', ss.getId());
    if (!props.getProperty('API_KEY')) props.setProperty('API_KEY', randomToken_());
    if (!setting_('admin_password_hash') && !props.getProperty('ADMIN_SETUP_CODE')) props.setProperty('ADMIN_SETUP_CODE', randomToken_());
    if (!setting_('team_name')) setSetting_('team_name', 'South Dragons_J.B.C.');
    if (!setting_('late_label')) setSetting_('late_label', '10時参加');
    if (!setting_('line_notify')) setSetting_('line_notify', 'FALSE');
    SpreadsheetApp.flush();
    // Never print API keys, setup codes, password hashes, or session tokens.
    console.log('4シートを準備しました。API_KEYとADMIN_SETUP_CODEはプロジェクトの設定 → スクリプト プロパティで確認してください。');
  } finally { lock.releaseLock(); }
}

function doGet() { return json_({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Nuxtアプリ経由でアクセスしてください。' } }); }
function doPost(e) {
  SD_SHEET_CACHE = {};
  var lock;
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 16000) fail_('BAD_REQUEST', 'リクエストの形式が正しくありません。');
    var request;
    try { request = JSON.parse(raw); } catch (_) { fail_('BAD_REQUEST', 'JSONの形式が正しくありません。'); }
    var apiKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!apiKey || !request || !secureEqual_(request.apiKey, apiKey)) fail_('FORBIDDEN', '接続を認証できませんでした。');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) fail_('BUSY', 'ほかの操作を保存中です。少し待ってから再試行してください。');
    var result = dispatch_(request.action, request.payload || {}, request.adminToken || '');
    SpreadsheetApp.flush();
    return json_({ ok: true, data: result });
  } catch (error) {
    return json_({ ok: false, error: { code: error.sdCode || 'INTERNAL', message: error.sdCode ? error.message : '保存先の処理に失敗しました。シートの設定を確認してください。' } });
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}
function dispatch_(action, p, token) {
  if (action === 'getAuthConfig') { var auth = credential_(); return { salt: auth ? auth.salt : '', configured: !!auth }; }
  if (action === 'initializeAdmin') {
    if (setting_('admin_password_hash')) fail_('CONFLICT', '管理パスワードは設定済みです。');
    var props = PropertiesService.getScriptProperties();
    checkRate_();
    if (!props.getProperty('ADMIN_SETUP_CODE') || !secureEqual_(p.setupCode, props.getProperty('ADMIN_SETUP_CODE'))) fail_('UNAUTHORIZED', '初期設定コードが違います。');
    validateCredential_(p);
    saveCredential_(p.salt, p.proof);
    props.deleteProperty('ADMIN_SETUP_CODE'); props.deleteProperty('AUTH_ATTEMPTS');
    return { token: newSession_() };
  }
  if (action === 'adminLogin') {
    checkRate_();
    if (!setting_('admin_password_hash') || !secureEqual_(p.proof, (credential_() || {}).hash)) fail_('UNAUTHORIZED', '管理パスワードが違います。');
    PropertiesService.getScriptProperties().deleteProperty('AUTH_ATTEMPTS');
    return { token: newSession_() };
  }
  if (action === 'adminLogout') {
    if (token) PropertiesService.getScriptProperties().deleteProperty(sessionKey_(token));
    return { loggedOut: true };
  }
  if (action === 'getData') return snapshot_(token ? requireAdmin_(token) : false);
  if (action === 'registerPlayer') {
    var registrationAdmin = token ? requireAdmin_(token) : false;
    var name = text_(p.name, 30, true), key = normalizeName_(name);
    if (!key) fail_('BAD_REQUEST', '名前を入力してください。');
    var existing = rows_('players').find(function(row) { return normalizeName_(row.name) === key; });
    if (existing) return { duplicate: true, player: player_(existing), snapshot: snapshot_(registrationAdmin) };
    var row = { player_id: Utilities.getUuid(), name: name, active: 'TRUE', joined_at: now_(), retired_at: '' };
    append_('players', row);
    return { duplicate: false, player: player_(row), snapshot: snapshot_(registrationAdmin) };
  }
  if (action === 'saveAttendance') {
    var attendanceAdmin = token ? requireAdmin_(token) : false;
    var player = find_('players', 'player_id', p.playerId), event = find_('events', 'event_id', p.eventId);
    if (!truth_(player.active) || !truth_(event.active)) fail_('CONFLICT', 'この選手または予定は現在入力できません。');
    if (event.date < today_()) fail_('BAD_REQUEST', '過去の出欠は変更できません。');
    if (p.status !== null && ['attend', 'late', 'absent'].indexOf(p.status) < 0) fail_('BAD_REQUEST', '出欠の区分が正しくありません。');
    var answers = rows_('attendance').filter(function(a) { return a.event_id === event.event_id && a.player_id === player.player_id; });
    if (p.status === null) {
      answers.sort(function(a, b) { return b._row - a._row; }).forEach(function(a) { sheet_('attendance').deleteRow(a._row); });
    } else {
      var answer = { event_id: event.event_id, player_id: player.player_id, status: p.status, comment: answers[0] ? answers[0].comment : '', updated_at: now_() };
      if (answers.length) {
        write_('attendance', answers[0]._row, answer);
        answers.slice(1).sort(function(a, b) { return b._row - a._row; }).forEach(function(a) { sheet_('attendance').deleteRow(a._row); });
      } else append_('attendance', answer);
    }
    return { snapshot: snapshot_(attendanceAdmin) };
  }
  requireAdmin_(token);
  if (action === 'saveEvent') {
    var ev = p.event || {}, stamp = now_();
    if (typeof ev.id !== 'string' || !/^[a-f0-9-]{36}$/.test(ev.id)) fail_('BAD_REQUEST', '予定IDが正しくありません。');
    var current = rows_('events').find(function(e) { return e.event_id === ev.id; }) || null;
    // Reusing the same draft ID makes a retry after a lost response safe.
    if (p.create === true && current) return { snapshot: snapshot_(true) };
    if (!current && p.create !== true) fail_('NOT_FOUND', '予定が見つかりません。');
    var date = text_(ev.date, 10, true), start = text_(ev.startTime, 5, true), end = text_(ev.endTime, 5, true);
    if (!validDate_(date) || !validTime_(start) || !validTime_(end) || end <= start) fail_('BAD_REQUEST', '開催日と開始・終了時間を確認してください。');
    var eventRow = { event_id: ev.id, date: date, title: text_(ev.title, 60, true), start_time: start, end_time: end, location: text_(ev.location, 100, true), note: text_(ev.note, 1000, false), created_by_name: text_(ev.createdByName, 30, true), created_at: current ? current.created_at : stamp, updated_at: stamp, active: current ? current.active : 'TRUE' };
    if (current) write_('events', current._row, eventRow); else append_('events', eventRow);
    return { snapshot: snapshot_(true) };
  }
  if (action === 'setEventActive') {
    var targetEvent = find_('events', 'event_id', p.eventId);
    if (typeof p.active !== 'boolean') fail_('BAD_REQUEST', '表示状態が正しくありません。');
    targetEvent.active = p.active ? 'TRUE' : 'FALSE'; targetEvent.updated_at = now_();
    write_('events', targetEvent._row, targetEvent);
    return { snapshot: snapshot_(true) };
  }
  if (action === 'renamePlayer' || action === 'setPlayerActive') {
    var targetPlayer = find_('players', 'player_id', p.playerId);
    if (action === 'renamePlayer') {
      var newName = text_(p.name, 30, true);
      if (rows_('players').some(function(row) { return row.player_id !== targetPlayer.player_id && normalizeName_(row.name) === normalizeName_(newName); })) fail_('CONFLICT', '同じ名前の選手が登録されています。');
      targetPlayer.name = newName;
    } else {
      if (typeof p.active !== 'boolean') fail_('BAD_REQUEST', '在籍状態が正しくありません。');
      targetPlayer.active = p.active ? 'TRUE' : 'FALSE'; targetPlayer.retired_at = p.active ? '' : now_();
    }
    write_('players', targetPlayer._row, targetPlayer);
    return { snapshot: snapshot_(true) };
  }
  if (action === 'changeAdminPassword') {
    checkRate_();
    if (!secureEqual_(p.currentProof, (credential_() || {}).hash)) fail_('BAD_PASSWORD', '現在の管理パスワードが違います。');
    validateCredential_(p);
    saveCredential_(p.salt, p.proof);
    PropertiesService.getScriptProperties().deleteProperty('AUTH_ATTEMPTS');
    removeSessions_();
    return { changed: true };
  }
  fail_('BAD_REQUEST', '対応していない操作です。');
}

function snapshot_(admin) {
  var allEvents = rows_('events'), eventRows = admin ? allEvents : allEvents.filter(function(e) { return truth_(e.active); });
  var eventIds = eventRows.map(function(e) { return e.event_id; });
  return {
    version: 1,
    players: rows_('players').map(player_),
    events: eventRows.map(function(e) { return { id: e.event_id, date: e.date, title: e.title, startTime: e.start_time, endTime: e.end_time, location: e.location, note: e.note, createdByName: e.created_by_name, active: truth_(e.active) }; }),
    attendance: rows_('attendance').filter(function(a) { return eventIds.indexOf(a.event_id) >= 0 && ['attend', 'late', 'absent'].indexOf(a.status) >= 0; }).map(function(a) { return { eventId: a.event_id, playerId: a.player_id, status: a.status, updatedAt: a.updated_at }; }),
    myPlayerIds: [], admin: !!admin, adminConfigured: !!setting_('admin_password_hash')
  };
}
function player_(p) { return { id: p.player_id, name: p.name, active: truth_(p.active), joinedAt: p.joined_at, retiredAt: p.retired_at || null }; }
function sheet_(name) {
  if (SD_SHEET_CACHE[name]) return SD_SHEET_CACHE[name];
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) fail_('NOT_CONFIGURED', 'setupSouthDragonsを先に実行してください。');
  var sheet = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sheet) fail_('NOT_CONFIGURED', '必要なシートがありません。');
  checkHeaders_(sheet, name); SD_SHEET_CACHE[name] = sheet; return sheet;
}
function checkHeaders_(sheet, name) {
  var headers = sheet.getRange(1, 1, 1, SD_SCHEMA[name].length).getDisplayValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(SD_SCHEMA[name])) fail_('SCHEMA', name + 'シートの1行目が想定と異なります。既存データは変更していません。');
}
function rows_(name) {
  var sheet = sheet_(name), count = sheet.getLastRow();
  if (count < 2) return [];
  return sheet.getRange(2, 1, count - 1, SD_SCHEMA[name].length).getDisplayValues().map(function(values, index) {
    var row = { _row: index + 2 }; SD_SCHEMA[name].forEach(function(key, i) { row[key] = values[i]; }); return row;
  }).filter(function(row) { return row[SD_SCHEMA[name][0]] !== ''; });
}
function safeCell_(value) { var text = String(value == null ? '' : value); return /^[\s]*[=+\-@]/.test(text) ? "'" + text : text; }
function write_(name, index, row) {
  var range = sheet_(name).getRange(index, 1, 1, SD_SCHEMA[name].length);
  range.setNumberFormat('@');
  range.setValues([SD_SCHEMA[name].map(function(key) { return safeCell_(row[key]); })]);
}
function append_(name, row) { write_(name, sheet_(name).getLastRow() + 1, row); }
function find_(name, key, id) {
  var row = rows_(name).find(function(r) { return r[key] === id; });
  if (!row) fail_('NOT_FOUND', '選手または予定が見つかりません。再読み込みしてください。');
  return row;
}
function setting_(key) { var row = rows_('settings').find(function(r) { return r.key === key; }); return row ? row.value : ''; }
function setSetting_(key, value) {
  var row = rows_('settings').find(function(r) { return r.key === key; });
  if (row) write_('settings', row._row, { key: key, value: value }); else append_('settings', { key: key, value: value });
}
function requireAdmin_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail_('UNAUTHORIZED', '管理画面にログインしてください。');
  var props = PropertiesService.getScriptProperties(), raw = props.getProperty(sessionKey_(token)), session;
  try { session = raw ? JSON.parse(raw) : null; } catch (_) { session = null; }
  if (!session || session.expiresAt < Date.now() || session.version !== (credential_() || {}).version) {
    props.deleteProperty(sessionKey_(token)); fail_('UNAUTHORIZED', 'ログインの有効期限が切れました。再度ログインしてください。');
  }
  return true;
}
function sessionKey_(token) {
  return 'SESSION_' + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token).map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function newSession_() {
  var props = PropertiesService.getScriptProperties(), all = props.getProperties(), stamp = Date.now();
  Object.keys(all).filter(function(key) { return key.indexOf('SESSION_') === 0; }).forEach(function(key) {
    try { if (JSON.parse(all[key]).expiresAt <= stamp) props.deleteProperty(key); } catch (_) { props.deleteProperty(key); }
  });
  if (Object.keys(props.getProperties()).filter(function(k) { return k.indexOf('SESSION_') === 0; }).length >= 50) fail_('BUSY', '管理ログインが多すぎます。時間を置いて再試行してください。');
  var token = randomToken_(); props.setProperty(sessionKey_(token), JSON.stringify({ expiresAt: stamp + 8 * 60 * 60 * 1000, version: (credential_() || {}).version })); return token;
}
function removeSessions_() { var props = PropertiesService.getScriptProperties(); Object.keys(props.getProperties()).filter(function(key) { return key.indexOf('SESSION_') === 0; }).forEach(function(key) { props.deleteProperty(key); }); }
function checkRate_() {
  var props = PropertiesService.getScriptProperties(), raw = props.getProperty('AUTH_ATTEMPTS'), state;
  try { state = raw ? JSON.parse(raw) : null; } catch (_) { state = null; }
  if (!state || state.until <= Date.now()) state = { count: 0, until: Date.now() + 15 * 60 * 1000 };
  if (state.count >= 10) fail_('RATE_LIMITED', '認証の試行回数が多すぎます。15分ほど待って再試行してください。');
  state.count++; props.setProperty('AUTH_ATTEMPTS', JSON.stringify(state));
}
function validateCredential_(p) {
  if (typeof p.salt !== 'string' || !/^[a-f0-9]{64}$/.test(p.salt) || typeof p.proof !== 'string' || !/^[a-f0-9]{64}$/.test(p.proof)) fail_('BAD_REQUEST', 'パスワードの設定形式が正しくありません。');
}
function secureEqual_(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; var diff = 0; for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
function text_(value, max, required) {
  if (typeof value !== 'string') fail_('BAD_REQUEST', '入力の形式が正しくありません。');
  var text = value.trim(); if (text.length > max || (required && !text)) fail_('BAD_REQUEST', '入力文字数を確認してください。'); return text;
}
function normalizeName_(name) { return name.replace(/[\s\u3000]+/g, ''); }
function validDate_(s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; var d = new Date(s + 'T12:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '2000-01-01' && s <= '2100-12-31'; }
function validTime_(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
function truth_(value) { return value === true || String(value).toUpperCase() === 'TRUE'; }
function randomToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function now_() { return new Date().toISOString(); }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }
function fail_(code, message) { var error = new Error(message); error.sdCode = code; throw error; }
function json_(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }

// Store the complete credential in one cell so salt/hash/version change together.
function saveCredential_(salt, hash) {
  setSetting_('admin_password_hash', JSON.stringify({ algorithm: 'scrypt-N32768-r8-p3-v1', salt: salt, hash: hash, version: randomToken_() }));
}
function credential_() {
  var raw = setting_('admin_password_hash');
  if (!raw) return null;
  var value; try { value = JSON.parse(raw); } catch (_) { fail_('SCHEMA', '管理認証の設定形式が正しくありません。'); }
  if (!value || value.algorithm !== 'scrypt-N32768-r8-p3-v1' || !/^[a-f0-9]{64}$/.test(value.salt) || !/^[a-f0-9]{64}$/.test(value.hash) || !/^[a-f0-9]{64}$/.test(value.version)) fail_('SCHEMA', '管理認証の設定形式が正しくありません。');
  return value;
}
