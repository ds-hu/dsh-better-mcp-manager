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
const SIDEBAR_NAV_LABEL = '全局面板';
const SETTINGS_TITLE = '设置';
const SETTINGS_TRIGGER = '设置';
// The shipped `web` template has no dsh-pocket launcher: ui-settings-account
// occupies the sidebar-foot `settings.launcher`/`sidebar.settings` seat with an
// account menu (labelled 账号菜单, showing 更多 while signed out), and 设置 is one
// of its menu items. A profile with a standalone Settings control still matches
// the direct button first.
const ACCOUNT_MENU_LABEL = '账号菜单';
const ACCOUNT_MENU_TRIGGER = /账号菜单|更多|More|Account/u;
const MODE_BUTTON = /标准模式|极简模式|PTC 模式|创造模式|外部MCP测试/;
const PRESET_LABELS = {
  standard: '标准模式',
  minimal: '极简模式',
  ptc: 'PTC 模式',
  cordis: '创造模式',
  external: '外部MCP测试',
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

/** The sidebar's global-panel navigation landmark (role/name, no shell classes). */
export function sidebarPanelNav(page) {
  return page.getByRole('navigation', { name: SIDEBAR_NAV_LABEL });
}

/** Whether the optional sidebar module's MCP 管理 row exists right now. */
export async function sidebarHasMcp(page) {
  const nav = sidebarPanelNav(page);
  if ((await nav.count()) === 0) return false;
  return (await nav.getByRole('button', { name: SIDEBAR_MCP }).count()) > 0;
}

/**
 * Assert the plugin panel row sits immediately below 自动化任务.
 * Reads the real DOM order of the sidebar's panel-row buttons, so a wrong
 * `order` (e.g. 30) or a missing registration fails with evidence. With the
 * optional module off the row legitimately does not exist: mcpIndex is -1 and
 * mcpBox is null.
 */
export async function sidebarPanelOrder(page) {
  return page.evaluate(
    ({ automation, mcpPattern, navLabel }) => {
      const mcpRegExp = new RegExp(mcpPattern);
      const text = (element) => (element.getAttribute('aria-label') || element.innerText || '').trim();
      const nav = Array.from(document.querySelectorAll('nav')).find((element) => element.getAttribute('aria-label') === navLabel);
      const rows = nav === undefined ? [] : Array.from(nav.querySelectorAll(':scope > button'));
      const automationButton = rows.find((button) => text(button) === automation);
      const mcpButton = rows.find((button) => mcpRegExp.test(text(button)));
      return {
        rows: rows.map((row) => text(row)).filter((label) => label !== ''),
        automationIndex: rows.indexOf(automationButton),
        mcpIndex: rows.indexOf(mcpButton),
        automationBox: automationButton === undefined ? null : automationButton.getBoundingClientRect().toJSON(),
        mcpBox: mcpButton === undefined ? null : mcpButton.getBoundingClientRect().toJSON(),
      };
    },
    { automation: SIDEBAR_AUTOMATION, mcpPattern: SIDEBAR_MCP.source, navLabel: SIDEBAR_NAV_LABEL },
  );
}

/** Click the plugin's sidebar entry (the optional module) and wait for the management page. */
export async function openMcpPage(page) {
  await sidebarPanelNav(page).getByRole('button', { name: SIDEBAR_MCP }).first().click();
  const list = page.locator('[data-testid="mcp-list"]');
  await list.waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('[data-testid="mcp-page"]').waitFor({ state: 'attached', timeout: 20_000 });
  return list;
}

// ── DSH Settings dialog (default entry, 0.5.0) ─────────────────────────────

/** The open Settings dialog, matched by its accessible name. */
export function settingsDialog(page) {
  return page.getByRole('dialog', { name: SETTINGS_TITLE });
}

/** Reload the authenticated page and wait for the shell/composer again. */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('button', { name: '新建会话' }).first().waitFor({ state: 'visible', timeout: 60_000 });
  await dismissFirstRun(page);
}

/**
 * Evidence for a failed Settings open: every button label plus the start of the
 * body text. A shell change then fails with the DOM it actually rendered.
 */
