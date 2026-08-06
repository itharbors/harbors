import { describe, expect, it } from 'vitest';

import {
  readClaudeConfiguration,
  readClaudeConfigurations,
  readCodexConfiguration,
  readCodexConfigurations,
} from '../main/src/adapters/config-reader.js';

describe('Agent configuration readers', () => {
  it('keeps only the Claude endpoint, model, and Hook executable metadata', () => {
    const fixture = {
      model: 'claude-sonnet-4-5',
      env: {
        ANTHROPIC_BASE_URL: 'https://super-relay.byted.org/',
        ANTHROPIC_AUTH_TOKEN: 'secret-key',
      },
      hooks: {
        SessionEnd: [{
          matcher: '*',
          hooks: [{
            type: 'command',
            command: 'ANTHROPIC_AUTH_TOKEN=secret-key claude -p knowledge-capture',
          }],
        }],
        Notification: [{ hooks: [{ type: 'http', url: 'https://secret.example.test' }] }],
      },
      apiKey: 'secret-key',
      prompt: 'never persist me',
    };

    expect(readClaudeConfiguration(fixture)).toEqual({
      agent: 'claude',
      provider: 'custom',
      endpoint: 'https://super-relay.byted.org',
      model: 'claude-sonnet-4-5',
      hookExecutables: [{ event: 'SessionEnd', executable: 'claude' }],
    });
    expect(JSON.stringify(readClaudeConfiguration(fixture))).not.toContain('secret-key');
  });

  it('uses the official Claude endpoint when no custom base URL is configured', () => {
    expect(readClaudeConfiguration({ model: 'claude-opus-4-1' })).toEqual({
      agent: 'claude',
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com',
      model: 'claude-opus-4-1',
      hookExecutables: [],
    });
  });

  it('discovers both configured and official Claude endpoints without duplicating defaults', () => {
    expect(readClaudeConfigurations({
      env: { ANTHROPIC_BASE_URL: 'https://super-relay.byted.org' },
    }).map(({ provider, endpoint }) => ({ provider, endpoint }))).toEqual([
      { provider: 'custom', endpoint: 'https://super-relay.byted.org' },
      { provider: 'anthropic', endpoint: 'https://api.anthropic.com' },
    ]);
    expect(readClaudeConfigurations({})).toHaveLength(1);
  });

  it('parses only exact Codex TOML provider keys and drops credentials', () => {
    const fixture = `
model = "gpt-5.2-codex"
model_provider = "relay"
api_key = "secret-key"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example.test/v1"
env_key = "SECRET_TOKEN"
`;

    expect(readCodexConfiguration(fixture)).toEqual({
      agent: 'codex',
      provider: 'relay',
      endpoint: 'https://relay.example.test/v1',
      model: 'gpt-5.2-codex',
      hookExecutables: [],
    });
    expect(JSON.stringify(readCodexConfiguration(fixture))).not.toMatch(/secret-key|SECRET_TOKEN/);
  });

  it('rejects conflicting exact Codex fields and unsafe endpoints', () => {
    expect(() => readCodexConfiguration('model = "a"\nmodel = "b"'))
      .toThrow(/conflicting.*model/iu);
    expect(() => readCodexConfiguration(`
model_provider = "relay"
[model_providers.relay]
base_url = "http://relay.example.test"
`)).toThrow(/https/iu);
  });

  it('discovers every declared Codex endpoint with the active provider first', () => {
    const configurations = readCodexConfigurations(`
model_provider = "relay"
[model_providers.backup]
base_url = "https://backup.example.test/v1"
[model_providers.relay]
base_url = "https://relay.example.test/v1"
`);

    expect(configurations.map(({ provider, endpoint }) => ({ provider, endpoint }))).toEqual([
      { provider: 'relay', endpoint: 'https://relay.example.test/v1' },
      { provider: 'backup', endpoint: 'https://backup.example.test/v1' },
      { provider: 'openai', endpoint: 'https://api.openai.com/v1' },
      { provider: 'openai', endpoint: 'https://chatgpt.com' },
    ]);
  });
});
