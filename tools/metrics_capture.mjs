#!/usr/bin/env node
// Capture a bounded work interval. Usage must come from a matching call report.
import { readFile, writeFile, appendFile, copyFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const FIELDS = ['время', 'этап', 'тип', 'результат', 'входы', 'выходы',
  'причина перехода', 'модель', 'секунды', 'токены', 'стоимость', 'источник метрики'];
const MARK = '## Текущие метрики';
const UNKNOWN = 'н/д';

function csvField(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function csvRows(s) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw Error('Незакрытая кавычка в CSV');
  if (row.length || field) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
function checkpoint(text) {
  const match = text.match(/^## Текущие метрики\r?\n```json\r?\n([^]*?)\r?\n```(?:\r?\n|$)/m);
  return match ? { match: match[0], data: JSON.parse(match[1]) } : null;
}
function updateState(text, old, data) {
  const block = data ? `${MARK}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n` : '';
  return old ? text.replace(old.match, block) : `${text.trimEnd()}\n\n${block}`;
}
function argsOf(argv) {
  const [action, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) throw Error('Ожидается --ключ значение');
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  return { action, opts };
}
function safe(value) { return String(value).replace(/[\r\n]/g, ' ').trim(); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function usage(report, id) {
  if (!report || report.capture_id !== id || !report.call_id || !report.provider || !report.model)
    throw Error('Отчёт не привязан к capture_id и конкретному вызову/модели');
  const u = report.usage;
  if (!u || !['input', 'output', 'cache'].every(k => count(u[k])))
    throw Error('Нужны точные целые input, output, cache (непересекающиеся категории)');
  if (report.input_includes_cache !== false || report.output_includes_reasoning !== true)
    throw Error('Семантика входа, кэша или токенов рассуждения не подтверждена');
  return `вход=${u.input}; выход=${u.output}; кэш=${u.cache}`;
}
function elapsed(start) {
  const ms = Date.now() - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? (ms / 1000).toFixed(3) : UNKNOWN;
}
const TOKEN_COLUMNS = ['tokens_input', 'tokens_output', 'tokens_reasoning',
  'tokens_cache_read', 'tokens_cache_write'];
async function sessionTokens(dbPath, project, sessionID) {
  // A private copy lets SQLite read a live WAL without writing to OpenCode's data directory.
  const dir = await mkdtemp(join(tmpdir(), 'opencode-tokens-'));
  const copied = [];
  let db;
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = dbPath + suffix, target = join(dir, 'opencode.db' + suffix);
      try { await copyFile(source, target); copied.push(target); }
      catch (err) { if (!suffix || err.code !== 'ENOENT') throw err; }
    }
    db = new DatabaseSync(join(dir, 'opencode.db'), { readOnly: true });
    const row = db.prepare(`SELECT id, directory, ${TOKEN_COLUMNS.join(', ')}
      FROM session_v2 WHERE id = ?`).get(sessionID);
    if (!row) return null;
    const repository = resolve(project, '..', '..');
    const rel = relative(repository, resolve(row.directory));
    if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))
      throw Error('Сессия OpenCode относится к другому проекту');
    const values = Object.fromEntries(TOKEN_COLUMNS.map(key => [key, row[key]]));
    if (Object.values(values).some(v => !count(v))) throw Error('Некорректные счётчики OpenCode');
    return values;
  } finally {
    db?.close();
    for (const file of copied.reverse()) await unlink(file);
    await rmdir(dir);
  }
}
function tokenDelta(before, after) {
  if (!after) throw Error('Сессия OpenCode не найдена при завершении');
  const delta = Object.fromEntries(TOKEN_COLUMNS.map(key => [key, after[key] - (before?.[key] ?? 0)]));
  if (Object.values(delta).some(v => v < 0)) throw Error('Счётчики OpenCode уменьшились; токены не записаны');
  if (Object.values(delta).every(v => v === 0)) return null;
  return `вход=${delta.tokens_input}; выход=${delta.tokens_output + delta.tokens_reasoning}; кэш=${delta.tokens_cache_read + delta.tokens_cache_write}`;
}
function priceFields(text) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/);
    if (m) fields.set(m[1].trim(), m[2].trim());
  }
  return fields;
}
function priced(report, text, date) {
  const p = priceFields(text);
  const required = ['Валюта', 'Дата начала периода', 'Дата конца периода',
    'Источник тарифа: ссылка или разрешённый документ', 'Дата источника / проверки тарифа',
    'Единицы и ставки по моделям: вход / выход / кэш, если применимы',
    'Правило отнесения платы к шагу, согласованное человеком'];
  if (required.some(key => !p.get(key))) return null;
  if (date < p.get('Дата начала периода') || date > p.get('Дата конца периода')) return null;
  if (p.get('Правило отнесения платы к шагу, согласованное человеком') !== 'сумма по токенам вызова') return null;
  const model = `${report.provider}/${report.model}`;
  const rateLine = p.get(required[5]).split('\n').find(s => s.startsWith(`${model}:`));
  if (!rateLine) return null;
  const match = rateLine.match(/^.+:вход=([0-9]+(?:\.[0-9]+)?);выход=([0-9]+(?:\.[0-9]+)?);кэш=([0-9]+(?:\.[0-9]+)?);единица=1000000$/);
  if (!match) return null;
  // Fixed point: rates have at most 8 decimal places; output is rounded to 8 places.
  if (match.slice(1).some(s => (s.split('.')[1] ?? '').length > 8)) return null;
  const fixed = s => BigInt(s.split('.')[0]) * 100000000n + BigInt((s.split('.')[1] ?? '').padEnd(8, '0'));
  const u = report.usage;
  const scaled = fixed(match[1]) * BigInt(u.input) + fixed(match[2]) * BigInt(u.output) + fixed(match[3]) * BigInt(u.cache);
  const rounded = (scaled + 500000n) / 1000000n;
  const value = `${rounded / 100000000n}.${String(rounded % 100000000n).padStart(8, '0')}`;
  return { value, currency: p.get('Валюта'), reference: p.get(required[3]), checked: p.get(required[4]) };
}
async function main(argv) {
  const { action, opts } = argsOf(argv);
  if (!['start', 'pause', 'resume', 'finish'].includes(action) || !opts.project)
    throw Error('start|pause|resume|finish --project ПУТЬ');
  const project = resolve(opts.project), statePath = resolve(project, 'state.md');
  const eventsPath = resolve(project, 'events.csv');
  const state = await readFile(statePath, 'utf8');
  const old = checkpoint(state);
  if (action === 'start') {
    if (old) throw Error('Уже есть незавершённая контрольная точка');
    if (opts['opencode-db'] && !opts.session) throw Error('Для OpenCode нужен --session ID');
    const opencodeDB = opts['opencode-db'] === 'default'
      ? join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
      : opts['opencode-db'] ? resolve(opts['opencode-db']) : null;
    const before = opencodeDB ? await sessionTokens(opencodeDB, project, opts.session) : null;
    if (opencodeDB && !before) throw Error('Сессия OpenCode ещё не создана; откройте её перед началом этапа');
    const data = { capture_id: randomUUID(), stage: opts.stage ?? UNKNOWN,
      started: new Date().toISOString(), session_id: opts.session ?? UNKNOWN,
      model: opts.model ?? UNKNOWN, active_started: new Date().toISOString(), active_ms: 0,
      opencode_db: opencodeDB, before };
    await writeFile(statePath, updateState(state, null, data), 'utf8');
    console.log(`Начато: ${data.capture_id} в ${data.started}`);
    return;
  }
  if (!old) throw Error('Нет открытой контрольной точки');
  const data = old.data;
  const now = new Date().toISOString();
  if (action === 'pause') {
    if (!data.active_started) throw Error('Интервал уже остановлен');
    const delta = Date.parse(now) - Date.parse(data.active_started);
    if (delta < 0) throw Error('Системные часы сдвинулись назад');
    data.active_ms += delta; data.active_started = null;
    await writeFile(statePath, updateState(state, old, data), 'utf8');
    console.log(`Приостановлено: ${data.capture_id}`); return;
  }
  if (action === 'resume') {
    if (data.active_started) throw Error('Интервал уже активен');
    data.active_started = now;
    await writeFile(statePath, updateState(state, old, data), 'utf8');
    console.log(`Возобновлено: ${data.capture_id}`); return;
  }
  const rows = csvRows(await readFile(eventsPath, 'utf8'));
  if (rows[0]?.join(',') !== FIELDS.join(',') || rows.some(r => r.length !== FIELDS.length))
    throw Error('Заголовок или строки events.csv не соответствуют шаблону');
  if (rows.slice(1).some(r => r[11].split('; ').includes(`capture_id=${data.capture_id}`))) {
    await writeFile(statePath, updateState(state, old, null), 'utf8');
    console.log(`Запись уже есть в журнале; контрольная точка очищена: ${data.capture_id}`);
    return;
  }
  let tokens = UNKNOWN, model = data.model, cost = UNKNOWN;
  let source = `системные часы; capture_id=${data.capture_id}; session_id=${data.session_id}; начало=${data.started}; конец=${now}; токены н/д: отчёт вызова не представлен`;
  if (data.opencode_db && opts.usage) throw Error('Выберите один источник токенов: OpenCode или --usage');
  if (data.opencode_db) {
    const after = await sessionTokens(data.opencode_db, project, data.session_id);
    const measured = tokenDelta(data.before, after);
    if (!measured && opts['allow-empty'] !== 'yes')
      throw Error('Прирост токенов ещё не появился; повторите finish после завершения вызова или укажите --allow-empty yes');
    tokens = measured ?? UNKNOWN;
    source = `системные часы; capture_id=${data.capture_id}; session_id=${data.session_id}; начало=${data.started}; конец=${now}; OpenCode session_v2, разница точных счётчиков: вход без кэша, выход вместе с reasoning, кэш read+write; ${tokens === UNKNOWN ? 'токены н/д: за интервал не зафиксирован положительный прирост' : 'модель сессии н/д при возможной смене модели'}`;
    model = UNKNOWN;
  }
  if (opts.usage) {
    const report = JSON.parse(await readFile(resolve(opts.usage), 'utf8'));
    tokens = usage(report, data.capture_id);
    model = `${safe(report.provider)}/${safe(report.model)}`;
    if (report.reasoning_level) model += `#${safe(report.reasoning_level)}`;
    if (rows.slice(1).some(r => r[11].includes(`call_id=${safe(report.call_id)}`)))
      throw Error('call_id уже учтён в журнале');
    source = `системные часы; capture_id=${data.capture_id}; session_id=${data.session_id}; начало=${data.started}; конец=${now}; отчёт=${resolve(opts.usage)}; call_id=${safe(report.call_id)}; непересекающиеся категории подтверждены отчётом`;
    const pricingPath = resolve(project, '..', '..', 'docs', 'PRICING.md');
    const pricing = priced(report, await readFile(pricingPath, 'utf8'), data.started.slice(0, 10));
    if (pricing) {
      cost = pricing.value;
      source += `; стоимость расчётная: сумма по токенам вызова; валюта=${safe(pricing.currency)}; тариф=${safe(pricing.reference)}; дата источника=${safe(pricing.checked)}`;
    }
  }
  const delta = data.active_started ? Date.parse(now) - Date.parse(data.active_started) : 0;
  const seconds = delta >= 0 && Number.isFinite(data.active_ms) ? ((data.active_ms + delta) / 1000).toFixed(3) : UNKNOWN;
  if (seconds === UNKNOWN) source += '; время н/д: часы сдвинулись назад';
  if (cost === UNKNOWN) source += '; стоимость н/д: применимый тариф и правило распределения не заданы; валюта н/д';
  const result = safe(opts.result ?? 'Интервал завершён');
  const fields = [data.started, data.stage, 'шаг', result, UNKNOWN, UNKNOWN,
    'Технический сбор метрик', model, seconds, tokens, cost, source];
  await appendFile(eventsPath, fields.map(csvField).join(',') + '\n', 'utf8');
  await writeFile(statePath, updateState(state, old, null), 'utf8');
  console.log(`Записано: ${data.capture_id}; секунды ${seconds}; токены ${tokens}`);
}

main(process.argv.slice(2)).catch(err => { console.error(`Ошибка: ${err.message}`); process.exitCode = 1; });
