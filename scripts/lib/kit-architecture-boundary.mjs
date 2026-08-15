import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

import { isValidKitSlug } from './kit-boundary.mjs';

const ERROR_ORDER = new Map([
  ['KIT_CROSS_IMPORT', 0],
  ['KIT_LOCAL_DEPENDENCY_ESCAPE', 1],
  ['KIT_LOCK_MISSING', 2],
  ['FRAMEWORK_KIT_SPECIAL_CASE', 3],
  ['STATIC_KIT_REGISTRY', 4],
]);
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|mts|cts)$/u;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.cache', 'coverage', 'dist', 'node_modules', 'out', 'release',
]);
const APPROVED_GENERIC_ENV = new Set(['HARBORS_NOTIFICATION_PORT']);

function relative(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join('/').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?');
}

function error(code, repositoryRoot, file, message) {
  return Object.freeze({
    code,
    path: relative(repositoryRoot, file),
    message,
    order: ERROR_ORDER.get(code),
  });
}

function compareErrors(left, right) {
  return left.order - right.order
    || left.path.localeCompare(right.path)
    || left.message.localeCompare(right.message);
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, predicate, output = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause?.code === 'ENOENT') return output;
    throw cause;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(file, predicate, output);
    } else if (entry.isFile() && predicate(file, entry)) {
      output.push(file);
    }
  }
  return output;
}

