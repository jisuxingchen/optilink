/**
 * TF-012 boot blockers smoke tests (pure Node, no browser).
 *
 * Verifies the Mini Program compiles and boots visibly:
 *  1. app.json has no invalid permission.scope.camera entry.
 *  2. project.config.json is a plain miniprogram project (no pluginRoot/plugin mode).
 *  3. pages/index/index.js registers Page() even if the optical-core bundle fails.
 *  4. initial data exposes buildId + mode=receive + boot status.
 *  5. the committed optical-core bundle has no runtime dependency on
 *     TextEncoder/TextDecoder/window/document/navigator/crypto/Buffer/process/atob/btoa.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
// src/optical-core -> experiments/tf-002-single-code -> experiments
const MINI = join(HERE, '..', '..', '..', 'tf-008-wechat-mini-receiver-poc');
const BUNDLE = join(MINI, 'utils', 'optical-core.js');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('app.json has no invalid permission.scope.camera entry', () => {
  const app = readJson(join(MINI, 'app.json')) as Record<string, unknown>;
  assert.ok(app.pages, 'app.json has pages');
  assert.equal(app.permission, undefined, 'app.json must not declare permission.scope.camera');
});

test('project.config.json is plain miniprogram (no pluginRoot, no plugin mode)', () => {
  const cfg = readJson(join(MINI, 'project.config.json')) as Record<string, unknown>;
  assert.equal(cfg.compileType, 'miniprogram');
  assert.equal(cfg.pluginRoot, undefined, 'no pluginRoot field');
  assert.notEqual(JSON.stringify(cfg).includes('"pluginRoot"'), true, 'no pluginRoot anywhere');
  const setting = (cfg.setting as Record<string, unknown>) || {};
  assert.notEqual(setting.localPlugins, true, 'localPlugins must not enable plugin mode');
});

test('pages/index/index.js registers Page() with visible boot data', () => {
  const require2 = createRequire(import.meta.url);
  let captured: Record<string, unknown> | null = null;
  (globalThis as unknown as Record<string, unknown>).Page = (cfg: Record<string, unknown>) => { captured = cfg; };
  delete require2.cache[require2.resolve(join(MINI, 'pages', 'index', 'index.js'))];
  require2(join(MINI, 'pages', 'index', 'index.js'));
  assert.ok(captured, 'Page() was called');
  const data = (captured as Record<string, unknown>).data as Record<string, unknown>;
  assert.ok(data.buildId, 'data.buildId present');
  assert.match(String(data.buildId), /^tf012-r6-/, 'buildId uses tf012-r6 prefix');
  assert.equal(data.mode, 'receive', 'mode defaults to receive');
  assert.ok('bootStatus' in data, 'boot status field present');
  assert.ok('bootError' in data, 'boot error field present');
});

test('page registration still succeeds when optical-core require throws', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'optilink-boot-'));
  try {
    const pagesDir = join(tmp, 'pages', 'index');
    const utilsDir = join(tmp, 'utils');
    mkdirSync(pagesDir, {recursive: true});
    mkdirSync(utilsDir, {recursive: true});
    writeFileSync(join(utilsDir, 'optical-core.js'), "throw new Error('synthetic bundle load failure');\n");
    writeFileSync(join(pagesDir, 'index.js'), readFileSync(join(MINI, 'pages', 'index', 'index.js'), 'utf8'));

    const require2 = createRequire(import.meta.url);
    let captured: Record<string, unknown> | null = null;
    (globalThis as unknown as Record<string, unknown>).Page = (cfg: Record<string, unknown>) => { captured = cfg; };
    const entry = join(pagesDir, 'index.js');
    delete require2.cache[require2.resolve(entry)];
    require2(entry);
    assert.ok(captured, 'Page() still registered despite bundle throw');
    const data = (captured as Record<string, unknown>).data as Record<string, unknown>;
    assert.ok('bootStatus' in data && 'bootError' in data, 'boot fields present');
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('committed optical-core bundle has no restricted runtime globals', () => {
  const code = readFileSync(BUNDLE, 'utf8');
  for (const forbidden of ['TextEncoder', 'TextDecoder', 'window', 'document', 'navigator', 'crypto', 'Buffer', 'process', 'atob', 'btoa']) {
    assert.ok(!new RegExp('\\b' + forbidden + '\\b').test(code), 'bundle must not reference ' + forbidden);
  }
});

test('committed optical-core bundle loads in a restricted runtime (no web/Node globals)', () => {
  const code = readFileSync(BUNDLE, 'utf8');
  const moduleBox = {exports: {}};
  const sandbox = {module: moduleBox, exports: moduleBox.exports};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, {filename: 'optical-core.js'});
  const exports = moduleBox.exports as Record<string, unknown>;
  assert.equal(typeof exports.SharedOpticalReceiveCore, 'function', 'SharedOpticalReceiveCore exported');
  const sha256Hex = exports.sha256Hex as (b: Uint8Array) => string;
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'sha256Hex works in restricted runtime',
  );
});
