import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDirectory, '..', 'server.mjs');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0SAAAAABJRU5ErkJggg==';
const FIXTURE_AUTH = '{"fixtureAuthentication":true}\n';
const FIXTURE_CONFIG = 'fixture_mode = true\n';
const FIXTURE_IMAGEGEN_SKILL = '# Fixture-only image generation skill\n';
const FIXTURE_PROFILE = Object.freeze({
  schemaVersion: 1,
  projectName: 'Fixture Airside',
  artDirection: 'Fixture art direction: crisp readable airport operations forms with restrained color and lighting.',
  generatedAssetRoot: 'Assets/FixtureAirport/Art/Generated',
  categories: ['operations', 'fleet', 'service', 'facility', 'branding'],
});
const V3_TOOL_NAMES = Object.freeze([
  'build_brand_mark_brief',
  'generate_brand_mark',
  'build_banner_brief',
  'generate_banner',
  'build_texture_brief',
  'generate_texture',
  'build_asset_style_set_brief',
  'generate_asset_style_set',
  'build_asset_style_extension_brief',
  'generate_asset_style_extension',
  'list_asset_style_sets',
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeFixtureProfile(projectRoot) {
  const profilePath = path.join(projectRoot, '.omp', 'icon-forge', 'project.json');
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await fs.writeFile(profilePath, `${JSON.stringify(FIXTURE_PROFILE, null, 2)}\n`, 'utf8');
}

async function writeFixtureCodexHome(baseCodexHome) {
  const imagegenSkillPath = path.join(baseCodexHome, 'skills', 'imagegen', 'SKILL.md');
  await fs.mkdir(path.dirname(imagegenSkillPath), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(baseCodexHome, 'auth.json'), FIXTURE_AUTH, { encoding: 'utf8', mode: 0o600 }),
    fs.writeFile(path.join(baseCodexHome, 'config.toml'), FIXTURE_CONFIG, { encoding: 'utf8', mode: 0o600 }),
    fs.writeFile(imagegenSkillPath, FIXTURE_IMAGEGEN_SKILL, { encoding: 'utf8', mode: 0o600 }),
  ]);
}

async function writeFakeCodexCli(
  fakeCodexPath,
  { baseCodexHome, recordDirectory, firstExecDelayMs, laterExecDelayMs },
) {
  const source = `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const minimalPng = Buffer.from(${JSON.stringify(MINIMAL_PNG_BASE64)}, 'base64');
const baseCodexHome = ${JSON.stringify(baseCodexHome)};
const jobsRoot = path.resolve(baseCodexHome, '.icon-forge-v3', 'jobs');
const recordDirectory = ${JSON.stringify(recordDirectory)};
const firstExecDelayMs = ${JSON.stringify(firstExecDelayMs)};
const laterExecDelayMs = ${JSON.stringify(laterExecDelayMs)};
const fixtureAuth = ${JSON.stringify(FIXTURE_AUTH)};
const fixtureConfig = ${JSON.stringify(FIXTURE_CONFIG)};
const fixtureImagegenSkill = ${JSON.stringify(FIXTURE_IMAGEGEN_SKILL)};

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeEvent(event, details) {
  const record = { event, at: Date.now(), ...details };
  const destination = path.join(recordDirectory, String(record.at) + '-' + process.pid + '-' + randomUUID() + '.json');
  const temporary = destination + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, destination);
}

async function verifyPrivateCodexHome() {
  const codexHome = process.env.CODEX_HOME;
  if (typeof codexHome !== 'string' || codexHome === '') {
    throw new Error('The fake Codex executable requires CODEX_HOME.');
  }
  const resolvedHome = path.resolve(codexHome);
  if (!isPathInside(jobsRoot, resolvedHome)) {
    throw new Error('Codex did not receive an isolated private job home.');
  }

  const [auth, config, imagegenSkill] = await Promise.all([
    fs.readFile(path.join(resolvedHome, 'auth.json'), 'utf8'),
    fs.readFile(path.join(resolvedHome, 'config.toml'), 'utf8'),
    fs.readFile(path.join(resolvedHome, 'skills', 'imagegen', 'SKILL.md'), 'utf8'),
  ]);
  if (auth !== fixtureAuth || config !== fixtureConfig || imagegenSkill !== fixtureImagegenSkill) {
    throw new Error('The private job home did not receive the fixture authentication/configuration resources.');
  }
  return resolvedHome;
}

function requiredOption(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  if (index === -1 || index === argumentsList.length - 1 || argumentsList[index + 1] === '') {
    throw new Error('Missing required fake Codex option ' + option + '.');
  }
  return argumentsList[index + 1];
}

async function selectExecDelay() {
  const claimPath = path.join(recordDirectory, 'first-exec-delay.claim');
  try {
    await fs.writeFile(claimPath, 'claimed\\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return firstExecDelayMs;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return laterExecDelayMs;
    }
    throw error;
  }
}

async function main() {
  const [command, ...argumentsList] = process.argv.slice(2);
  const jobHome = await verifyPrivateCodexHome();

  if (command === 'login' && argumentsList.length === 1 && argumentsList[0] === 'status') {
    await writeEvent('login-status', { jobHome, privateResourcesVerified: true });
    process.stdout.write('Logged in with ChatGPT account.\\n');
    return;
  }

  if (command !== 'exec') {
    throw new Error('Unexpected fake Codex command: ' + String(command));
  }

  const finalMessagePath = requiredOption(argumentsList, '--output-last-message');
  const projectRoot = requiredOption(argumentsList, '-C');
  const imageIndex = argumentsList.indexOf('--image');
  const anchorImagePath = imageIndex === -1 ? null : argumentsList[imageIndex + 1];
  if (imageIndex !== -1 && (anchorImagePath === undefined || anchorImagePath === '')) {
    throw new Error('Expected --image to be followed by an anchor image path.');
  }
  if (!isPathInside(jobHome, path.resolve(finalMessagePath))) {
    throw new Error('The final message path escaped the private job home.');
  }
  const prompt = argumentsList.at(-1);
  if (typeof prompt !== 'string' || prompt === '') {
    throw new Error('Expected the final fake Codex argument to be the image prompt.');
  }

  const delayMs = await selectExecDelay();
  const startedAt = Date.now();
  const eventDetails = {
    jobHome,
    privateResourcesVerified: true,
    argumentsList,
    projectRoot,
    finalMessagePath,
    anchorImagePath,
    prompt,
    delayMs,
    startedAt,
  };
  await writeEvent('exec-started', eventDetails);
  await wait(delayMs);

  const generatedImagesDirectory = path.join(jobHome, 'generated_images');
  const imagePath = path.join(generatedImagesDirectory, 'fixture-' + randomUUID() + '.png');
  await fs.mkdir(generatedImagesDirectory, { recursive: true });
  await fs.writeFile(finalMessagePath, 'Fixture Codex completed image generation.\\n', 'utf8');
  await fs.writeFile(imagePath, minimalPng);

  await writeEvent('exec-finished', {
    ...eventDetails,
    imagePath,
    finishedAt: Date.now(),
  });
  process.stdout.write('Created fixture image.\\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\\n');
  process.exitCode = 1;
});
`;

  await fs.writeFile(fakeCodexPath, source, { mode: 0o700 });
  await fs.chmod(fakeCodexPath, 0o700);
}

