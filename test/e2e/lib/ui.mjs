/**
 * Browser drivers for the shipped DSH Web UI and the plugin's management page.
 *
 * All locators are semantic first (role/name, data-testid) and auto-wait; the
 * only polling here is for state the server derives asynchronously (2.5s
 * catalog polling in the page, MCP connection state on the Host).
 *
 * The UI locale is forced to zh-CN by the browser context so the copy the
 * assertions read matches the shipped Chinese locale deterministically.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sleep, waitFor } from './util.mjs';

const SIDEBAR_AUTOMATION = '自动化任务';
const SIDEBAR_MCP = /MCP\s*管理/;
const MODE_BUTTON = /标准模式|极简模式|PTC 模式|创造模式/;
const PRESET_LABELS = {
  standard: '标准模式',
  minimal: '极简模式',
  ptc: 'PTC 模式',
  cordis: '创造模式',
};

export const PRESET_IDS = Object.keys(PRESET_LABELS);

/**
 * Defensive recovery: close any plugin modal overlay left behind by a failed
 * interaction (the Modal component closes on Escape). Later steps call this
 * before clicking, so one failed dialog assertion cannot cascade into five
 * unrelated failures.
 */
export async function clearOverlays(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await page.locator('.mm-overlay').count()) === 0) return;
    await page.keyboard.press('Escape');
    await sleep(250);
  }
}

// ── app boot / first-run chrome ─────────────────────────────────────────────

/** Navigate to the authenticated URL and wait for the shell to render. */
export async function openApp(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('button', { name: '新建会话' }).first().waitFor({ state: 'visible', timeout: 60_000 });
  await dismissFirstRun(page);
}

/**
 * Dismiss the preview notice and the "get started" account dialog a fresh
 * profile shows once. Both are product onboarding, not plugin behaviour.
 */
export async function dismissFirstRun(page) {
  await sleep(800);
  const continueButton = page.getByRole('button', { name: /继续|Continue/ });
  if ((await continueButton.count()) > 0 && (await continueButton.first().isVisible().catch(() => false))) {
    await continueButton.first().click();
    await sleep(700);
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialog = page.locator('[role="dialog"]');
    if ((await dialog.count()) === 0) return;
    await page.keyboard.press('Escape');
    await sleep(350);
  }
  if ((await page.locator('[role="dialog"]').count()) > 0) {
    throw new Error('a first-run dialog could not be dismissed with Escape');
  }
}

async function workspaceChooser(page) {
  return page.getByText(/选择工作区|Choose workspace/);
}

/** Pick `<HOME>/workspace` in the directory-picker dialog when the composer asks for one. */
export async function ensureWorkspace(page) {
  const chooser = await workspaceChooser(page);
  if ((await chooser.count()) === 0) return false;
  await chooser.first().click({ force: true });
  await sleep(500);
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  const entry = dialog.getByText('workspace', { exact: true });
  await entry.first().waitFor({ state: 'visible', timeout: 15_000 });
  await entry.first().dblclick().catch(async () => {
    await entry.first().click();
  });
  await sleep(500);
  const openButton = dialog.getByRole('button', { name: /打开|Open/ });
  if ((await openButton.count()) > 0) {
    await openButton.first().click();
    await sleep(900);
  }
  await waitFor(async () => (await page.locator('[contenteditable="true"]').count()) > 0, {
    timeoutMs: 20_000,
    label: 'composer after workspace selection',
  });
  return true;
}