async function walkSymlinks(directory, output = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause?.code === 'ENOENT') return output;
    throw cause;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) output.push(file);
    else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) await walkSymlinks(file, output);
  }
  return output;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function listKitSlugs(repositoryRoot, targetKit) {
  if (targetKit !== undefined) {
    if (!isValidKitSlug(targetKit)) throw new Error('invalid Kit slug');
    const directory = path.join(repositoryRoot, 'kits', targetKit);
    const stat = await lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`unknown Kit slug: ${targetKit}`);
    return [targetKit];
  }
  const entries = await readdir(path.join(repositoryRoot, 'kits'), { withFileTypes: true }).catch((cause) => {
    if (cause?.code === 'ENOENT') return [];
    throw cause;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isValidKitSlug(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readKitIdentity(repositoryRoot, slug) {
  const directory = path.join(repositoryRoot, 'kits', slug);
  const manifest = await readJson(path.join(directory, 'kit.json')).catch(() => ({}));
  return Object.freeze({ slug, id: typeof manifest.id === 'string' ? manifest.id : null, directory });
}

async function collectPackageOwners(repositoryRoot, slugs) {
  const owners = new Map();
  for (const slug of slugs) {
    const kitRoot = path.join(repositoryRoot, 'kits', slug);
    const manifests = await walk(kitRoot, (file) => path.basename(file) === 'package.json');
    for (const manifestPath of manifests) {
      const manifest = await readJson(manifestPath).catch(() => null);
      if (typeof manifest?.name === 'string') {
        const packageOwners = owners.get(manifest.name) ?? new Set();
        packageOwners.add(slug);
        owners.set(manifest.name, packageOwners);
      }
    }
  }
  return owners;
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function importSpecifiers(sourceFile) {
  const specifiers = [];
  function add(node) {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments.length === 1) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function referencedRepositoryPaths(sourceFile) {
  const references = [];
  const clone = (scope) => ({ objects: new Set(scope.objects), functions: new Set(scope.functions) });
  const boundNames = (name) => {
    if (ts.isIdentifier(name)) return [name.text];
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      return name.elements.flatMap((element) => ts.isBindingElement(element) ? boundNames(element.name) : []);
    }
    return [];
  };
  const shadow = (scope, name) => {
    for (const value of boundNames(name)) {
      scope.objects.delete(value);
      scope.functions.delete(value);
    }
  };
  const bindElements = (scope, pattern) => {
    if (!ts.isObjectBindingPattern(pattern)) return;
    for (const element of pattern.elements) {
      const imported = element.propertyName ?? element.name;
      if (ts.isIdentifier(imported) && ['join', 'resolve'].includes(imported.text)
        && ts.isIdentifier(element.name)) scope.functions.add(element.name.text);
    }
  };
  const pathModule = (value) => value === 'path' || value === 'node:path';
  const isPathRequire = (node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'require'
    && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
    && pathModule(node.arguments[0].text);

  function inspectReference(node, scope) {
    const pathCall = ts.isCallExpression(node) && (
      (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && scope.objects.has(node.expression.expression.text)
        && ['join', 'resolve'].includes(node.expression.name.text))
      || (ts.isIdentifier(node.expression) && scope.functions.has(node.expression.text))
    );
    const urlCall = ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'URL';
    if (pathCall || urlCall) {
      const values = node.arguments.map((argument) =>
        ts.isStringLiteralLike(argument) ? argument.text : null);
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value === 'kits' && typeof values[index + 1] === 'string') {
          references.push({ kind: 'kit', slug: values[index + 1] });
        }
        const match = typeof value === 'string' ? /(?:^|\/)kits\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/u.exec(value) : null;
        if (match) references.push({ kind: 'kit', slug: match[1] });
        if (typeof value === 'string' && /(?:^|\/)packages\/server\/src(?:\/|$)/u.test(value)) {
          references.push({ kind: 'framework-private' });
        }
      }
    }
  }

  function visit(node, scope) {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      const local = clone(scope);
      for (const statement of node.statements) visit(statement, local);
      return;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      && pathModule(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) scope.objects.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        scope.objects.add(clause.namedBindings.name.text);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (['join', 'resolve'].includes(imported)) scope.functions.add(element.name.text);
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      shadow(scope, node.name);
      if (ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)
        && pathModule(node.moduleReference.expression.text)) scope.objects.add(node.name.text);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer) visit(declaration.initializer, scope);
        shadow(scope, declaration.name);
        if (declaration.initializer && isPathRequire(declaration.initializer)) {
          if (ts.isIdentifier(declaration.name)) scope.objects.add(declaration.name.text);
          bindElements(scope, declaration.name);
        } else if (declaration.initializer && ts.isIdentifier(declaration.initializer)
          && scope.objects.has(declaration.initializer.text)) {
          bindElements(scope, declaration.name);
        } else if (declaration.initializer && ts.isPropertyAccessExpression(declaration.initializer)
          && ts.isIdentifier(declaration.initializer.expression)
          && scope.objects.has(declaration.initializer.expression.text)
          && ['join', 'resolve'].includes(declaration.initializer.name.text)
          && ts.isIdentifier(declaration.name)) {
          scope.functions.add(declaration.name.text);
        }
      }
      return;
    }
    if (ts.isFunctionLike(node)) {
      const local = clone(scope);
      if ('name' in node && node.name) shadow(scope, node.name);
      for (const parameter of node.parameters) shadow(local, parameter.name);
      if (node.body) visit(node.body, local);
      return;
    }
    inspectReference(node, scope);
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(sourceFile, { objects: new Set(), functions: new Set() });
  return references;
}

function importedKitSlug({ repositoryRoot, sourcePath, specifier, packageOwners, sourceKit }) {
  const owners = packageOwners.get(packageNameFromSpecifier(specifier));
  if (owners?.has(sourceKit)) return sourceKit;
  if (owners?.size > 0) return [...owners].sort()[0];
  let resolved;
  if (specifier.startsWith('.')) resolved = path.resolve(path.dirname(sourcePath), specifier);
  else if (path.isAbsolute(specifier)) resolved = path.resolve(specifier);
  else if (specifier.startsWith('kits/')) resolved = path.resolve(repositoryRoot, specifier);
  else return null;
  const kitRoot = path.join(repositoryRoot, 'kits');
  const candidate = path.relative(kitRoot, resolved);
  if (candidate.startsWith('..') || path.isAbsolute(candidate)) return null;
  const [slug] = candidate.split(path.sep);
  return isValidKitSlug(slug) ? slug : null;
}