async function createFixture({ firstExecDelayMs = 150, laterExecDelayMs = 20 } = {}) {
  const fixtureRoot = await fs.mkdtemp(path.join(tmpdir(), 'project-airside-icon-forge-v3-test-'));
  const projectRoot = path.join(fixtureRoot, 'project');
  const baseCodexHome = path.join(fixtureRoot, 'fixture-codex-home');
  const recordDirectory = path.join(fixtureRoot, 'fake-codex-records');
  const fakeCodexPath = path.join(fixtureRoot, 'fake-codex.mjs');

  await Promise.all([
    fs.mkdir(projectRoot, { recursive: true }),
    fs.mkdir(baseCodexHome, { recursive: true }),
    fs.mkdir(recordDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFixtureProfile(projectRoot),
    writeFixtureCodexHome(baseCodexHome),
    writeFakeCodexCli(fakeCodexPath, {
      baseCodexHome,
      recordDirectory,
      firstExecDelayMs,
      laterExecDelayMs,
    }),
  ]);

  return { fixtureRoot, projectRoot, baseCodexHome, recordDirectory, fakeCodexPath };
}

function createProtocolClient(server) {
  const messages = [];
  const stdoutLines = [];
  const responseWaiters = new Set();
  let protocolFailure;
  let stderr = '';
  let stdoutRemainder = '';

  function failProtocol(message) {
    if (protocolFailure !== undefined) {
      return;
    }

    protocolFailure = new Error(message);
    for (const waiter of responseWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(protocolFailure);
    }
    responseWaiters.clear();
  }

  function receiveMessage(message) {
    messages.push(message);
    for (const waiter of [...responseWaiters]) {
      if (waiter.matches(message)) {
        responseWaiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
    }
  }

  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    stdoutRemainder += chunk;
    for (;;) {
      const newlineIndex = stdoutRemainder.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = stdoutRemainder.slice(0, newlineIndex);
      stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
      stdoutLines.push(line);
      try {
        if (line === '') {
          throw new Error('stdout emitted a blank line.');
        }
        const message = JSON.parse(line);
        if (message === null || typeof message !== 'object' || Array.isArray(message)) {
          throw new Error('stdout emitted a non-object JSON value.');
        }
        receiveMessage(message);
      } catch (error) {
        failProtocol(
          `stdout emitted non-protocol JSON: ${error instanceof Error ? error.message : String(error)}; line: ${JSON.stringify(line)}`,
        );
        return;
      }
    }
  });
  server.stdout.on('end', () => {
    if (stdoutRemainder !== '') {
      failProtocol(`stdout ended with an incomplete protocol line: ${JSON.stringify(stdoutRemainder)}`);
    }
  });
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  server.on('error', (error) => {
    failProtocol(`server process error: ${error.message}`);
  });
  server.on('close', () => {
    if (responseWaiters.size > 0) {
      failProtocol(`server closed before responding. stderr: ${stderr || '(empty)'}`);
    }
  });

  function waitForResponse(id, timeoutMs) {
    if (protocolFailure !== undefined) {
      return Promise.reject(protocolFailure);
    }

    const existing = messages.find((message) => hasOwn(message, 'id') && Object.is(message.id, id));
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        matches: (message) => hasOwn(message, 'id') && Object.is(message.id, id),
        reject,
        resolve,
        timeout: undefined,
      };
      waiter.timeout = setTimeout(() => {
        responseWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for response id ${JSON.stringify(id)}. stderr: ${stderr || '(empty)'}`));
      }, timeoutMs);
      responseWaiters.add(waiter);
    });
  }

  function send(message) {
    server.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    messages,
    request(id, method, params, timeoutMs = 15_000) {
      const response = waitForResponse(id, timeoutMs);
      const request = { jsonrpc: '2.0', id, method };
      if (params !== undefined) {
        request.params = params;
      }
      send(request);
      return response;
    },
    notify(method, params) {
      const notification = { jsonrpc: '2.0', method };
      if (params !== undefined) {
        notification.params = params;
      }
      send(notification);
    },
    async expectSilence(milliseconds) {
      const messageCount = messages.length;
      await delay(milliseconds);
      assert.equal(messages.length, messageCount, 'notification unexpectedly produced a protocol response');
      assert.equal(protocolFailure, undefined, protocolFailure?.message);
    },
    assertParseableProtocolOutput() {
      assert.equal(protocolFailure, undefined, protocolFailure?.message);
      assert.equal(stdoutRemainder, '', 'stdout retained an incomplete protocol line');
      assert.ok(stdoutLines.length > 0, 'server produced no protocol output');
      assert.equal(messages.length, stdoutLines.length, 'every stdout line must decode to one protocol JSON message');
      for (const message of messages) {
        assert.equal(message.jsonrpc, '2.0', 'stdout JSON must be a JSON-RPC 2.0 protocol message');
      }
    },
  };
}

function startServer({
  projectRoot,
  baseCodexHome,
  fakeCodexPath,
  maxConcurrentGenerations = 2,
  timeoutMs = 10_000,
  slotWaitMs = 10_000,
}) {
  const server = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_BIN: fakeCodexPath,
      CODEX_HOME: baseCodexHome,
      ICON_FORGE_PROJECT_ROOT: projectRoot,
      ICON_FORGE_MAX_CONCURRENT_GENERATIONS: String(maxConcurrentGenerations),
      ICON_FORGE_SLOT_WAIT_MS: String(slotWaitMs),
      ICON_FORGE_TIMEOUT_MS: String(timeoutMs),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { server, client: createProtocolClient(server) };
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    return;
  }

  const closed = new Promise((resolve) => server.once('close', resolve));
  try {
    server.stdin.end();
  } catch {
    // The process may have exited between checking and closing stdin.
  }

  if (await Promise.race([closed.then(() => true), delay(2_000).then(() => false)])) {
    return;
  }

  try {
    server.kill('SIGTERM');
  } catch {
    return;
  }
  if (await Promise.race([closed.then(() => true), delay(2_000).then(() => false)])) {
    return;
  }

  try {
    server.kill('SIGKILL');
  } catch {
    // The server may have already exited.
  }
  await Promise.race([closed, delay(2_000)]);
}

function toolPayload(response) {
  assert.equal(hasOwn(response, 'error'), false, `JSON-RPC tool call failed: ${JSON.stringify(response.error)}`);
  assert.equal(response.result.isError, undefined, response.result.content?.[0]?.text);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, 'text');
  return JSON.parse(response.result.content[0].text);
}

function assertToolFailure(response, expectedMessage) {
  assert.equal(hasOwn(response, 'error'), false, `JSON-RPC transport failed: ${JSON.stringify(response.error)}`);
  assert.equal(response.result.isError, true, 'invalid tool arguments must return a tool error result');
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, 'text');
  assert.match(response.result.content[0].text, expectedMessage);
}

function resolveProjectRelativePath(projectRoot, relativePath) {
  assert.equal(path.isAbsolute(relativePath), false, 'output paths must be project-relative');
  assert.equal(path.win32.isAbsolute(relativePath), false, 'output paths must not be Windows-absolute');
  const absolutePath = path.resolve(projectRoot, ...relativePath.split('/'));
  assert.ok(isPathInside(projectRoot, absolutePath), 'output path must remain under the fixture project root');
  return absolutePath;
}

async function assertCopiedPng(projectRoot, relativePath) {
  const absolutePath = resolveProjectRelativePath(projectRoot, relativePath);
  const bytes = await fs.readFile(absolutePath);
  assert.deepEqual(
    bytes.subarray(0, PNG_SIGNATURE.length),
    PNG_SIGNATURE,
    `copied output ${relativePath} must preserve the PNG signature`,
  );
  return absolutePath;
}

async function assertFocusedAsset({
  projectRoot,
  generated,
  assetType,
  renderStyle,
  requestedAspectRatio,
  outputFolder,
  expectedOutputCount = 1,
}) {
  const outputDirectory = `${FIXTURE_PROFILE.generatedAssetRoot}/${outputFolder}`;
  assert.deepEqual(
    {
      projectName: generated.projectName,
      assetType: generated.assetType,
      renderStyle: generated.renderStyle,
      requestedAspectRatio: generated.requestedAspectRatio,
      outputDirectory: generated.outputDirectory,
    },
    {
      projectName: FIXTURE_PROFILE.projectName,
      assetType,
      renderStyle,
      requestedAspectRatio,
      outputDirectory,
    },
  );
  assert.equal(path.posix.dirname(generated.outputPath), outputDirectory);
  assert.equal(generated.sourceImage.format, 'png');
  assert.ok(generated.sourceImage.byteSize > PNG_SIGNATURE.length);

  const absoluteOutput = await assertCopiedPng(projectRoot, generated.outputPath);
  const outputFiles = await fs.readdir(path.join(projectRoot, ...outputDirectory.split('/')));
  assert.equal(outputFiles.length, expectedOutputCount, `expected ${expectedOutputCount} copied file(s) in ${outputDirectory}`);
  assert.ok(outputFiles.includes(path.posix.basename(generated.outputPath)), 'reported output must be present in its focused folder');
  return absoluteOutput;
}

async function readFakeEvents(recordDirectory) {
  const entries = await fs.readdir(recordDirectory);
  const events = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.json'))
      .map(async (entry) => readJson(path.join(recordDirectory, entry))),
  );
  return events.sort((left, right) => left.at - right.at || left.event.localeCompare(right.event));
}

async function waitForFakeEvents(recordDirectory, predicate, minimumCount, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const matching = (await readFakeEvents(recordDirectory)).filter(predicate);
    if (matching.length >= minimumCount) {
      return matching;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${minimumCount} matching fake Codex event(s).`);
    }
    await delay(25);
  }
}

