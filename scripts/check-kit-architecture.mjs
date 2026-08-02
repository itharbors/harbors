#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { auditKitArchitecture } from './lib/kit-architecture-boundary.mjs';

const USAGE = 'Usage: node scripts/check-kit-architecture.mjs [kit-slug]\n';
const UNSAFE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

function safeLine(value) {
  return String(value).replace(UNSAFE_LINE, ' ').replace(/\s+/gu, ' ').trim();
}

function safeViolationPath(value) {
  if (typeof value !== 'string' || path.isAbsolute(value) || value.includes('\\')
    || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return '[invalid-path]';
  }
  return value;
}

export async function runKitArchitectureCli(
  args,
  io = process,
  dependencies = { repositoryRoot: process.cwd(), auditKitArchitecture },
) {
  if (!Array.isArray(args) || args.length > 1) {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    const result = await dependencies.auditKitArchitecture({
      repositoryRoot: dependencies.repositoryRoot,
      ...(args.length === 1 ? { targetKit: args[0] } : {}),
    });
    if (result.errors.length === 0) {
      io.stdout.write(`KIT_ARCHITECTURE_BOUNDARY_OK scope=${result.scope}\n`);
      return 0;
    }
    for (const violation of result.errors) {
      io.stderr.write(`${safeLine(violation.code)} ${safeViolationPath(violation.path)}: ${safeLine(violation.message)}\n`);
    }
    io.stderr.write(`KIT_ARCHITECTURE_BOUNDARY_FAILED scope=${result.scope} errors=${result.errors.length}\n`);
    return 1;
  } catch (cause) {
    io.stderr.write('KIT_ARCHITECTURE_BOUNDARY_ERROR audit failed\n');
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runKitArchitectureCli(process.argv.slice(2));
}