async function auditImports({ repositoryRoot, kit, packageOwners, errors }) {
  const files = await walk(kit.directory, (file, entry) => entry.isFile() && SOURCE_EXTENSION.test(file));
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const specifier of importSpecifiers(source)) {
      const owner = importedKitSlug({
        repositoryRoot, sourcePath: file, specifier, packageOwners, sourceKit: kit.slug,
      });
      if (owner && owner !== kit.slug) {
        errors.push(error(
          'KIT_CROSS_IMPORT', repositoryRoot, file,
          `Kit ${kit.slug} imports source owned by Kit ${owner}`,
        ));
        continue;
      }
      if (specifier.startsWith('.') || path.isAbsolute(specifier) || specifier.startsWith('file:')) {
        let resolved;
        try {
          resolved = specifier.startsWith('file:')
            ? new URL(specifier).pathname
            : path.resolve(path.dirname(file), specifier);
        } catch {
          resolved = null;
        }
        if (resolved) {
          const withinKit = path.relative(kit.directory, resolved);
          if (withinKit.startsWith('..') || path.isAbsolute(withinKit)) {
            errors.push(error(
              'KIT_LOCAL_DEPENDENCY_ESCAPE', repositoryRoot, file,
              `Kit ${kit.slug} imports source outside its own directory`,
            ));
          }
        }
      }
    }
    for (const reference of referencedRepositoryPaths(source)) {
      if (reference.kind === 'kit' && reference.slug !== kit.slug) errors.push(error(
        'KIT_CROSS_IMPORT', repositoryRoot, file,
        `Kit ${kit.slug} references Kit ${reference.slug} by repository path`,
      ));
      if (reference.kind === 'framework-private') errors.push(error(
        'KIT_LOCAL_DEPENDENCY_ESCAPE', repositoryRoot, file,
        `Kit ${kit.slug} references private Framework source`,
      ));
    }
  }
}

function decodeLocalReference(value) {
  let candidate = value;
  if (candidate.startsWith('npm:')) {
    const protocolIndex = candidate.search(/@(?:file|link|workspace):/u);
    if (protocolIndex !== -1) candidate = candidate.slice(protocolIndex + 1);
  }
  const match = /^(file|link|workspace):(.*)$/u.exec(candidate);
  if (!match) return null;
  let body;
  try {
    body = decodeURIComponent(match[2]);
  } catch {
    return { protocol: match[1], invalid: true, body: match[2] };
  }
  return { protocol: match[1], invalid: body.includes('\\'), body };
}

async function isContainedExistingPath(kitRoot, manifestDirectory, reference) {
  if (reference.invalid || path.isAbsolute(reference.body)) return false;
  const target = path.resolve(manifestDirectory, reference.body);
  const lexical = path.relative(kitRoot, target);
  if (lexical.startsWith('..') || path.isAbsolute(lexical)) return false;
  if (!await exists(target)) return false;
  const [realKitRoot, realTarget] = await Promise.all([realpath(kitRoot), realpath(target)]);
  const physical = path.relative(realKitRoot, realTarget);
  return !physical.startsWith('..') && !path.isAbsolute(physical);
}

async function auditDependencies({ repositoryRoot, kit, packageOwners, errors }) {
  const manifests = await walk(kit.directory, (file, entry) =>
    entry.isFile() && path.basename(file) === 'package.json');
  for (const manifestPath of manifests) {
    const manifest = await readJson(manifestPath).catch(() => null);
    if (!manifest) continue;
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
      for (const [name, value] of Object.entries(dependencies)) {
        if (typeof value !== 'string') continue;
        const owners = packageOwners.get(name);
        const reference = decodeLocalReference(value);
        let valid = true;
        if (owners && !owners.has(kit.slug)) valid = false;
        if (reference?.protocol === 'workspace') valid = owners?.has(kit.slug) === true;
        else if (reference) valid = await isContainedExistingPath(kit.directory, path.dirname(manifestPath), reference);
        if (!valid) {
          errors.push(error(
            'KIT_LOCAL_DEPENDENCY_ESCAPE', repositoryRoot, manifestPath,
            `${field}.${name} does not resolve inside kits/${kit.slug}`,
          ));
        }
      }
    }
  }
}

