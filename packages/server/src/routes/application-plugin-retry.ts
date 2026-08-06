import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApplicationBootstrap } from '../application/types';
import { HttpError } from '../http/errors';
import { readJson } from '../http/json';
import { isRecord } from '../http/validation';
import { authorizeApplicationMutation } from './application-menu-trigger';
import { sendJson } from './utils';

interface ApplicationPluginRetryRuntime {
  retryPlugin(plugin: string): Promise<ApplicationBootstrap>;
}

interface ApplicationPluginRetryInput {
  plugin: string;
}

export function createApplicationPluginRetryRouter(
  runtime: ApplicationPluginRetryRuntime,
  options: { controlToken?: string } = {},
) {
  return async function applicationPluginRetryRouter(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const requestTarget = req.url || '/';
    const queryStart = requestTarget.indexOf('?');
    const requestPath = queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
    if (requestPath !== '/api/application/plugin/retry') {
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }
    authorizeApplicationMutation(req, options.controlToken);
    const body = await readJson(req, isApplicationPluginRetryInput);
    try {
      sendJson(res, 200, await runtime.retryPlugin(body.plugin));
    } catch (error) {
      if (hasCode(error, 'APPLICATION_PLUGIN_UNAVAILABLE')) {
        throw new HttpError(404, 'APPLICATION_PLUGIN_NOT_FOUND', 'Application plugin not found');
      }
      if (hasCode(error, 'APPLICATION_RUNTIME_UNAVAILABLE')) {
        throw new HttpError(503, 'APPLICATION_RUNTIME_UNAVAILABLE', 'Application runtime is unavailable');
      }
      throw error;
    }
  };
}

function isApplicationPluginRetryInput(value: unknown): value is ApplicationPluginRetryInput {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.plugin === 'string'
    && /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(value.plugin);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