async function assertPrivateSpoolCleaned(baseCodexHome) {
  const spoolRoot = path.join(baseCodexHome, '.icon-forge-v3');
  const jobs = await fs.readdir(path.join(spoolRoot, 'jobs'));
  const slots = await fs.readdir(path.join(spoolRoot, 'slots'));
  assert.deepEqual(jobs, [], 'every private Codex job home must be removed after generation');
  assert.deepEqual(slots, [], 'every global generation slot directory must be released after generation');
  assert.equal(
    await pathExists(path.join(baseCodexHome, 'generated_images')),
    false,
    'the fixture base CODEX_HOME must never receive generated images',
  );
}

async function assertPrivateJobEventsCleaned(baseCodexHome, recordDirectory) {
  const jobsRoot = path.join(baseCodexHome, '.icon-forge-v3', 'jobs');
  const privateEvents = (await readFakeEvents(recordDirectory)).filter(
    (event) => event.event === 'login-status' || event.event === 'exec-started' || event.event === 'exec-finished',
  );
  assert.ok(privateEvents.length > 0, 'the fake Codex executable must record private worker use');
  for (const event of privateEvents) {
    assert.equal(event.privateResourcesVerified, true, 'fixture credentials and imagegen resources must be copied to each job home');
    assert.ok(isPathInside(jobsRoot, event.jobHome), `fake Codex received non-private CODEX_HOME: ${event.jobHome}`);
    assert.equal(await pathExists(event.jobHome), false, `private job home was not removed: ${event.jobHome}`);
  }
}