function frameworkFile(repositoryRoot, file) {
  const name = relative(repositoryRoot, file);
  if (name === 'scripts/lib/kit-architecture-boundary.test.mjs') return false;
  if (name.startsWith('registry/')) return false;
  if (name.startsWith('kits/')) return false;
  if (name.startsWith('docs/')) return false;
  return name.startsWith('packages/') || name.startsWith('plugins/') || name.startsWith('scripts/');
}

function environmentName(node) {
  if (ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'process'
    && node.expression.name.text === 'env') return node.name.text;
  if (ts.isElementAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'process'
    && node.expression.name.text === 'env'
    && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

function exactIdentity(node, identities) {
  return ts.isStringLiteralLike(node) && identities.has(node.text) ? node.text : null;
}

function identifierTokens(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function hasKitIdentityToken(value) {
  return identifierTokens(value).some((token) =>
    ['kit', 'kits', 'product', 'products', 'builtin', 'builtins'].includes(token));
}

function semanticKitExpression(node) {
  const value = ts.isIdentifier(node)
    ? node.text
    : ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : '';
  return hasKitIdentityToken(value);
}

function semanticPropertyName(node) {
  return (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
    && hasKitIdentityToken(node.text);
}

function frameworkIdentitySpecialCase(node, identities) {
  if (ts.isBinaryExpression(node)
    && [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(node.operatorToken.kind)) {
    const left = exactIdentity(node.left, identities);
    const right = exactIdentity(node.right, identities);
    if (left && semanticKitExpression(node.right)) return left;
    if (right && semanticKitExpression(node.left)) return right;
  }
  if (ts.isCaseClause(node) && exactIdentity(node.expression, identities)) {
    const switchStatement = node.parent?.parent;
    if (switchStatement && ts.isSwitchStatement(switchStatement)
      && semanticKitExpression(switchStatement.expression)) return node.expression.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && semanticKitExpression(node.name) && node.initializer) {
    return exactIdentity(node.initializer, identities);
  }
  if ((ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node))
    && semanticPropertyName(node.name) && node.initializer) {
    return exactIdentity(node.initializer, identities);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && semanticKitExpression(node.left)) {
    return exactIdentity(node.right, identities);
  }
  return null;
}

function semanticRegistryName(value) {
  const tokens = identifierTokens(value);
  if (!tokens.some((token) => ['kit', 'kits', 'product', 'products', 'builtin', 'builtins'].includes(token))) {
    return false;
  }
  if (tokens.some((token) => ['kits', 'products', 'builtins'].includes(token))) return true;
  return tokens.some((token) => [
    'descriptor', 'descriptors', 'map', 'set', 'list', 'registry', 'catalog', 'slug', 'slugs', 'id', 'ids',
  ].includes(token));
}

function staticKitCollection(node, identities, { testFile = false } = {}) {
  let name;
  let initializer;
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
    name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : null;
    initializer = node.initializer;
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    name = ts.isIdentifier(node.left)
      ? node.left.text
      : ts.isPropertyAccessExpression(node.left) ? node.left.name.text : null;
    initializer = node.right;
  }
  if (!name || !semanticRegistryName(name) || !initializer) return false;
  const collection = ts.isArrayLiteralExpression(initializer)
    || ts.isObjectLiteralExpression(initializer)
    || (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)
      && ['Map', 'Set'].includes(initializer.expression.text));
  if (!collection) return false;
  if (testFile) {
    if (!ts.isVariableDeclaration(node) && !ts.isPropertyDeclaration(node)) return false;
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionLike(current)) return false;
    }
  }
  let found = false;
  function visit(candidate) {
    if (ts.isStringLiteralLike(candidate)) {
      if (identities.has(candidate.text)) found = true;
    }
    if (ts.isPropertyAssignment(candidate)) {
      const propertyName = ts.isIdentifier(candidate.name) || ts.isStringLiteralLike(candidate.name)
        ? candidate.name.text
        : null;
      if (propertyName && identities.has(propertyName)) found = true;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(initializer);
  return found;
}

function envViolation(text, tokenToSlug) {
  for (const match of text.matchAll(/\bHARBORS_([A-Z0-9_]+)\b/gu)) {
    if (APPROVED_GENERIC_ENV.has(match[0])) continue;
    for (const [token, slug] of tokenToSlug) {
      if (match[1] === token || match[1].startsWith(`${token}_`)) return { env: match[0], slug };
    }
  }
  return null;
}

function textStaticRegistry(text, exactIdentities) {
  const hasIdentity = (value) => [...exactIdentities].some((identity) => {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?:^|[^a-zA-Z0-9_.-])${escaped}(?:$|[^a-zA-Z0-9_.-])`, 'u').test(value);
  });
  const lines = text.split(/\r?\n/u).map(stripUnquotedComment);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const yaml = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (yaml && semanticRegistryName(yaml[2])) {
      const indent = yaml[1].length;
      let block = yaml[3];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next].trim() === '') continue;
        const nextIndent = /^\s*/u.exec(lines[next])[0].length;
        if (nextIndent <= indent) break;
        block += `\n${lines[next]}`;
      }
      if (hasIdentity(block)) return true;
    }
    const shell = /^\s*([A-Za-z_][A-Za-z0-9_]*)=\((.*)$/u.exec(line);
    if (shell && semanticRegistryName(shell[1])) {
      let block = shell[2];
      while (!block.includes(')') && index + 1 < lines.length) block += `\n${lines[++index]}`;
      if (hasIdentity(block)) return true;
    }
  }
  return false;
}

function stripUnquotedComment(line) {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single && line[index - 1] !== '\\') double = !double;
    else if (char === '#' && !single && !double) return line.slice(0, index);
  }
  return line;
}

async function auditFrameworkText({ repositoryRoot, identities, tokenToSlug, exactIdentities, errors }) {
  const candidates = [path.join(repositoryRoot, '.github', 'workflows'), path.join(repositoryRoot, 'scripts')];
  const files = [];
  for (const directory of candidates) {
    await walk(directory, (file) => /\.(?:ya?ml|sh)$/u.test(file), files);
  }
  const packageFiles = [path.join(repositoryRoot, 'package.json')];
  for (const directory of ['packages', 'plugins']) {
    await walk(path.join(repositoryRoot, directory), (file) => path.basename(file) === 'package.json', packageFiles);
  }
  for (const file of [...files, ...packageFiles]) {
    if (!await exists(file)) continue;
    let text = await readFile(file, 'utf8');
    if (file.endsWith('package.json')) {
      const manifest = JSON.parse(text);
      text = JSON.stringify({ scripts: manifest.scripts ?? {}, config: manifest.config ?? {} });
    }
    const parsedText = text.split(/\r?\n/u).map(stripUnquotedComment).join('\n');
    const specialCase = envViolation(parsedText, tokenToSlug);
    if (specialCase) errors.push(error(
      'FRAMEWORK_KIT_SPECIAL_CASE', repositoryRoot, file,
      `Framework environment ${specialCase.env} names Kit ${specialCase.slug}`,
    ));
    if (textStaticRegistry(parsedText, exactIdentities)) errors.push(error(
      'STATIC_KIT_REGISTRY', repositoryRoot, file,
      'Framework orchestration contains a static Kit identity collection',
    ));
  }
}

async function auditFramework({ repositoryRoot, identities, errors }) {
  const tokenToSlug = new Map();
  for (const identity of identities) {
    tokenToSlug.set(identity.slug.toUpperCase().replaceAll('-', '_'), identity.slug);
  }
  const exactIdentities = new Set(identities.flatMap(({ slug, id }) => [slug, ...(id ? [id] : [])]));
  const textIdentities = exactIdentities;
  const roots = ['packages', 'plugins', 'scripts'].map((entry) => path.join(repositoryRoot, entry));
  const files = [];
  for (const root of roots) {
    await walk(root, (file) => SOURCE_EXTENSION.test(file) && frameworkFile(repositoryRoot, file), files);
  }
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    let specialCase = null;
    let identitySpecialCase = null;
    let staticRegistry = false;
    const production = !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
    function visit(node) {
      const env = environmentName(node);
      if (env && !APPROVED_GENERIC_ENV.has(env) && env.startsWith('HARBORS_')) {
        for (const [token, slug] of tokenToSlug) {
          if (env === `HARBORS_${token}` || env.startsWith(`HARBORS_${token}_`)) specialCase ??= { env, slug };
        }
      }
      if (production) identitySpecialCase ??= frameworkIdentitySpecialCase(node, exactIdentities);
      if (staticKitCollection(node, exactIdentities, { testFile: !production })) staticRegistry = true;
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (specialCase) errors.push(error(
      'FRAMEWORK_KIT_SPECIAL_CASE', repositoryRoot, file,
      `Framework environment ${specialCase.env} names Kit ${specialCase.slug}`,
    ));
    else if (identitySpecialCase) errors.push(error(
      'FRAMEWORK_KIT_SPECIAL_CASE', repositoryRoot, file,
      `Framework production logic special-cases Kit identity ${identitySpecialCase}`,
    ));
    if (staticRegistry) errors.push(error(
      'STATIC_KIT_REGISTRY', repositoryRoot, file,
      'Framework source contains a static Kit identity list',
    ));
  }
  await auditFrameworkText({
    repositoryRoot, identities, tokenToSlug, exactIdentities: textIdentities, errors,
  });
}

export async function auditKitArchitecture({ repositoryRoot, targetKit } = {}) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)
    || path.resolve(repositoryRoot) !== repositoryRoot
    || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(repositoryRoot)) {
    throw new Error('repositoryRoot must be a canonical absolute path');
  }
  const auditedSlugs = await listKitSlugs(repositoryRoot, targetKit);
  const allSlugs = targetKit === undefined ? auditedSlugs : await listKitSlugs(repositoryRoot);
  const [auditedKits, allIdentities] = await Promise.all([
    Promise.all(auditedSlugs.map((slug) => readKitIdentity(repositoryRoot, slug))),
    Promise.all(allSlugs.map((slug) => readKitIdentity(repositoryRoot, slug))),
  ]);
  const packageOwners = await collectPackageOwners(repositoryRoot, allSlugs);
  const errors = [];
  for (const kit of auditedKits) {
    const symbolicLinks = await walkSymlinks(kit.directory);
    for (const symbolicLink of symbolicLinks) errors.push(error(
      'KIT_LOCAL_DEPENDENCY_ESCAPE', repositoryRoot, symbolicLink,
      `Kit ${kit.slug} source and workspace trees must not contain symbolic links`,
    ));
    await auditImports({ repositoryRoot, kit, packageOwners, errors });
    await auditDependencies({ repositoryRoot, kit, packageOwners, errors });
    const lockfile = path.join(kit.directory, 'pnpm-lock.yaml');
    const lockStat = await lstat(lockfile).catch(() => null);
    if (!lockStat?.isFile() || lockStat.isSymbolicLink()) {
      errors.push(error('KIT_LOCK_MISSING', repositoryRoot, lockfile, `Kit ${kit.slug} has no regular lockfile`));
    }
  }
  if (targetKit === undefined) {
    await auditFramework({ repositoryRoot, identities: allIdentities, errors });
  }
  errors.sort(compareErrors);
  return Object.freeze({
    scope: targetKit ?? 'all',
    errors: Object.freeze(errors),
  });
}