async function settingsDiagnostics(page) {
  const buttons = await page
    .locator('button')
    .evaluateAll((elements) => elements.map((element) => (element.getAttribute('aria-label') || element.innerText || '').trim()).filter((label) => label !== ''))
    .catch(() => []);
  const menuItems = await page
    .getByRole('menuitem')
    .evaluateAll((elements) => elements.map((element) => (element.innerText || '').trim()).filter((label) => label !== ''))
    .catch(() => []);
  const body = await page.locator('body').innerText().catch(() => '');
  return `buttons: ${JSON.stringify(buttons.slice(0, 40))}; menu items: ${JSON.stringify(menuItems.slice(0, 20))}; body: ${body.replace(/\s+/gu, ' ').slice(0, 2048)}`;
}

/**
 * Open the DSH Settings dialog.
 *
 * The direct bottom Settings control is tried first (a profile composing a
 * launcher package has it); otherwise 设置 is selected from the sidebar-foot
 * account menu, which is what the bare `web` template renders.
 */
export async function openSettings(page) {
  const dialog = settingsDialog(page);
  if ((await dialog.count()) > 0) return dialog;

  let openedFromDirectControl = false;
  try {
    const direct = page.getByRole('button', { name: SETTINGS_TRIGGER, exact: true }).first();
    await direct.waitFor({ state: 'visible', timeout: 3_000 });
    await direct.click();
    openedFromDirectControl = true;
  } catch {
    // The bare `web` template has no standalone control; fall through to the
    // account menu below.
  }

  if (!openedFromDirectControl) {
    // The account menu trigger's accessible name is 账号菜单 in every signed
    // state; the text form 更多 is only a signed-out fallback (and the sidebar's
    // panel "更多" row shares it, so it must be the last such button).
    const triggers = [
      page.getByRole('button', { name: ACCOUNT_MENU_LABEL, exact: true }).first(),
      page.getByRole('button', { name: ACCOUNT_MENU_TRIGGER }).last(),
    ];
    let menuOpened = false;
    let lastError = null;
    for (const trigger of triggers) {
      try {
        await trigger.waitFor({ state: 'visible', timeout: 5_000 });
        await trigger.click();
        menuOpened = true;
        break;
      } catch (error) {
        lastError = error;
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    if (!menuOpened) {
      throw new Error(`could not find the Settings control or the sidebar account menu: ${await settingsDiagnostics(page)}`, { cause: lastError ?? undefined });
    }
    const menuItem = page.getByRole('menuitem', { name: SETTINGS_TRIGGER }).first();
    try {
      await menuItem.waitFor({ state: 'visible', timeout: 10_000 });
      await menuItem.click();
    } catch (error) {
      // Some menu primitives render the label without the menuitem role.
      const textItem = page.getByRole('menu').getByText(SETTINGS_TRIGGER, { exact: true }).first();
      try {
        await textItem.waitFor({ state: 'visible', timeout: 5_000 });
        await textItem.click();
      } catch {
        throw new Error(`the account menu has no 设置 item: ${await settingsDiagnostics(page)}`, { cause: error });
      }
    }
  }

  try {
    await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    throw new Error(`the Settings dialog did not open: ${await settingsDiagnostics(page)}`, { cause: error });
  }
  return dialog;
}

/** Select one section cell in the Settings navigation rail and wait for its content. */
export async function selectSettingsSection(page, name) {
  const dialog = settingsDialog(page);
  const cell = dialog.getByRole('button', { name }).first();
  await cell.waitFor({ state: 'visible', timeout: 20_000 });
  await cell.click();
  return dialog;
}

/** Open Settings and select the plugin's MCP 管理 section. */
export async function openMcpSettings(page) {
  const dialog = await openSettings(page);
  await selectSettingsSection(page, SIDEBAR_MCP);
  const root = dialog.locator('[data-testid="mcp-page"]');
  await root.waitFor({ state: 'visible', timeout: 20_000 });
  await dialog.locator('[data-testid="mcp-list"]').waitFor({ state: 'visible', timeout: 20_000 });
  return dialog;
}

/** The management page rendered inside the Settings dialog (never the sidebar copy). */
export function settingsPageRoot(page) {
  return settingsDialog(page).locator('[data-testid="mcp-page"]');
}

/** Close Settings with Escape, the documented dismissal path. */
export async function closeSettings(page) {
  const dialog = settingsDialog(page);
  if ((await dialog.count()) === 0) return false;
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 15_000 });
  return true;
}

