import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import definition from './index.ts';
import { normalizeSettings, serializeModelDrafts } from './index.js';

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('settings DTO contains every provider and projects only safe fields', () => {
  const value = normalizeSettings({ defaultProviderId: 'a', leaked: 'unknown', providers: [{ id: 'a', name: 'A', protocol: 'openai-chat-completions', baseUrl: 'https://example.invalid', models: [{ id: 'm', secret: 'token', unknown: true }], defaultModel: 'm', credentialConfigured: true, credentialId: 'vault-id', secret: 'token' }, { id: 'b', name: 'B', protocol: 'anthropic-messages', baseUrl: '', models: [], credentialConfigured: false, credentialId: 'vault-id-2' }] });
  assert.equal(value.providers.length, 2);
  assert.equal(value.providers[0]?.credentialConfigured, true);
  assert.deepEqual(value, { defaultProviderId: 'a', providers: [{ id: 'a', name: 'A', protocol: 'openai-chat-completions', baseUrl: 'https://example.invalid', models: [{ id: 'm', name: 'm' }], defaultModel: 'm', credentialConfigured: true }, { id: 'b', name: 'B', protocol: 'anthropic-messages', baseUrl: '', models: [], credentialConfigured: false }] });
  assert.doesNotMatch(JSON.stringify(value), /credentialId|vault-id|secret|token|unknown|leaked/u);
});

test('invalid settings DTO is rejected', () => {
  assert.throws(() => normalizeSettings({ providers: 'not-an-array' }), /响应无效/u);
});

test('structured model drafts preserve supported fields', () => {
  assert.deepEqual(serializeModelDrafts([{ id: 'm', name: '', description: '说明', contextWindow: '128000' }]), [{ id: 'm', name: 'm', description: '说明', contextWindow: 128000 }]);
});

test('structured model drafts reject empty, duplicate, or invalid context values', () => {
  assert.throws(() => serializeModelDrafts([{ id: '', name: '', description: '', contextWindow: '' }]), /ID 不能为空/u);
  assert.throws(() => serializeModelDrafts([{ id: 'm', name: '', description: '', contextWindow: '' }, { id: 'm', name: '', description: '', contextWindow: '' }]), /ID 重复/u);
  assert.throws(() => serializeModelDrafts([{ id: 'm', name: '', description: '', contextWindow: '0' }]), /上下文窗口必须是正整数/u);
  assert.throws(() => serializeModelDrafts([{ id: 'm', name: '', description: '', contextWindow: '1.5' }]), /上下文窗口必须是正整数/u);
});

test('真实保存按钮 click 直接调用 Model Service owner/name/args，并显示成功/失败反馈', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://host.test/model-service-settings', runScripts: 'outside-only' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const calls: unknown[][] = [];
  let failNext = false;
  // The isolated Web iframe may not expose DOM constructors on its Window.
  for (const constructorName of ['HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement']) {
    Object.defineProperty(dom.window, constructorName, { configurable: true, value: undefined });
  }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });

  const settings = { defaultProviderId: 'relay', providers: [{ id: 'relay', name: 'Relay', protocol: 'openai-chat-completions', baseUrl: 'https://old.invalid', models: [{ id: 'model', name: 'Model' }], credentialConfigured: false }] };

  try {
    const request = async (plugin: string, name: string, ...args: unknown[]) => {
      calls.push([plugin, name, ...args]);
      if (failNext) { failNext = false; throw new Error('模型服务配置不可写'); }
      return name === 'getSettings'
        ? settings
        : { ...settings, providers: [{ ...settings.providers[0], baseUrl: 'https://new.invalid', credentialConfigured: true }] };
    };
    await definition.mount({ message: { request } });
    assert.deepEqual(calls[0], ['model-service', 'getSettings']);

    const baseUrl = dom.window.document.querySelector('[name="baseUrl"]') as HTMLInputElement;
    baseUrl.value = 'https://new.invalid';
    (dom.window.document.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await nextTurn();
    assert.deepEqual(calls[1], ['model-service', 'saveProvider', { id: 'relay', previousId: 'relay', name: 'Relay', protocol: 'openai-chat-completions', baseUrl: 'https://new.invalid', models: [{ id: 'model', name: 'Model' }], defaultModel: '', secret: '' }]);
    assert.equal(dom.window.document.getElementById('status')?.textContent, '已保存，Token 输入已清空');
    assert.equal(dom.window.document.querySelector('.badge')?.textContent, '凭据已配置');

    failNext = true;
    (dom.window.document.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await nextTurn();
    assert.equal(calls.length, 3, 'a failed save click must also issue exactly one request');
    assert.equal(dom.window.document.getElementById('status')?.textContent, '模型服务配置不可写');
    assert.equal((dom.window.document.getElementById('status') as HTMLElement).dataset.kind, 'error');
  } finally {
    definition.unmount();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /postMessage/);
});
