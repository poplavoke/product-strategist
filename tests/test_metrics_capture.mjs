import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const script = resolve('tools/metrics_capture.mjs');
const header = 'время,этап,тип,результат,входы,выходы,причина перехода,модель,секунды,токены,стоимость,источник метрики\n';
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'metrics-'));
  const project = join(root, 'projects', 'example');
  await mkdir(project, { recursive: true }); await mkdir(join(root, 'docs'));
  await writeFile(join(project, 'state.md'), '# Состояние\n');
  await writeFile(join(project, 'events.csv'), header);
  await writeFile(join(root, 'docs', 'PRICING.md'), '# Тарифы\n');
  try { await fn({ root, project }); } finally { await rm(root, { recursive: true, force: true }); }
}
function run(project, ...args) {
  return spawnSync(process.execPath, [script, args[0], '--project', project, ...args.slice(1)],
    { encoding: 'utf8' });
}
async function id(project) {
  const state = await readFile(join(project, 'state.md'), 'utf8');
  return JSON.parse(state.match(/```json\n([^]*?)\n```/)[1]).capture_id;
}
test('часы, пауза и неизвестные токены', () => fixture(async ({ project }) => {
  assert.equal(run(project, 'start', '--stage', 'research').status, 0);
  assert.notEqual(run(project, 'start').status, 0);
  assert.equal(run(project, 'pause').status, 0);
  assert.equal(run(project, 'resume').status, 0);
  assert.equal(run(project, 'finish', '--result', 'Проверка').status, 0);
  const events = await readFile(join(project, 'events.csv'), 'utf8');
  assert.match(events, /research,шаг,Проверка,н\/д,н\/д,Технический сбор метрик,н\/д,[0-9.]+,н\/д,н\/д,/);
  assert.doesNotMatch(await readFile(join(project, 'state.md'), 'utf8'), /Текущие метрики/);
  assert.notEqual(run(project, 'finish').status, 0);
}));
test('точный отчёт и отказ от дубля call_id', () => fixture(async ({ project }) => {
  assert.equal(run(project, 'start').status, 0);
  const report = join(project, 'usage.json');
  const base = { capture_id: await id(project), call_id: 'provider-call-1', provider: 'openai',
    model: 'model', usage: { input: 12, output: 4, cache: 5 },
    input_includes_cache: false, output_includes_reasoning: true };
  await writeFile(report, JSON.stringify(base));
  assert.equal(run(project, 'finish', '--usage', report).status, 0);
  assert.match(await readFile(join(project, 'events.csv'), 'utf8'), /вход=12; выход=4; кэш=5/);
  assert.equal(run(project, 'start').status, 0);
  await writeFile(report, JSON.stringify({ ...base, capture_id: await id(project) }));
  assert.notEqual(run(project, 'finish', '--usage', report).status, 0);
  const events = await readFile(join(project, 'events.csv'), 'utf8');
  assert.equal(events.trimEnd().split('\n').length, 2);
}));
test('несовместимая семантика токенов отклоняется до записи', () => fixture(async ({ project }) => {
  run(project, 'start');
  const report = join(project, 'usage.json');
  await writeFile(report, JSON.stringify({ capture_id: await id(project), call_id: 'a',
    provider: 'p', model: 'm', usage: { input: 5, output: 2, cache: 1 },
    input_includes_cache: true, output_includes_reasoning: true }));
  assert.notEqual(run(project, 'finish', '--usage', report).status, 0);
  assert.equal(await readFile(join(project, 'events.csv'), 'utf8'), header);
}));

