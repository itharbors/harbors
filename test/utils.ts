import fs from 'fs';
import path from 'path';

// Simplest approach: hardcode the path since we know exactly where we are
// The test directory is at: /Users/visualsj/Project/harmonics/repos/harbors/test/
function getTestDir(): string {
  // We'll find this file by checking __dirname in a simple way
  // Alternatively, just use a reliable method
  // Since we're in a TSX context, let's just use the current working directory and add 'repos/harbors/test'
  return path.join(process.cwd(), 'repos', 'harbors', 'test');
}

interface TempPluginOptions {
  name?: string;
  packageJson?: any;
  source?: string;
}

interface TempPluginResult {
  name: string;
  dir: string;
}

interface TempKitOptions {
  name?: string;
  plugins?: string[];
}

interface TempKitResult {
  name: string;
  dir: string;
}

export function createTempPlugin(options: TempPluginOptions = {}): TempPluginResult {
  const name = options.name || 'test-plugin';
  const testDir = path.join(process.cwd(), 'test');
  const dir = path.join(testDir, 'fixtures', name);
  
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  
  fs.mkdirSync(dir, { recursive: true });
  
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(options.packageJson || {
      name,
      version: '1.0.0',
      main: 'source/index.js'
    }, null, 2)
  );
  
  const sourceDir = path.join(dir, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'index.js'),
    options.source || `
      module.exports = {
        default: {
          run: () => Promise.resolve(),
          execture: () => Promise.resolve()
        }
      };
    `
  );
  
  return { name, dir };
}

export function createTempKit(options: TempKitOptions = {}): TempKitResult {
  const name = options.name || 'test-kit';
  const testDir = path.join(process.cwd(), 'test');
  const dir = path.join(testDir, 'fixtures', name);
  
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  
  fs.mkdirSync(dir, { recursive: true });
  
  const kitPackageJson = {
    name,
    version: '1.0.0',
    harbors: {
      window: {
        file: 'window.html',
        width: 800,
        height: 600
      },
      layout: {},
      plugin: options.plugins || []
    }
  };
  
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(kitPackageJson, null, 2)
  );
  
  fs.writeFileSync(path.join(dir, 'window.html'), '<html></html>');
  
  if (options.plugins && options.plugins.length > 0) {
    for (const pluginName of options.plugins) {
      const pluginDir = path.join(dir, pluginName);
      fs.mkdirSync(pluginDir, { recursive: true });
      
      fs.writeFileSync(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({
          name: pluginName,
          version: '1.0.0',
          main: 'source/index.js'
        }, null, 2)
      );
      
      const sourceDir = path.join(pluginDir, 'source');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, 'index.js'),
        `
          module.exports = {
            default: {
              run: () => Promise.resolve(),
              execture: () => Promise.resolve()
            }
          };
        `
      );
    }
  }
  
  return { name, dir };
}

export function cleanupTemp(): void {
  const testDir = path.join(process.cwd(), 'test');
  const fixturesDir = path.join(testDir, 'fixtures');
  if (fs.existsSync(fixturesDir)) {
    fs.rmSync(fixturesDir, { recursive: true, force: true });
  }
}
