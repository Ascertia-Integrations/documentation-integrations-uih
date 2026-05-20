import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = resolve(rootDir, 'build');
const globalDataPath = resolve(rootDir, '.docusaurus/globalData.json');
const docsToPdfCliPath = resolve(rootDir, 'node_modules/docs-to-pdf/lib/cli.js');

const args = parseArgs(process.argv.slice(2));
const docsVersionSelector = args.version ?? process.env.DOCS_PDF_VERSION ?? 'current';
const requestedOutput = args.output ?? process.env.DOCS_PDF_OUTPUT;

await main();

async function main() {
  ensurePrerequisitesExist();

  const globalData = JSON.parse(await readFile(globalDataPath, 'utf8'));
  const docsData = globalData['docusaurus-plugin-content-docs']?.default;
  if (!docsData?.versions?.length) {
    throw new Error('Could not find Docusaurus docs metadata in .docusaurus/globalData.json.');
  }

  const docsVersion = selectVersion(docsData.versions, docsVersionSelector);
  const docsVersionLabel = docsVersion.label || docsVersion.name;
  const mainDocPath =
    docsVersion.docs?.find((doc) => doc.id === docsVersion.mainDocId)?.path ??
    docsVersion.path ??
    docsVersion.docs?.[0]?.path;

  if (!mainDocPath) {
    throw new Error(`Could not determine the entry document for docs version "${docsVersionLabel}".`);
  }

  const siteTitle = await inferSiteTitle(mainDocPath);
  const outputPath =
    requestedOutput ??
    resolve(buildDir, `${slugify(siteTitle)}-${slugify(docsVersion.name || docsVersionLabel)}.pdf`);
  const chromeExecutable = resolveChromeExecutable();

  console.log(`Preparing PDF export for docs version "${docsVersionLabel}".`);
  console.log(`Using entry page ${mainDocPath}`);
  console.log(`Using Chrome executable: ${chromeExecutable}`);
  console.log(`Writing PDF to ${outputPath}`);

  const cliArgs = [
    docsToPdfCliPath,
    'docusaurus',
    '--docsDir',
    buildDir,
    '--version',
    '3',
    '--initialDocURLs',
    `http://127.0.0.1:3000${mainDocPath}`,
    '--outputPDFFilename',
    outputPath,
    '--coverTitle',
    siteTitle,
    '--coverSub',
    `Version ${docsVersionLabel}`,
    '--tocTitle',
    'Contents',
    '--paperFormat',
    'A4',
    '--restrictPaths',
    '--puppeteerArgs',
    '--no-sandbox,--disable-setuid-sandbox',
  ];

  const result = spawnSync(process.execPath, cliArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || chromeExecutable,
    },
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    throw result.error;
  }
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--version' && argv[index + 1]) {
      parsed.version = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--version=')) {
      parsed.version = arg.slice('--version='.length);
      continue;
    }

    if (arg === '--output' && argv[index + 1]) {
      parsed.output = resolve(rootDir, argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--output=')) {
      parsed.output = resolve(rootDir, arg.slice('--output='.length));
    }
  }

  return parsed;
}

function ensurePrerequisitesExist() {
  if (!existsSync(buildDir)) {
    throw new Error('Missing build/ directory. Run `npm run build` first.');
  }

  if (!existsSync(globalDataPath)) {
    throw new Error('Missing .docusaurus/globalData.json. Run `npm run build` first.');
  }

  if (!existsSync(docsToPdfCliPath)) {
    throw new Error('Missing docs-to-pdf CLI. Run `npm install` first.');
  }
}

function selectVersion(versions, selector) {
  if (selector === 'latest') {
    const latest = versions.find((version) => version.isLast) ?? versions[versions.length - 1];
    if (latest) {
      return latest;
    }
  }

  const exactMatch = versions.find(
    (version) => version.name === selector || version.label === selector,
  );
  if (exactMatch) {
    return exactMatch;
  }

  if (selector === 'current') {
    const current = versions.find((version) => version.name === 'current');
    if (current) {
      return current;
    }
  }

  throw new Error(
    `Unknown docs version "${selector}". Available versions: ${versions
      .map((version) => version.name)
      .join(', ')}`,
  );
}

async function inferSiteTitle(mainDocPath) {
  const htmlPath = resolveBuildHtmlPath(mainDocPath);
  const html = await readFile(htmlPath, 'utf8');
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const rawTitle = titleMatch?.[1]?.trim();

  if (!rawTitle) {
    return 'Documentation';
  }

  return rawTitle.split('|').pop()?.trim() || rawTitle;
}

function resolveBuildHtmlPath(docPath) {
  const normalizedPath = docPath === '/' ? 'index.html' : `${docPath.replace(/^\/+/, '')}/index.html`;
  return resolve(buildDir, normalizedPath);
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const binary of ['google-chrome', 'chromium-browser', 'chromium']) {
    const result = spawnSync('which', [binary], {encoding: 'utf8'});
    if (result.status === 0) {
      const resolvedBinary = result.stdout.trim();
      if (resolvedBinary) {
        return resolvedBinary;
      }
    }
  }

  throw new Error(
    'Could not find a Chrome/Chromium executable. Set PUPPETEER_EXECUTABLE_PATH to a local browser binary.',
  );
}

function slugify(value) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}