export async function waitForComposer(page) {
  await page.locator('[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 30_000 });
}

// ── sessions + presets ──────────────────────────────────────────────────────

/** Start a new session and make sure it has a workspace and composer. */
export async function startNewSession(page) {
  await clearOverlays(page);
  const button = page.getByRole('button', { name: '新建会话' }).first();
  await button.click();
  await sleep(1500);
  await ensureWorkspace(page);
  await waitForComposer(page);
  // A session restored from the sidebar can have a scrolling transcript; the
  // composer is the last contenteditable in both layouts.
  await page.locator('[contenteditable="true"]').last().click();
  await sleep(200);
}

/** Choose the agent preset for the current (not yet started) session. */
export async function selectPreset(page, presetId) {
  const label = PRESET_LABELS[presetId];
  if (label === undefined) throw new Error(`unknown preset id ${presetId}`);
  const modeButton = page.getByRole('button', { name: MODE_BUTTON }).first();
  await modeButton.waitFor({ state: 'visible', timeout: 20_000 });
  const before = (await modeButton.innerText()).trim();
  if (!before.includes(label)) {
    await modeButton.click();
    await sleep(400);
    const option = page.getByRole('menuitem', { name: new RegExp(label) }).first();
    await option.waitFor({ state: 'visible', timeout: 10_000 });
    await option.click();
    await sleep(600);
  }
  const after = (await page.getByRole('button', { name: MODE_BUTTON }).first().innerText()).trim();
  if (!after.includes(label)) throw new Error(`preset selector shows "${after}", expected "${label}"`);
  return after;
}

/** Type into the composer and send with Enter. */
export async function sendMessage(page, text) {
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.click();
  await sleep(150);
  await page.keyboard.type(text);
  await sleep(150);
  await page.keyboard.press('Enter');
  // The editor clears once the message is dispatched.
  await waitFor(async () => ((await editor.innerText().catch(() => '')) ?? '').trim() === '', {
    timeoutMs: 15_000,
    intervalMs: 150,
    label: 'composer to clear after send',
  });
}

/** Wait until the rendered page contains `text` (assistant answer / state copy). */
export async function waitForBodyText(page, text, { timeoutMs = 60_000 } = {}) {
  return waitFor(
    async () => {
      const body = await page.locator('body').innerText().catch(() => '');
      return body.includes(text) ? body : undefined;
    },
    { timeoutMs, intervalMs: 300, label: `body text ${JSON.stringify(text)}` },
  );
}

// ── sidebar ─────────────────────────────────────────────────────────────────

/**
 * Assert the plugin panel row sits immediately below 自动化任务.
 * Reads the real DOM order of the sidebar's panel-row buttons, so a wrong
 * `order` (e.g. 30) or a missing registration fails with evidence.
 */
export async function sidebarPanelOrder(page) {
  return page.evaluate(
    ({ automation, mcpPattern }) => {
      const mcpRegExp = new RegExp(mcpPattern);
      const text = (element) => (element.getAttribute('aria-label') || element.innerText || '').trim();
      const buttons = Array.from(document.querySelectorAll('button'));
      const automationButton = buttons.find((button) => text(button) === automation);
      const mcpButton = buttons.find((button) => mcpRegExp.test(text(button)));
      const container = automationButton?.parentElement;
      const rows = container === null || container === undefined ? [] : Array.from(container.querySelectorAll(':scope > button'));
      return {
        rows: rows.map((row) => text(row)).filter((label) => label !== ''),
        automationIndex: rows.indexOf(automationButton),
        mcpIndex: rows.indexOf(mcpButton),
        automationBox: automationButton === undefined ? null : automationButton.getBoundingClientRect().toJSON(),
        mcpBox: mcpButton === undefined ? null : mcpButton.getBoundingClientRect().toJSON(),
      };
    },
    { automation: SIDEBAR_AUTOMATION, mcpPattern: SIDEBAR_MCP.source },
  );
}

/** Click the plugin's sidebar entry and wait for the management page. */
export async function openMcpPage(page) {
  await page.getByRole('button', { name: SIDEBAR_MCP }).first().click();
  const list = page.locator('[data-testid="mcp-list"]');
  await list.waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('[data-testid="mcp-page"]').waitFor({ state: 'attached', timeout: 20_000 });
  return list;
}

// ── management page: cards ──────────────────────────────────────────────────

export function card(page, name) {
  return page.locator(`[data-testid="server-card"][data-server-name="${name}"]`);
}

export async function cardNames(page) {
  return page.locator('[data-testid="server-card"]').evaluateAll((cards) => cards.map((entry) => entry.getAttribute('data-server-name')));
}

export async function cardState(page, name) {
  const locator = card(page, name);
  await locator.waitFor({ state: 'attached', timeout: 20_000 });
  return locator.locator('[data-testid="status-dot"]').getAttribute('data-state');
}

export async function cardText(page, name) {
  return card(page, name).innerText();
}

/**
 * Visual icon state of one card: the server-icon <img> (loaded bytes via
 * naturalWidth) or the first-letter fallback element.
 */
export async function cardIcon(page, name) {
  const locator = card(page, name);
  const image = locator.locator('[data-testid="server-icon"]');
  const fallback = locator.locator('[data-testid="server-icon-fallback"], .mm-tileLetter');
  const imageCount = await image.count();
  const fallbackCount = await fallback.count();
  return {
    imageCount,
    fallbackCount,
    src: imageCount > 0 ? await image.first().getAttribute('src') : undefined,
    naturalWidth: imageCount > 0 ? await image.first().evaluate((element) => element.naturalWidth).catch(() => 0) : 0,
    complete: imageCount > 0 ? await image.first().evaluate((element) => element.complete).catch(() => false) : false,
    fallbackText: fallbackCount > 0 ? await fallback.first().innerText().catch(() => '') : undefined,
  };
}

/** Poll a card's derived status until it reaches one of `states`. */
export async function waitCardState(page, name, states, { timeoutMs = 30_000 } = {}) {
  const accepted = Array.isArray(states) ? states : [states];
  return waitFor(
    async () => {
      const state = await cardState(page, name);
      return accepted.includes(state) ? state : undefined;
    },
    { timeoutMs, intervalMs: 300, label: `card "${name}" state ${accepted.join('/')}` },
  );
}

export async function waitCardText(page, name, text, { timeoutMs = 30_000 } = {}) {
  return waitFor(
    async () => {
      const content = await cardText(page, name).catch(() => '');
      return content.includes(text) ? content : undefined;
    },
    { timeoutMs, intervalMs: 300, label: `card "${name}" to contain ${JSON.stringify(text)}` },
  );
}

async function openCardMenu(page, name, itemTestId) {
  await clearOverlays(page);
  const menu = card(page, name).locator('[data-testid="server-menu"]');
  await menu.click();
  const item = page.locator(`[data-testid="${itemTestId}"]`);
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  await item.click();
}

// ── management page: form ───────────────────────────────────────────────────

export async function openAddForm(page) {
  await clearOverlays(page);
  await page.locator('[data-testid="add-mcp"]').click();
  await page.locator('[data-testid="form-name"]').waitFor({ state: 'visible', timeout: 15_000 });
}

// ── management page: icon controls (0.2.0) ─────────────────────────────────

/** Assert the icon row exists and that the removed emoji palette is really gone. */
export async function formIconControls(page) {
  const preview = page.locator('[data-testid="icon-preview"]');
  const upload = page.locator('[data-testid="icon-upload"]');
  const file = page.locator('[data-testid="icon-file"]');
  const remove = page.locator('[data-testid="icon-remove"]');
  const emoji = page.locator('[data-testid*="emoji"], [class*="emoji"]');
  await preview.first().waitFor({ state: 'attached', timeout: 10_000 });
  const previewImage = preview.locator('img').first();
  const previewLetter = preview.locator('.mm-iconPreviewLetter').first();
  return {
    preview: await preview.count(),
    upload: await upload.count(),
    file: await file.count(),
    remove: await remove.count(),
    emoji: await emoji.count(),
    previewImageCount: await previewImage.count(),
    previewImageSrc: (await previewImage.getAttribute('src').catch(() => undefined)) ?? undefined,
    previewLetter: (await previewLetter.count()) > 0 ? (await previewLetter.innerText().catch(() => '')) ?? '' : undefined,
    accept: (await file.getAttribute('accept').catch(() => undefined)) ?? undefined,
  };
}

/** Pick a local file for the icon upload input. */
export async function chooseIconFile(page, path) {
  const input = page.locator('[data-testid="icon-file"]');
  await input.waitFor({ state: 'attached', timeout: 10_000 });
  await input.setInputFiles(path);
  await sleep(400);
}

/** Click 恢复自动 (icon-remove) if present. */
export async function resetIconToAuto(page) {
  const button = page.locator('[data-testid="icon-remove"]');
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
  await sleep(500);
}

export async function formValues(page) {
  const read = async (testId) => {
    const locator = page.locator(`[data-testid="${testId}"]`);
    return (await locator.count()) === 0 ? undefined : locator.first().inputValue().catch(() => undefined);
  };
  return {
    name: await read('form-name'),
    command: await read('form-command'),
    args: await read('form-args'),
    url: await read('form-url'),
    group: await read('form-group'),
  };
}

/**
 * Fill the add/edit form from a server draft fragment.
 *
 * `presets` may be "all" or an array of preset ids; preset checkboxes exist
 * only after the 指定预设 radio is selected.
 */
export async function fillServerForm(page, spec) {
  const testId = (id) => page.locator(`[data-testid="${id}"]`);
  await testId('form-name').waitFor({ state: 'visible', timeout: 15_000 });
  await testId('form-name').fill(spec.name);
  if (spec.group !== undefined && spec.group !== '') await testId('form-group').fill(spec.group);

  const transport = spec.transport ?? 'http';
  await testId(`form-transport-${transport}`).click();
  if (transport === 'stdio') {
    await testId('form-command').waitFor({ state: 'visible', timeout: 10_000 });
    await testId('form-command').fill(spec.command);
    await testId('form-args').fill((spec.args ?? []).join('\n'));
  } else {
    await testId('form-url').fill(spec.url);
  }

  const presets = spec.presets ?? 'all';
  if (presets === 'all') {
    await testId('preset-mode-all').check({ force: true });
    if (!(await testId('preset-mode-all').isChecked())) throw new Error('「全部预设」 radio did not stay checked');
  } else {
    await testId('preset-mode-specific').check({ force: true });
    for (const presetId of presets) {
      const checkbox = testId(`preset-checkbox-${presetId}`);
      await checkbox.waitFor({ state: 'attached', timeout: 10_000 });
      await checkbox.check({ force: true });
      if (!(await checkbox.isChecked())) throw new Error(`preset checkbox ${presetId} did not stay checked`);
    }
  }
  return formValues(page);
}

/** Close an open server form by saving it (used after icon-only actions). */
export async function closeFormIfOpen(page) {
  const form = page.locator('[data-testid="form-name"]');
  if ((await form.count()) === 0) return false;
  const save = page.locator('[data-testid="form-save"]');
  if ((await save.count()) > 0) await save.click();
  await waitFor(async () => (await page.locator('[data-testid="form-name"]').count()) === 0, {
    timeoutMs: 20_000,
    label: 'form to close',
  });
  return true;
}

export async function saveForm(page, { expectError = false } = {}) {
  await page.locator('[data-testid="form-save"]').click();
  if (expectError) {
    await sleep(1000);
    return;
  }
  await waitFor(async () => (await page.locator('[data-testid="form-name"]').count()) === 0, {
    timeoutMs: 20_000,
    label: 'form to close after save',
  });
}

export async function editServer(page, name) {
  await openCardMenu(page, name, 'menu-edit');
  await page.locator('[data-testid="form-name"]').waitFor({ state: 'visible', timeout: 15_000 });
  await waitFor(async () => (await page.locator('[data-testid="form-name"]').inputValue()) === name, {
    timeoutMs: 10_000,
    label: `edit form for ${name}`,
  });
}

export async function updateUrl(page, url) {
  const field = page.locator('[data-testid="form-url"]');
  await field.waitFor({ state: 'visible', timeout: 10_000 });
  await field.fill(url);
}

export async function toggleServer(page, name) {
  await openCardMenu(page, name, 'menu-toggle');
}

export async function deleteServerViaCard(page, name) {
  await openCardMenu(page, name, 'menu-delete');
  const confirm = page.locator('[data-testid="confirm-dialog"]');
  await confirm.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-testid="confirm-delete"]').click();
  await waitFor(async () => (await card(page, name).count()) === 0, {
    timeoutMs: 20_000,
    label: `card "${name}" to disappear after delete`,
  });
}