/** Read the Settings-only sidebar-entry row: presence, switch state and copy. */
export async function sidebarEntryRowState(page) {
  const row = settingsPageRoot(page).locator('[data-testid="sidebar-entry-row"]');
  const toggle = settingsPageRoot(page).locator('[data-testid="sidebar-entry-toggle"]');
  return {
    rows: await row.count(),
    toggles: await toggle.count(),
    checked: (await toggle.getAttribute('aria-checked').catch(() => undefined)) ?? undefined,
    disabled: await toggle.isDisabled().catch(() => undefined),
    label: (await row.innerText().catch(() => '')) ?? '',
  };
}

/**
 * Flip the optional sidebar module through the Settings switch.
 * Waits for the switch to settle (it is disabled while the PUT is in flight)
 * and for the requested aria-checked state.
 */
export async function setSidebarEntryEnabled(page, enabled) {
  const toggle = settingsPageRoot(page).locator('[data-testid="sidebar-entry-toggle"]');
  await toggle.waitFor({ state: 'visible', timeout: 20_000 });
  await waitFor(async () => ((await toggle.isDisabled()) === false ? true : undefined), {
    timeoutMs: 20_000,
    intervalMs: 100,
    label: 'sidebar-entry switch to become editable',
  });
  const target = enabled ? 'true' : 'false';
  if ((await toggle.getAttribute('aria-checked')) !== target) await toggle.click();
  await waitFor(async () => ((await toggle.getAttribute('aria-checked')) === target ? true : undefined), {
    timeoutMs: 20_000,
    intervalMs: 100,
    label: `sidebar-entry switch aria-checked=${target}`,
  });
  return toggle;
}

// ── management page: cards ──────────────────────────────────────────────────

/**
 * One server card. `scope` narrows the search to a subtree when the manager is
 * embedded (the Settings dialog) or when both presentations are on screen.
 */
export function card(page, name, scope = page) {
  return scope.locator(`[data-testid="server-card"][data-server-name="${name}"]`);
}

export async function cardNames(page, scope = page) {
  return scope.locator('[data-testid="server-card"]').evaluateAll((cards) => cards.map((entry) => entry.getAttribute('data-server-name')));
}

export async function cardState(page, name, scope = page) {
  const locator = card(page, name, scope);
  await locator.waitFor({ state: 'attached', timeout: 20_000 });
  return locator.locator('[data-testid="status-dot"]').getAttribute('data-state');
}

export async function cardText(page, name, scope = page) {
  return card(page, name, scope).innerText();
}

/**
 * Visual icon state of one card: the server-icon <img> (loaded bytes via
 * naturalWidth) or the first-letter fallback element.
 */
export async function cardIcon(page, name, scope = page) {
  const locator = card(page, name, scope);
  // One DOM snapshot instead of count-then-read: the card swaps the <img> for
  // the first-letter fallback when the icon request 404s, so a per-locator read
  // can race the re-render. evaluateAll never waits for the element to exist.
  const images = await locator
    .locator('[data-testid="server-icon"]')
    .evaluateAll((elements) => elements.map((element) => ({
      src: element.getAttribute('src'),
      naturalWidth: element.naturalWidth,
      complete: element.complete,
    })))
    .catch(() => []);
  const fallbacks = await locator
    .locator('[data-testid="server-icon-fallback"], .mm-tileLetter')
    .evaluateAll((elements) => elements.map((element) => element.textContent ?? ''))
    .catch(() => []);
  return {
    imageCount: images.length,
    fallbackCount: fallbacks.length,
    src: images[0]?.src,
    naturalWidth: images[0]?.naturalWidth ?? 0,
    complete: images[0]?.complete ?? false,
    fallbackText: fallbacks[0],
  };
}

/** Poll a card's derived status until it reaches one of `states`. */
export async function waitCardState(page, name, states, { timeoutMs = 30_000, scope = page } = {}) {
  const accepted = Array.isArray(states) ? states : [states];
  return waitFor(
    async () => {
      const state = await cardState(page, name, scope);
      return accepted.includes(state) ? state : undefined;
    },
    { timeoutMs, intervalMs: 300, label: `card "${name}" state ${accepted.join('/')}` },
  );
}