test('после сбоя очистки состояния повторное завершение не дублирует событие', () => fixture(async ({ project }) => {
  assert.equal(run(project, 'start').status, 0);
  const checkpoint = await readFile(join(project, 'state.md'), 'utf8');
  assert.equal(run(project, 'finish').status, 0);
  const recorded = await readFile(join(project, 'events.csv'), 'utf8');
  await writeFile(join(project, 'state.md'), checkpoint);
  assert.equal(run(project, 'finish').status, 0);
  assert.equal(await readFile(join(project, 'events.csv'), 'utf8'), recorded);
  assert.doesNotMatch(await readFile(join(project, 'state.md'), 'utf8'), /Текущие метрики/);
}));
test('расчёт цены только по заполненному тарифу', () => fixture(async ({ root, project }) => {
  await writeFile(join(root, 'docs', 'PRICING.md'), `| Валюта | USD |\n| Дата начала периода | 2020-01-01 |\n| Дата конца периода | 2100-01-01 |\n| Источник тарифа: ссылка или разрешённый документ | https://example.test/rates |\n| Дата источника / проверки тарифа | 2026-11-22 |\n| Единицы и ставки по моделям: вход / выход / кэш, если применимы | p/m:вход=1;выход=2;кэш=0.5;единица=1000000 |\n| Правило отнесения платы к шагу, согласованное человеком | сумма по токенам вызова |\n`);
  run(project, 'start');
  const report = join(project, 'usage.json');
  await writeFile(report, JSON.stringify({ capture_id: await id(project), call_id: 'a', provider: 'p',
    model: 'm', usage: { input: 1000000, output: 1000000, cache: 1000000 },
    input_includes_cache: false, output_includes_reasoning: true }));
  assert.equal(run(project, 'finish', '--usage', report).status, 0);
  assert.match(await readFile(join(project, 'events.csv'), 'utf8'), /,3\.50000000,.*валюта=USD/);
}));

test('OpenCode: берёт разницу одной сессии и не дублирует reasoning и кэш', () => fixture(async ({ project }) => {
  const path = join(project, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)`);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, 10, 4, 2, 3, 1)').run('ses_one', resolve(project, '..', '..'));
  assert.equal(run(project, 'start', '--stage', 'research', '--session', 'ses_one', '--opencode-db', path).status, 0);
  db.prepare(`UPDATE session_v2 SET tokens_input=20, tokens_output=9,
    tokens_reasoning=5, tokens_cache_read=10, tokens_cache_write=2 WHERE id='ses_one'`).run();
  db.close();
  assert.equal(run(project, 'finish').status, 0);
  assert.match(await readFile(join(project, 'events.csv'), 'utf8'), /вход=10; выход=8; кэш=8/);
}));

test('OpenCode: чужую сессию не учитывает', () => fixture(async ({ project, root }) => {
  const path = join(project, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)`);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, 10, 4, 2, 3, 1)').run('ses_other', resolve(root, '..', 'other-repository'));
  db.close();
  assert.notEqual(run(project, 'start', '--session', 'ses_other', '--opencode-db', path).status, 0);
  assert.equal(await readFile(join(project, 'events.csv'), 'utf8'), header);
}));

test('OpenCode: уменьшение счётчиков не записывает ошибочную разницу', () => fixture(async ({ project }) => {
  const path = join(project, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)`);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, 10, 4, 2, 3, 1)').run('ses_one', project);
  assert.equal(run(project, 'start', '--session', 'ses_one', '--opencode-db', path).status, 0);
  db.prepare("UPDATE session_v2 SET tokens_input=9 WHERE id='ses_one'").run();
  db.close();
  assert.notEqual(run(project, 'finish').status, 0);
  assert.equal(await readFile(join(project, 'events.csv'), 'utf8'), header);
}));

test('OpenCode: нулевой прирост ждёт завершения вызова', () => fixture(async ({ project }) => {
  const path = join(project, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)`);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, 0, 0, 0, 0, 0)').run('ses_one', project);
  db.close();
  assert.equal(run(project, 'start', '--session', 'ses_one', '--opencode-db', path).status, 0);
  assert.notEqual(run(project, 'finish').status, 0);
  assert.equal(await readFile(join(project, 'events.csv'), 'utf8'), header);
  assert.equal(run(project, 'finish', '--allow-empty', 'yes').status, 0);
  assert.match(await readFile(join(project, 'events.csv'), 'utf8'), /,н\/д,н\/д,/);
}));