// ── management page: error detail / test dialogs ────────────────────────────

export async function openErrorDetail(page, name) {
  const link = card(page, name).locator('[data-testid="detail-error"]');
  await link.waitFor({ state: 'visible', timeout: 20_000 });
  await link.click();
  const dialog = page.locator('[data-testid="error-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const text = await dialog.innerText();
  return {
    dialog,
    text,
    close: async () => {
      await page.locator('[data-testid="error-dialog-close"]').click();
      await dialog.waitFor({ state: 'detached', timeout: 10_000 });
    },
  };
}

/**
 * Open 测试连接 from the card menu and read the test-result dialog. Unlike the
 * live card (which the contract renders as 重连中 while a retry is scheduled),
 * this dialog shows the literal 连接失败 for a failing connection.
 */
export async function testServerViaCard(page, name) {
  await openCardMenu(page, name, 'menu-test');
  const dialog = page.locator('[data-testid="test-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await waitFor(
    async () => {
      const text = await dialog.innerText().catch(() => '');
      return /连接失败|连接成功/.test(text) ? text : undefined;
    },
    { timeoutMs: 40_000, intervalMs: 250, label: 'test-result dialog' },
  );
  return {
    dialog,
    text: await dialog.innerText(),
    close: async () => {
      // Two buttons are named 关闭 (header icon + footer); target the icon by role=button with the label.
      await dialog.locator('button[aria-label="关闭"]').click();
      if ((await dialog.count()) > 0) await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 10_000 });
    },
  };
}