export async function waitCardText(page, name, text, { timeoutMs = 30_000, scope = page } = {}) {
  return waitFor(
    async () => {
      const content = await cardText(page, name, scope).catch(() => '');
      return content.includes(text) ? content : undefined;
    },
    { timeoutMs, intervalMs: 300, label: `card "${name}" to contain ${JSON.stringify(text)}` },
  );
}

async function openCardMenu(page, name, itemTestId, scope = page) {
  await clearOverlays(page);
  const menu = card(page, name, scope).locator('[data-testid="server-menu"]');
  await menu.click();
  const item = page.locator(`[data-testid="${itemTestId}"]`);
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  await item.click();
}

// ── management page: form ───────────────────────────────────────────────────

/** Open the add form inside `scope` (the page, or the Settings-mode manager root). */
export async function openAddForm(page, scope = page) {
  await clearOverlays(page);
  await scope.locator('[data-testid="add-mcp"]').click();
  await scope.locator('[data-testid="form-name"]').waitFor({ state: 'visible', timeout: 15_000 });
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

export async function formValues(page, scope = page) {
  const read = async (testId) => {
    const locator = scope.locator(`[data-testid="${testId}"]`);
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
export async function fillServerForm(page, spec, scope = page) {
  const testId = (id) => scope.locator(`[data-testid="${id}"]`);
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
  return formValues(page, scope);
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

export async function saveForm(page, { expectError = false, scope = page } = {}) {
  await scope.locator('[data-testid="form-save"]').click();
  if (expectError) {
    await sleep(1000);
    return;
  }
  await waitFor(async () => (await scope.locator('[data-testid="form-name"]').count()) === 0, {
    timeoutMs: 20_000,
    label: 'form to close after save',
  });
}

export async function editServer(page, name, scope = page) {
  await openCardMenu(page, name, 'menu-edit', scope);
  await scope.locator('[data-testid="form-name"]').waitFor({ state: 'visible', timeout: 15_000 });
  await waitFor(async () => (await scope.locator('[data-testid="form-name"]').inputValue()) === name, {
    timeoutMs: 10_000,
    label: `edit form for ${name}`,
  });
}

export async function updateUrl(page, url, scope = page) {
  const field = scope.locator('[data-testid="form-url"]');
  await field.waitFor({ state: 'visible', timeout: 10_000 });
  await field.fill(url);
}

export async function toggleServer(page, name, scope = page) {
  await openCardMenu(page, name, 'menu-toggle', scope);
}

export async function deleteServerViaCard(page, name, scope = page) {
  await openCardMenu(page, name, 'menu-delete', scope);
  const confirm = page.locator('[data-testid="confirm-dialog"]');
  await confirm.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-testid="confirm-delete"]').click();
  await waitFor(async () => (await card(page, name, scope).count()) === 0, {
    timeoutMs: 20_000,
    label: `card "${name}" to disappear after delete`,
  });
}

// ── management page: error detail / test dialogs ────────────────────────────

export async function openErrorDetail(page, name, scope = page) {
  const link = card(page, name, scope).locator('[data-testid="detail-error"]');
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
export async function testServerViaCard(page, name, scope = page) {
  await openCardMenu(page, name, 'menu-test', scope);
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

/**
 * Full-viewport screenshot with the Settings dialog open on the MCP section:
 * the primary docs image for 0.5.0 (Settings is the default entry).
 */
export async function screenshotSettingsViewport(page, path) {
  const dialog = settingsDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  return screenshotViewport(page, path);
}

// ── management page: 工具 tab (0.3.0) ───────────────────────────────────────

/** Open one server's edit form and switch it to the 工具 tab. */
export async function openEditToolsTab(page, name) {
  await editServer(page, name);
  const tab = page.locator('[data-testid="form-tab-tools"]');
  await tab.waitFor({ state: 'visible', timeout: 15_000 });
  await tab.click();
  await sleep(350);
  await page.locator('[data-testid="tools-panel"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('[data-testid="tools-count"]').waitFor({ state: 'visible', timeout: 20_000 });
}

/** One tool card in the 工具 tab, selected by its exact raw name. */
export function toolCard(page, name) {
  return page
    .locator('[data-testid="tool-card"]')
    .filter({ has: page.locator(`[data-testid="tool-name"]:text-is(${JSON.stringify(name)})`) })
    .first();
}

/** Read one tool card's switch states, params and copy. */
export async function toolCardState(page, name) {
  const card = toolCard(page, name);
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  const enabled = card.locator('[data-testid="tool-enabled"]');
  const approval = card.locator('[data-testid="tool-approval"]');
  const params = await card
    .locator('[data-testid="tool-param"]')
    .evaluateAll((elements) => elements.map((element) => ({ text: element.textContent ?? '', required: element.getAttribute('data-required') })));
  return {
    name,
    enabled: await enabled.getAttribute('aria-checked'),
    enabledDisabled: await enabled.isDisabled(),
    approval: await approval.getAttribute('aria-checked'),
    approvalDisabled: await approval.isDisabled(),
    description: (await card.locator('[data-testid="tool-desc"]').innerText().catch(() => '')) ?? '',
    params,
    text: await card.innerText(),
  };
}

/** Flip one tool card switch and wait for its aria-checked state. */
export async function setToolSwitch(page, name, switchTestId, on) {
  const card = toolCard(page, name);
  const control = card.locator(`[data-testid="${switchTestId}"]`);
  await control.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await control.getAttribute('aria-checked')) !== (on ? 'true' : 'false')) await control.click();
  await waitFor(async () => ((await control.getAttribute('aria-checked')) === (on ? 'true' : 'false') ? true : undefined), {
    timeoutMs: 10_000,
    intervalMs: 100,
    label: `tool ${name} ${switchTestId} to become ${on}`,
  });
}

/** Click 保存工具设置 and wait for the saved notice (or an error banner). */
export async function saveTools(page) {
  await page.locator('[data-testid="tools-save"]').click();
  const panel = page.locator('[data-testid="tools-panel"]');
  return waitFor(
    async () => {
      const text = await panel.innerText().catch(() => '');
      if (text.includes('工具设置已保存')) return text;
      if (text.includes('保存工具设置失败')) throw new Error(text.slice(0, 400));
      return undefined;
    },
    { timeoutMs: 30_000, intervalMs: 200, label: 'tools settings to save' },
  );
}

/** Wait until the 已启用 x/y counter shows `text`. */
export async function waitToolsCount(page, text) {
  return waitFor(
    async () => {
      const counter = await page.locator('[data-testid="tools-count"]').innerText().catch(() => '');
      return counter.includes(text) ? counter : undefined;
    },
    { timeoutMs: 20_000, intervalMs: 200, label: `tools count ${JSON.stringify(text)}` },
  );
}

/** Read the tools panel meta/cards (names, count, cached/connected notice). */
export async function toolsPanelInfo(page) {
  const panel = page.locator('[data-testid="tools-panel"]');
  return {
    count: (await page.locator('[data-testid="tools-count"]').innerText().catch(() => '')) ?? '',
    names: await panel.locator('[data-testid="tool-name"]').evaluateAll((elements) => elements.map((element) => element.textContent ?? '')),
    cached: (await panel.innerText().catch(() => '')).includes('显示上次连接时的工具列表'),
    offline: (await panel.innerText().catch(() => '')).includes('连接后才能读取实时工具列表'),
    text: (await panel.innerText().catch(() => '')) ?? '',
  };
}

/** Leave the form without saving basic fields (back button). */
export async function closeFormViaBack(page) {
  const back = page.locator('[data-testid="form-cancel"]');
  await back.click();
  await waitFor(async () => ((await page.locator('[data-testid="form-name"]').count()) === 0 ? true : undefined), {
    timeoutMs: 15_000,
    label: 'form to close via back',
  });
}

/** Screenshot the form's 工具 tab (tabs + tool list + save button). */
export async function screenshotToolsTab(page, path) {
  const pageSurface = page.locator('.mm-page').first();
  await pageSurface.waitFor({ state: 'visible', timeout: 10_000 });
  return screenshotElement(pageSurface, path);
}

// ── DSH permission preset + approval composer ──────────────────────────────

/** The current-session 访问模式 trigger rendered into the composer. */
export async function permissionTrigger(page) {
  const buttons = page.getByRole('button', { name: /^访问模式，当前：/ });
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    if (await buttons.nth(index).isVisible().catch(() => false)) return buttons.nth(index);
  }
  throw new Error('no visible 访问模式 button found in the composer');
}

/** Current permission preset label, e.g. 工作区内修改 / 完全权限. */
export async function currentPermission(page) {
  const trigger = await permissionTrigger(page);
  const label = (await trigger.getAttribute('aria-label')) ?? '';
  const match = label.match(/当前：(.*)$/);
  return (match?.[1] ?? label).trim();
}

/**
 * Switch the current session's permission preset through the composer popup.
 * Selecting 完全权限 goes through the shipped risk-confirmation dialog.
 */
export async function switchPermission(page, label) {
  if ((await currentPermission(page)) === label) return label;
  const trigger = await permissionTrigger(page);
  await trigger.click();
  await sleep(300);
  const option = page.getByRole('menuitem', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`) }).first();
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.click();
  await sleep(250);
  if (label === '完全权限') {
    const dialog = page.locator('[role="dialog"]').filter({ hasText: '确认启用完全权限？' }).first();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('input[type="checkbox"]').first().check();
    await dialog.getByRole('button', { name: '启用完全权限' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
  }
  return waitFor(
    async () => {
      const current = await currentPermission(page).catch(() => '');
      return current === label ? current : undefined;
    },
    { timeoutMs: 20_000, intervalMs: 250, label: `permission preset to become ${label}` },
  );
}

/** Wait for the DSH approval composer takeover and return its copy. */
export async function waitApprovalPrompt(page, { timeoutMs = 120_000 } = {}) {
  const panel = page.locator('[data-approval-key]').first();
  await panel.waitFor({ state: 'visible', timeout: timeoutMs });
  const text = await panel.innerText();
  return { panel, text };
}

/** Answer the approval composer: allow once or reject. */
export async function answerApproval(page, outcome, { timeoutMs = 15_000 } = {}) {
  const panel = page.locator('[data-approval-key]').first();
  await panel.waitFor({ state: 'visible', timeout: timeoutMs });
  const button = outcome === 'allow' ? panel.getByRole('button', { name: '允许一次' }) : panel.getByRole('button', { name: '拒绝' });
  await button.click();
  await panel.waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {});
}

/** How many pending approval composers are on screen right now. */
export async function approvalPromptCount(page) {
  return page.locator('[data-approval-key]').count();
}

// ── management page: 其他 MCP tab (0.4.x) ────────────────────────────────────

/** Escape a literal string for use inside a RegExp. */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Read the page-level tab pressed states. */
export async function pageTabState(page) {
  const owned = page.locator('[data-testid="page-tab-owned"]');
  const external = page.locator('[data-testid="page-tab-external"]');
  await owned.waitFor({ state: 'visible', timeout: 20_000 });
  await external.waitFor({ state: 'visible', timeout: 20_000 });
  return {
    ownedPressed: await owned.getAttribute('aria-pressed'),
    externalPressed: await external.getAttribute('aria-pressed'),
  };
}

/** Open 其他 MCP and wait until its initial GET /external load settles. */
export async function openExternalTab(page) {
  await page.locator('[data-testid="page-tab-external"]').click();
  await page.locator('[data-testid="external-panel"]').waitFor({ state: 'visible', timeout: 20_000 });
  await waitFor(
    async () => {
      if ((await page.locator('[data-testid="external-loading"]').count()) > 0) return undefined;
      return true;
    },
    { timeoutMs: 30_000, intervalMs: 150, label: '其他 MCP tab to finish loading' },
  );
  return page.locator('[data-testid="external-panel"]');
}

/** Switch back to 本插件 MCP and wait for the owned list. */
export async function openOwnedTab(page) {
  await page.locator('[data-testid="page-tab-owned"]').click();
  await page.locator('[data-testid="mcp-list"]').waitFor({ state: 'visible', timeout: 15_000 });
  return page.locator('[data-testid="mcp-list"]');
}

/** One preset group in 其他 MCP (compact list). */
export function externalPresetGroup(page, presetId) {
  return page.locator(`[data-testid="external-preset"][data-preset-id="${presetId}"]`).first();
}

/** Group ids + text currently rendered in 其他 MCP. */
export async function externalGroups(page) {
  return page
    .locator('[data-testid="external-preset"]')
    .evaluateAll((groups) => groups.map((group) => ({ id: group.getAttribute('data-preset-id'), text: group.innerText })));
}

/** One preset-owned server card in the compact list. */
export function externalServerCard(page, presetId, serverName) {
  return page
    .locator(`[data-testid="external-server-card"][data-preset-id="${presetId}"][data-server-name="${serverName}"]`)
    .first();
}

/** Compact list snapshot: preset/server identity plus the card's meta copy. */
export async function externalServerCards(page) {
  return page
    .locator('[data-testid="external-server-card"]')
    .evaluateAll((cards) => cards.map((card) => ({
      presetId: card.getAttribute('data-preset-id'),
      serverName: card.getAttribute('data-server-name'),
      text: card.innerText,
    })));
}

/** Read one server card's meta line (`x/y 个工具已启用` + discovered time). */
export async function externalServerMeta(page, presetId, serverName) {
  const card = externalServerCard(page, presetId, serverName);
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  return card.innerText();
}

/** Open one server card and wait for the per-server tool view. */
export async function openExternalServer(page, presetId, serverName) {
  const card = externalServerCard(page, presetId, serverName);
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  await card.click();
  const view = page.locator('[data-testid="external-server-view"]');
  await view.waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('[data-testid="external-tools-panel"]').waitFor({ state: 'visible', timeout: 20_000 });
  await waitFor(
    async () => {
      if ((await page.locator('[data-testid="external-loading"]').count()) > 0) return undefined;
      return true;
    },
    { timeoutMs: 20_000, intervalMs: 150, label: 'external server tool view to finish loading' },
  );
  return view;
}

/** Leave the per-server tool view and wait for the compact list. */
export async function backToExternalList(page) {
  await page.locator('[data-testid="external-back"]').click();
  await page.locator('[data-testid="external-panel"]').waitFor({ state: 'visible', timeout: 20_000 });
  return page.locator('[data-testid="external-panel"]');
}

/** Derive the server namespace from a public `mcp__<server>__<tool>` name. */
function serverNameFromPublicName(publicName) {
  const match = /^mcp__(.+?)__/u.exec(publicName);
  return match?.[1];
}

/**
 * Ensure the per-server tool view containing `publicName` is open.
 *
 * The compact list is the default view, so tool helpers can be called from
 * either view: when the tool cards are not rendered, find the owning server
 * card (by options or the `mcp__<server>__` name) and drill in.
 */
export async function ensureExternalServerView(page, publicName, { presetId, serverName } = {}) {
  const escaped = escapeRegex(publicName);
  const inDetail = (await page.locator('[data-testid="external-server-view"]').count()) > 0;
  if (inDetail) {
    const nameNode = page.locator('[data-testid="external-tool-name"]').filter({ hasText: new RegExp(`^${escaped}$`, 'u') });
    if ((await nameNode.count()) > 0) return page.locator('[data-testid="external-server-view"]');
    await backToExternalList(page);
  }
  const resolvedServer = serverName ?? serverNameFromPublicName(publicName);
  if (resolvedServer === undefined) throw new Error(`cannot derive the external server name from "${publicName}"`);
  let resolvedPreset = presetId;
  if (resolvedPreset === undefined) {
    const card = page.locator(`[data-testid="external-server-card"][data-server-name="${resolvedServer}"]`).first();
    if ((await card.count()) === 0) throw new Error(`no external server card for "${resolvedServer}" is rendered`);
    const cardPreset = await card.getAttribute('data-preset-id');
    if (cardPreset === null || cardPreset === '') throw new Error(`external server card for "${resolvedServer}" has no data-preset-id`);
    resolvedPreset = cardPreset;
  }
  await openExternalServer(page, resolvedPreset, resolvedServer);
  await page
    .locator('[data-testid="external-tool-name"]')
    .filter({ hasText: new RegExp(`^${escaped}$`, 'u') })
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 });
  return page.locator('[data-testid="external-server-view"]');
}

/** One external tool card by its public (model-facing) name (per-server view). */
export function externalToolCard(page, publicName) {
  const nameNode = page
    .locator('[data-testid="external-tool-name"]')
    .filter({ hasText: new RegExp(`^${escapeRegex(publicName)}$`, 'u') });
  return page.locator('[data-testid="external-tool-card"]').filter({ has: nameNode }).first();
}

/** Per-server tool view snapshot: count copy, batch controls and card names. */
export async function externalToolViewState(page) {
  const view = page.locator('[data-testid="external-server-view"]');
  await view.waitFor({ state: 'visible', timeout: 20_000 });
  const count = page.locator('[data-testid="external-count"]');
  await count.waitFor({ state: 'visible', timeout: 20_000 });
  return {
    count: (await count.innerText()).trim(),
    toolNames: await page
      .locator('[data-testid="external-tool-name"]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? '')),
    enableAllDisabled: await page.locator('[data-testid="external-enable-all"]').isDisabled(),
    disableAllDisabled: await page.locator('[data-testid="external-disable-all"]').isDisabled(),
    text: await view.innerText(),
  };
}

/** Read one external tool card's switches, params, description and copy. */
export async function externalToolState(page, publicName, options = {}) {
  await ensureExternalServerView(page, publicName, options);
  const card = externalToolCard(page, publicName);
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  const enabled = card.locator('[data-testid="external-tool-enabled"]');
  const approval = card.locator('[data-testid="external-tool-approval"]');
  const params = await card
    .locator('[data-testid="external-tool-param"]')
    .evaluateAll((elements) => elements.map((element) => ({ text: element.textContent ?? '', required: element.getAttribute('data-required') })));
  return {
    name: publicName,
    enabled: await enabled.getAttribute('aria-checked'),
    approval: await approval.getAttribute('aria-checked'),
    approvalDisabled: await approval.isDisabled(),
    description: (await card.locator('[data-testid="external-tool-desc"]').innerText().catch(() => '')) ?? '',
    params,
    text: await card.innerText(),
  };
}

/** Flip one external tool switch and wait for its aria-checked state. */
export async function setExternalToolSwitch(page, publicName, switchKind, on, options = {}) {
  await ensureExternalServerView(page, publicName, options);
  const testId = switchKind === 'approval' ? 'external-tool-approval' : 'external-tool-enabled';
  const control = externalToolCard(page, publicName).locator(`[data-testid="${testId}"]`);
  await control.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await control.getAttribute('aria-checked')) !== (on ? 'true' : 'false')) await control.click();
  await waitFor(async () => ((await control.getAttribute('aria-checked')) === (on ? 'true' : 'false') ? true : undefined), {
    timeoutMs: 10_000,
    intervalMs: 100,
    label: `external tool ${publicName} ${switchKind} to become ${on}`,
  });
}

/**
 * Click 保存工具设置 in the view that is open: the per-server tool view keeps
 * its own save button (and stays open on that view); the compact list keeps the
 * per-preset footer button. Waits for the saved/error notice.
 */
export async function saveExternalTools(page, presetId) {
  const detail = page.locator('[data-testid="external-server-view"]');
  const scope = (await detail.count()) > 0 ? detail : externalPresetGroup(page, presetId);
  await scope.locator('[data-testid="external-save"]').click();
  return waitFor(
    async () => {
      const text = await scope.innerText().catch(() => '');
      if (text.includes('工具设置已保存')) return text;
      if (text.includes('保存失败')) throw new Error(text.slice(0, 400));
      return undefined;
    },
    { timeoutMs: 30_000, intervalMs: 200, label: `external tools for ${presetId} to save` },
  );
}

/** Press 重新扫描 and wait until the scan settles. */
export async function scanExternal(page) {
  const button = page.locator('[data-testid="external-scan"]');
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
  await waitFor(
    async () => {
      const text = (await button.innerText().catch(() => '')).trim();
      return text === '重新扫描' && !(await button.isDisabled()) ? true : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 250, label: 'external scan to finish' },
  );
  await waitFor(
    async () => {
      if ((await page.locator('[data-testid="external-loading"]').count()) > 0) return undefined;
      return true;
    },
    { timeoutMs: 30_000, intervalMs: 150, label: '其他 MCP tab to settle after scan' },
  );
}

/** Screenshot the page surface (tabs + compact list or per-server tool view). */
export async function screenshotExternalTab(page, path) {
  const pageSurface = page.locator('.mm-page').first();
  await pageSurface.waitFor({ state: 'visible', timeout: 10_000 });
  return screenshotElement(pageSurface, path);
}
