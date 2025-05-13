#!/usr/bin/env node

import { join } from 'path';
import { spawn } from 'child_process';

const args = ['run', 'start', '--', ...process.argv.slice(2)];
spawn('npm', args, {
    cwd: join(__dirname, '../..'),
    stdio: 'inherit',
});