// ── screenshots ─────────────────────────────────────────────────────────────

/** Dismiss the page-level 已保存/error banners so docs screenshots stay clean. */
export async function dismissBanners(page) {
  const dismiss = page.locator('.mm-bannerDismiss');
  const count = await dismiss.count();
  for (let index = 0; index < count; index += 1) {
    await dismiss.nth(index).click().catch(() => {});
  }
  await sleep(150);
}

/**
 * Element screenshot with parents' directories created. `maxHeight` crops tall
 * elements (used for the error dialog so the host-verbatim stack trace with
 * local absolute paths stays out of the published docs image).
 */
export async function screenshotElement(locator, path, { maxHeight } = {}) {
  await mkdir(dirname(path), { recursive: true });
  if (maxHeight === undefined) {
    await locator.screenshot({ path, animations: 'disabled' });
    return path;
  }
  const box = await locator.boundingBox();
  if (box === null) throw new Error('element is not visible for screenshoting');
  await locator.page().screenshot({
    path,
    animations: 'disabled',
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, maxHeight) },
  });
  return path;
}

/** Screenshot the basic section of the server form (icon row: preview, upload, 恢复自动, colors). */
export async function screenshotIconSection(page, path) {
  const section = page
    .locator('section.mm-section')
    .filter({ has: page.locator('[data-testid="form-icon"]') })
    .first();
  await section.waitFor({ state: 'visible', timeout: 10_000 });
  return screenshotElement(section, path);
}

/** Screenshot the 预设暴露 section of the server form (preset selection is the point). */
export async function screenshotPresetSection(page, path) {
  const section = page
    .locator('section.mm-section')
    .filter({ has: page.getByRole('heading', { name: '预设暴露' }) })
    .first();
  await section.waitFor({ state: 'visible', timeout: 10_000 });
  return screenshotElement(section, path);
}

/** Screenshot the management page surface (sidebar excluded: no session chrome). */
export async function screenshotPageSurface(page, path) {
  return screenshotElement(page.locator('[data-testid="mcp-page"]'), path);
}

/** Full-viewport screenshot, including the app sidebar with 自动化任务 above MCP 管理. */
export async function screenshotViewport(page, path) {
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, animations: 'disabled' });
  return path;
}