test('Icon Forge V3 exposes typed style sets, persists manifests, and keeps stdout protocol-pure', { timeout: 30_000 }, async () => {
  const fixture = await createFixture();
  let server;
  let client;

  try {
    ({ server, client } = startServer({
      projectRoot: fixture.projectRoot,
      baseCodexHome: fixture.baseCodexHome,
      fakeCodexPath: fixture.fakeCodexPath,
    }));

    const initialized = await client.request(0, 'initialize', {
      capabilities: {},
      clientInfo: { name: 'icon-forge-v3-regression-test', version: '3.0.0' },
      protocolVersion: '2025-03-26',
    });
    assert.equal(initialized.id, 0, 'numeric JSON-RPC ID 0 must be preserved');
    assert.equal(hasOwn(initialized, 'error'), false, JSON.stringify(initialized.error));
    assert.equal(initialized.result.protocolVersion, '2025-03-26');
    assert.deepEqual(initialized.result.capabilities, { tools: {} });

    client.notify('notifications/initialized');
    await client.expectSilence(100);

    const toolsListed = await client.request('', 'tools/list');
    assert.equal(toolsListed.id, '', 'empty-string JSON-RPC IDs must be preserved');
    assert.equal(hasOwn(toolsListed, 'error'), false, JSON.stringify(toolsListed.error));
    const toolNames = toolsListed.result.tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, V3_TOOL_NAMES, 'tools/list must expose exactly the V3 focused and style-set tools');
    for (const legacyHudTool of ['build_hud_icon_brief', 'generate_hud_icon', 'build_icon_brief', 'generate_icon']) {
      assert.equal(toolNames.includes(legacyHudTool), false, `${legacyHudTool} must not remain publicly exposed`);
    }

    const styleSetArguments = {
      styleSetId: 'airside-hud',
      assetType: 'hud_icon',
      renderStyle: 'flat_2d',
      background: 'transparent',
      palette: 'fixture cyan, safety yellow, and charcoal',
      items: [
        {
          itemId: 'pushback-tug',
          category: 'fleet',
          description: 'A compact pushback tug with a dominant centered silhouette.',
          variant: 'front-three-quarter',
        },
        {
          itemId: 'jet-bridge',
          category: 'operations',
          description: 'A passenger jet bridge ready to dock at a gate.',
          variant: 'gate-ready',
        },
      ],
    };
    const styleOutputDirectory = `${FIXTURE_PROFILE.generatedAssetRoot}/StyleSets/${styleSetArguments.styleSetId}`;
    const manifestPath = path.join(
      fixture.projectRoot,
      '.omp',
      'icon-forge',
      'styles',
      `${styleSetArguments.styleSetId}.json`,
    );

    const styleBrief = toolPayload(
      await client.request(1, 'tools/call', {
        name: 'build_asset_style_set_brief',
        arguments: styleSetArguments,
      }),
    );
    assert.deepEqual(
      {
        styleSetId: styleBrief.styleSetId,
        assetType: styleBrief.assetType,
        renderStyle: styleBrief.renderStyle,
        requestedAspectRatio: styleBrief.requestedAspectRatio,
        lockedPalette: styleBrief.lockedPalette,
        lockedBackground: styleBrief.lockedBackground,
        outputDirectory: styleBrief.outputDirectory,
      },
      {
        styleSetId: 'airside-hud',
        assetType: 'hud_icon',
        renderStyle: 'flat_2d',
        requestedAspectRatio: '1:1',
        lockedPalette: styleSetArguments.palette,
        lockedBackground: 'transparent',
        outputDirectory: styleOutputDirectory,
      },
    );
    assert.equal(styleBrief.items.length, 2);
    assert.equal(styleBrief.items[0].usesAnchor, false);
    assert.equal(styleBrief.items[1].usesAnchor, true);
    assert.match(styleBrief.items[0].prompt, /Fixture Airside/);
    assert.match(styleBrief.items[0].prompt, /Fixture art direction: crisp readable airport operations forms/);
    assert.match(styleBrief.items[1].prompt, /locked visual family/);
    assert.match(styleBrief.items[1].prompt, /attached anchor image/);

    const generatedStyleSetPromise = client.request(2, 'tools/call', {
      name: 'generate_asset_style_set',
      arguments: styleSetArguments,
    });
    await waitForFakeEvents(fixture.recordDirectory, (event) => event.event === 'exec-started', 1);
    assert.equal(await pathExists(manifestPath), false, 'a style manifest must not appear before the whole set is generated');

    const generatedStyleSet = toolPayload(await generatedStyleSetPromise);
    assert.deepEqual(
      {
        styleSetId: generatedStyleSet.styleSetId,
        assetType: generatedStyleSet.assetType,
        renderStyle: generatedStyleSet.renderStyle,
        requestedAspectRatio: generatedStyleSet.requestedAspectRatio,
        lockedPalette: generatedStyleSet.lockedPalette,
        lockedBackground: generatedStyleSet.lockedBackground,
        revision: generatedStyleSet.revision,
      },
      {
        styleSetId: 'airside-hud',
        assetType: 'hud_icon',
        renderStyle: 'flat_2d',
        requestedAspectRatio: '1:1',
        lockedPalette: styleSetArguments.palette,
        lockedBackground: 'transparent',
        revision: 1,
      },
    );
    assert.equal(generatedStyleSet.items.length, 2);
    assert.equal(generatedStyleSet.items[0].usesAnchor, false);
    assert.equal(generatedStyleSet.items[1].usesAnchor, true);
    assert.equal(generatedStyleSet.anchorAssetPath, generatedStyleSet.items[0].outputPath);
    for (const item of generatedStyleSet.items) {
      assert.equal(path.posix.dirname(item.outputPath), styleOutputDirectory);
      await assertCopiedPng(fixture.projectRoot, item.outputPath);
    }

    const initialManifest = await readJson(manifestPath);
    assert.deepEqual(initialManifest.profile, FIXTURE_PROFILE, 'the persisted manifest must snapshot the fixture profile');
    assert.equal(initialManifest.schemaVersion, 1);
    assert.equal(initialManifest.revision, 1);
    assert.equal(initialManifest.anchorAssetPath, generatedStyleSet.items[0].outputPath);
    assert.equal(initialManifest.assetType, 'hud_icon');
    assert.equal(initialManifest.renderStyle, 'flat_2d');
    assert.equal(initialManifest.lockedBackground, 'transparent');
    assert.equal(initialManifest.lockedPalette, styleSetArguments.palette);
    assert.deepEqual(initialManifest.items.map((item) => item.itemId), ['pushback-tug', 'jet-bridge']);
    const manifestDirectoryEntries = await fs.readdir(path.dirname(manifestPath));
    assert.deepEqual(manifestDirectoryEntries, ['airside-hud.json'], 'only the final atomic manifest may remain');

    const styleExecEvents = (await readFakeEvents(fixture.recordDirectory)).filter(
      (event) => event.event === 'exec-finished' && event.prompt.includes('"styleSetId": "airside-hud"'),
    );
    assert.equal(styleExecEvents.length, 2, 'the two-item style set must make two sequential fake image requests');
    assert.equal(styleExecEvents[0].anchorImagePath, null, 'the first style item establishes the anchor without an input image');
    const anchorAbsolutePath = resolveProjectRelativePath(fixture.projectRoot, generatedStyleSet.anchorAssetPath);
    assert.equal(styleExecEvents[1].anchorImagePath, anchorAbsolutePath, 'the second style item must receive the first copied asset as --image');
    assert.ok(
      styleExecEvents[1].startedAt >= styleExecEvents[0].finishedAt,
      'style-set image generation must be serial so the second item can use the first anchor',
    );

    const extensionArguments = {
      styleSetId: 'airside-hud',
      item: {
        itemId: 'fuel-truck',
        category: 'service',
        description: 'A compact airport fuel truck with a readable side silhouette.',
        variant: 'service-lane',
      },
    };
    const extensionBrief = toolPayload(
      await client.request(3, 'tools/call', {
        name: 'build_asset_style_extension_brief',
        arguments: extensionArguments,
      }),
    );
    assert.equal(extensionBrief.assetType, 'hud_icon');
    assert.equal(extensionBrief.renderStyle, 'flat_2d');
    assert.equal(extensionBrief.lockedBackground, 'transparent');
    assert.equal(extensionBrief.lockedPalette, styleSetArguments.palette);
    assert.equal(extensionBrief.revision, 1);
    assert.equal(extensionBrief.item.usesAnchor, true);
    assert.match(extensionBrief.item.prompt, /locked visual family/);
    assert.match(extensionBrief.item.prompt, /attached anchor image/);

    assertToolFailure(
      await client.request(4, 'tools/call', {
        name: 'build_asset_style_extension_brief',
        arguments: {
          ...extensionArguments,
          assetType: 'banner',
          renderStyle: 'stylized_3d',
        },
      }),
      /unexpected property "assetType"/,
    );
    assert.equal((await readJson(manifestPath)).revision, 1, 'an attempted type/style override must not change the manifest');

    const generatedExtensionPromise = client.request(5, 'tools/call', {
      name: 'generate_asset_style_extension',
      arguments: extensionArguments,
    });
    await waitForFakeEvents(fixture.recordDirectory, (event) => event.event === 'exec-started', 3);
    const manifestDuringExtension = await readJson(manifestPath);
    assert.equal(manifestDuringExtension.revision, 1, 'the existing manifest must remain whole until the extension is committed');
    assert.equal(manifestDuringExtension.items.length, 2);

    const generatedExtension = toolPayload(await generatedExtensionPromise);
    assert.equal(generatedExtension.styleSetId, 'airside-hud');
    assert.equal(generatedExtension.assetType, 'hud_icon');
    assert.equal(generatedExtension.renderStyle, 'flat_2d');
    assert.equal(generatedExtension.revision, 2);
    assert.equal(generatedExtension.items.length, 1);
    assert.equal(generatedExtension.items[0].itemId, 'fuel-truck');
    assert.equal(generatedExtension.items[0].usesAnchor, true);
    assert.equal(generatedExtension.anchorAssetPath, generatedStyleSet.anchorAssetPath);
    await assertCopiedPng(fixture.projectRoot, generatedExtension.items[0].outputPath);

    const extendedManifest = await readJson(manifestPath);
    assert.equal(extendedManifest.revision, 2, 'the extension must atomically replace the manifest with the next revision');
    assert.equal(extendedManifest.assetType, 'hud_icon');
    assert.equal(extendedManifest.renderStyle, 'flat_2d');
    assert.equal(extendedManifest.anchorAssetPath, generatedStyleSet.anchorAssetPath);
    assert.deepEqual(extendedManifest.items.map((item) => item.itemId), ['pushback-tug', 'jet-bridge', 'fuel-truck']);
    assert.deepEqual(await fs.readdir(path.dirname(manifestPath)), ['airside-hud.json']);

    const extensionExecEvents = (await readFakeEvents(fixture.recordDirectory)).filter(
      (event) => event.event === 'exec-finished' && event.prompt.includes('"itemId": "fuel-truck"'),
    );
    assert.equal(extensionExecEvents.length, 1);
    assert.equal(extensionExecEvents[0].anchorImagePath, anchorAbsolutePath, 'the extension must reuse the locked style-set anchor');

    const listedStyleSets = toolPayload(
      await client.request(6, 'tools/call', {
        name: 'list_asset_style_sets',
        arguments: { assetType: 'hud_icon' },
      }),
    );
    assert.equal(listedStyleSets.styleSets.length, 1);
    const listedStyleSet = listedStyleSets.styleSets[0];
    assert.deepEqual(
      {
        styleSetId: listedStyleSet.styleSetId,
        assetType: listedStyleSet.assetType,
        renderStyle: listedStyleSet.renderStyle,
        requestedAspectRatio: listedStyleSet.requestedAspectRatio,
        lockedPalette: listedStyleSet.lockedPalette,
        lockedBackground: listedStyleSet.lockedBackground,
        itemCount: listedStyleSet.itemCount,
        revision: listedStyleSet.revision,
      },
      {
        styleSetId: 'airside-hud',
        assetType: 'hud_icon',
        renderStyle: 'flat_2d',
        requestedAspectRatio: '1:1',
        lockedPalette: styleSetArguments.palette,
        lockedBackground: 'transparent',
        itemCount: 3,
        revision: 2,
      },
    );
    for (const unsafeDetail of ['profile', 'items', 'anchorAssetPath', 'outputPath']) {
      assert.equal(hasOwn(listedStyleSet, unsafeDetail), false, `style-set listing must not expose ${unsafeDetail}`);
    }
    assert.match(listedStyleSet.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(listedStyleSet.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const brandArguments = {
      category: 'branding',
      background: 'light',
      description: 'An original airport runway-and-horizon identity symbol.',
      palette: 'fixture blue and sunrise gold',
    };
    const brandBrief = toolPayload(
      await client.request(7, 'tools/call', {
        name: 'build_brand_mark_brief',
        arguments: brandArguments,
      }),
    );
    assert.equal(brandBrief.projectName, FIXTURE_PROFILE.projectName);
    assert.equal(brandBrief.outputDirectory, `${FIXTURE_PROFILE.generatedAssetRoot}/BrandMarks`);
    assert.match(brandBrief.prompt, /Fixture Airside/);
    assert.match(brandBrief.prompt, /Fixture art direction: crisp readable airport operations forms/);

    const brandGenerated = toolPayload(
      await client.request(8, 'tools/call', {
        name: 'generate_brand_mark',
        arguments: brandArguments,
      }),
    );
    await assertFocusedAsset({
      projectRoot: fixture.projectRoot,
      generated: brandGenerated,
      assetType: 'brand_mark',
      renderStyle: 'flat_2d',
      requestedAspectRatio: '1:1',
      outputFolder: 'BrandMarks',
    });

    const bannerGenerated = toolPayload(
      await client.request(9, 'tools/call', {
        name: 'generate_banner',
        arguments: {
          category: 'operations',
          background: 'dark',
          description: 'A dusk airport apron with an unobstructed operations title-safe area.',
          palette: 'indigo, amber, and runway-light white',
          renderStyle: 'stylized_3d',
        },
      }),
    );
    await assertFocusedAsset({
      projectRoot: fixture.projectRoot,
      generated: bannerGenerated,
      assetType: 'banner',
      renderStyle: 'stylized_3d',
      requestedAspectRatio: '16:9',
      outputFolder: 'Banners',
    });

    const textureGenerated = toolPayload(
      await client.request(10, 'tools/call', {
        name: 'generate_texture',
        arguments: {
          category: 'facility',
          background: 'light',
          description: 'A weathered, tileable concrete apron surface with restrained aggregate variation.',
          palette: 'warm concrete gray',
        },
      }),
    );
    await assertFocusedAsset({
      projectRoot: fixture.projectRoot,
      generated: textureGenerated,
      assetType: 'texture',
      renderStyle: 'flat_2d',
      requestedAspectRatio: '1:1',
      outputFolder: 'Textures',
    });

    await assertPrivateSpoolCleaned(fixture.baseCodexHome);
    await assertPrivateJobEventsCleaned(fixture.baseCodexHome, fixture.recordDirectory);
    client.assertParseableProtocolOutput();
  } finally {
    await stopServer(server);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('Icon Forge V3 waits beyond one minute for a shared cross-process generation slot', { timeout: 100_000 }, async () => {
  const fixture = await createFixture({
    firstExecDelayMs: 61_500,
    laterExecDelayMs: 25,
  });
  let firstServer;
  let secondServer;
  let firstClient;
  let secondClient;

  try {
    ({ server: firstServer, client: firstClient } = startServer({
      projectRoot: fixture.projectRoot,
      baseCodexHome: fixture.baseCodexHome,
      fakeCodexPath: fixture.fakeCodexPath,
      maxConcurrentGenerations: 1,
      timeoutMs: 120_000,
      slotWaitMs: 3_600_000,
    }));
    ({ server: secondServer, client: secondClient } = startServer({
      projectRoot: fixture.projectRoot,
      baseCodexHome: fixture.baseCodexHome,
      fakeCodexPath: fixture.fakeCodexPath,
      maxConcurrentGenerations: 1,
      timeoutMs: 120_000,
      slotWaitMs: 3_600_000,
    }));

    const initializeParams = {
      capabilities: {},
      clientInfo: { name: 'icon-forge-v3-slot-wait-test', version: '3.0.0' },
      protocolVersion: '2025-03-26',
    };
    const [firstInitialized, secondInitialized] = await Promise.all([
      firstClient.request(0, 'initialize', initializeParams),
      secondClient.request(0, 'initialize', initializeParams),
    ]);
    assert.equal(firstInitialized.id, 0);
    assert.equal(secondInitialized.id, 0);

    const firstGeneration = firstClient.request(
      1,
      'tools/call',
      {
        name: 'generate_brand_mark',
        arguments: {
          category: 'branding',
          background: 'light',
          description: 'A first queued fixture runway identity symbol.',
          variant: 'first-slot-holder',
        },
      },
      90_000,
    );
    await waitForFakeEvents(fixture.recordDirectory, (event) => event.event === 'exec-started', 1, 15_000);

    const secondRequestStartedAt = Date.now();
    const secondGeneration = secondClient.request(
      1,
      'tools/call',
      {
        name: 'generate_brand_mark',
        arguments: {
          category: 'branding',
          background: 'light',
          description: 'A second queued fixture runway identity symbol.',
          variant: 'second-slot-waiter',
        },
      },
      90_000,
    );

    const [firstGenerated, secondGenerated] = await Promise.all([
      firstGeneration.then(toolPayload),
      secondGeneration.then(toolPayload),
    ]);
    const secondCompletedAt = Date.now();

    await assertFocusedAsset({
      projectRoot: fixture.projectRoot,
      generated: firstGenerated,
      assetType: 'brand_mark',
      renderStyle: 'flat_2d',
      requestedAspectRatio: '1:1',
      outputFolder: 'BrandMarks',
      expectedOutputCount: 2,
    });
    await assertFocusedAsset({
      projectRoot: fixture.projectRoot,
      generated: secondGenerated,
      assetType: 'brand_mark',
      renderStyle: 'flat_2d',
      requestedAspectRatio: '1:1',
      outputFolder: 'BrandMarks',
      expectedOutputCount: 2,
    });
    assert.equal(firstGenerated.scheduling.maxConcurrentGenerations, 1);
    assert.equal(secondGenerated.scheduling.maxConcurrentGenerations, 1);
    assert.equal(firstGenerated.scheduling.slot, 1);
    assert.equal(secondGenerated.scheduling.slot, 1);
    assert.ok(
      secondGenerated.scheduling.queueWaitMs >= 59_000,
      `the second server must survive the former one-minute wait boundary; observed ${secondGenerated.scheduling.queueWaitMs} ms`,
    );
    assert.ok(
      secondCompletedAt - secondRequestStartedAt >= 59_000,
      'the second RPC must remain live while it waits for the first delayed process to release the shared slot',
    );

    const execFinishedEvents = (await readFakeEvents(fixture.recordDirectory)).filter(
      (event) => event.event === 'exec-finished',
    );
    assert.equal(execFinishedEvents.length, 2, 'each server process must complete exactly one fake image generation');
    assert.ok(
      execFinishedEvents[1].startedAt >= execFinishedEvents[0].finishedAt,
      'the second process must not start image generation until the first shared slot owner has finished',
    );
    assert.notEqual(
      execFinishedEvents[0].jobHome,
      execFinishedEvents[1].jobHome,
      'separate server processes must use separate private Codex homes',
    );

    await assertPrivateSpoolCleaned(fixture.baseCodexHome);
    await assertPrivateJobEventsCleaned(fixture.baseCodexHome, fixture.recordDirectory);
    firstClient.assertParseableProtocolOutput();
    secondClient.assertParseableProtocolOutput();
  } finally {
    await Promise.all([stopServer(firstServer), stopServer(secondServer)]);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('Icon Forge V3 overlaps independent cross-process generations at global capacity two', { timeout: 20_000 }, async () => {
  const fixture = await createFixture({
    firstExecDelayMs: 1_200,
    laterExecDelayMs: 1_200,
  });
  let firstServer;
  let secondServer;
  let firstClient;
  let secondClient;

  try {
    ({ server: firstServer, client: firstClient } = startServer({
      projectRoot: fixture.projectRoot,
      baseCodexHome: fixture.baseCodexHome,
      fakeCodexPath: fixture.fakeCodexPath,
      maxConcurrentGenerations: 2,
    }));
    ({ server: secondServer, client: secondClient } = startServer({
      projectRoot: fixture.projectRoot,
      baseCodexHome: fixture.baseCodexHome,
      fakeCodexPath: fixture.fakeCodexPath,
      maxConcurrentGenerations: 2,
    }));

    const initializeParams = {
      capabilities: {},
      clientInfo: { name: 'icon-forge-v3-capacity-two-overlap-test', version: '3.0.0' },
      protocolVersion: '2025-03-26',
    };
    const [firstInitialized, secondInitialized] = await Promise.all([
      firstClient.request(0, 'initialize', initializeParams),
      secondClient.request(0, 'initialize', initializeParams),
    ]);
    assert.equal(hasOwn(firstInitialized, 'error'), false, JSON.stringify(firstInitialized.error));
    assert.equal(hasOwn(secondInitialized, 'error'), false, JSON.stringify(secondInitialized.error));

    const bannerGeneration = firstClient.request(1, 'tools/call', {
      name: 'generate_banner',
      arguments: {
        category: 'operations',
        background: 'dark',
        description: 'A concurrent fixture dusk apron banner with a clear operations title-safe area.',
        palette: 'fixture indigo, amber, and runway-light white',
        renderStyle: 'stylized_3d',
      },
    });
    await waitForFakeEvents(fixture.recordDirectory, (event) => event.event === 'exec-started', 1, 10_000);

    const textureGeneration = secondClient.request(1, 'tools/call', {
      name: 'generate_texture',
      arguments: {
        category: 'facility',
        background: 'light',
        description: 'A concurrent fixture tileable concrete apron texture with restrained aggregate variation.',
        palette: 'fixture warm concrete gray',
      },
    });

    const [bannerGenerated, textureGenerated] = await Promise.all([
      bannerGeneration.then(toolPayload),
      textureGeneration.then(toolPayload),
    ]);
    const [bannerOutput, textureOutput] = await Promise.all([
      assertFocusedAsset({
        projectRoot: fixture.projectRoot,
        generated: bannerGenerated,
        assetType: 'banner',
        renderStyle: 'stylized_3d',
        requestedAspectRatio: '16:9',
        outputFolder: 'Banners',
      }),
      assertFocusedAsset({
        projectRoot: fixture.projectRoot,
        generated: textureGenerated,
        assetType: 'texture',
        renderStyle: 'flat_2d',
        requestedAspectRatio: '1:1',
        outputFolder: 'Textures',
      }),
    ]);
    assert.notEqual(bannerOutput, textureOutput, 'the two processes must copy distinct output files');
    assert.equal(bannerGenerated.scheduling.maxConcurrentGenerations, 2);
    assert.equal(textureGenerated.scheduling.maxConcurrentGenerations, 2);
    assert.deepEqual(
      [bannerGenerated.scheduling.slot, textureGenerated.scheduling.slot].sort((left, right) => left - right),
      [1, 2],
      'overlapping jobs must acquire the two configured global slots',
    );

    const execFinishedEvents = (await readFakeEvents(fixture.recordDirectory)).filter(
      (event) => event.event === 'exec-finished',
    );
    assert.equal(execFinishedEvents.length, 2, 'each independent server process must complete one fake image generation');
    assert.equal(await pathExists(fixture.recordDirectory), true, 'the fake Codex record directory must outlive disposable job homes');
    const jobHomes = new Set(execFinishedEvents.map((event) => event.jobHome));
    assert.equal(jobHomes.size, 2, 'each fake Codex process must receive a distinct effective CODEX_HOME');

    for (const event of execFinishedEvents) {
      assert.equal(event.privateResourcesVerified, true);
      assert.equal(typeof event.startedAt, 'number', 'the persistent fake-Codex record must include an execution start timestamp');
      assert.equal(typeof event.finishedAt, 'number', 'the persistent fake-Codex record must include an execution end timestamp');
      assert.ok(event.finishedAt >= event.startedAt, 'fake Codex execution end cannot precede its start');
      assert.equal(
        isPathInside(event.jobHome, fixture.recordDirectory),
        false,
        'persistent fake-Codex records must live outside disposable private CODEX_HOME paths',
      );
    }

    const latestStartedAt = Math.max(...execFinishedEvents.map((event) => event.startedAt));
    const earliestFinishedAt = Math.min(...execFinishedEvents.map((event) => event.finishedAt));
    const overlapMs = earliestFinishedAt - latestStartedAt;
    assert.ok(
      overlapMs > 0,
      `capacity two must produce a real positive execution overlap; observed ${overlapMs} ms`,
    );

    await assertPrivateSpoolCleaned(fixture.baseCodexHome);
    for (const jobHome of jobHomes) {
      assert.equal(await pathExists(jobHome), false, `private CODEX_HOME was not removed after generation: ${jobHome}`);
    }
    await assertPrivateJobEventsCleaned(fixture.baseCodexHome, fixture.recordDirectory);
    firstClient.assertParseableProtocolOutput();
    secondClient.assertParseableProtocolOutput();
  } finally {
    await Promise.all([stopServer(firstServer), stopServer(secondServer)]);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
