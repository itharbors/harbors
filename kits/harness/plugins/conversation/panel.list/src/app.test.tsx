import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('归档入口只请求 Conversation owner 并显式处理 envelope', async () => {
  const source = await readFile(new URL('./app.tsx', import.meta.url), 'utf8');
  assert.match(source, /request\('conversation', 'archiveConversation', id\)/);
  assert.doesNotMatch(source, /request\('agent', 'deleteConversation'/);
  assert.match(source, /result\?\.ok !== true/);
  assert.match(source, /action === 'archive'/);
  assert.match(source, /action === 'restore'/);
  assert.match(source, /result\.value\?\.id/);
  assert.match(source, /aria-busy/);
});
