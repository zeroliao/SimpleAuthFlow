// content/burner-mail.js — Burner Mailbox temp email automation (email generation + polling)
// Injected on: burnermailbox.com/mailbox*, burnermailbox.com/switch/*

const BURNER_PREFIX = '[SimpleAuthFlow:burner-mail]';
const SEEN_BURNER_MAIL_IDS_KEY = 'seenBurnerMailIds';
const BURNER_CHALLENGE_REQUIRED_MESSAGE = 'Burner Mailbox security verification required. Complete the verification on the mailbox tab, then continue.';

console.log(BURNER_PREFIX, 'Content script loaded on', location.href);

let seenMailIds = new Set();
loadSeenMailIds();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message.type !== 'FETCH_BURNER_EMAIL'
    && message.type !== 'POLL_EMAIL'
    && message.type !== 'PREPARE_BURNER_EMAIL'
    && message.type !== 'CLICK_RANDOM_BURNER_EMAIL'
    && message.type !== 'READ_BURNER_EMAIL'
  ) return;

  resetStopState();
  handleMessage(message).then(result => {
    sendResponse(result);
  }).catch(err => {
    if (isStopError(err)) {
      log('Burner Mailbox: Stopped by user.', 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }

    if (message.type === 'POLL_EMAIL') {
      reportError(message.step, err.message);
    }

    sendResponse({ error: err.message });
  });

  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'FETCH_BURNER_EMAIL':
      return fetchBurnerEmail(message.payload || {});
    case 'PREPARE_BURNER_EMAIL':
      return prepareBurnerEmail(message.payload || {});
    case 'CLICK_RANDOM_BURNER_EMAIL':
      return clickRandomBurnerEmail(message.payload || {});
    case 'READ_BURNER_EMAIL':
      return readBurnerEmail(message.payload || {});
    case 'POLL_EMAIL':
      return pollBurnerMailbox(message.step, message.payload || {});
    default:
      throw new Error(`Unsupported message type: ${message.type}`);
  }
}

async function loadSeenMailIds() {
  try {
    const data = await chrome.storage.session.get(SEEN_BURNER_MAIL_IDS_KEY);
    if (Array.isArray(data[SEEN_BURNER_MAIL_IDS_KEY])) {
      seenMailIds = new Set(data[SEEN_BURNER_MAIL_IDS_KEY]);
    }
  } catch (err) {
    console.warn(BURNER_PREFIX, 'Failed to load seen mail ids:', err?.message || err);
  }
}

async function persistSeenMailIds() {
  try {
    await chrome.storage.session.set({ [SEEN_BURNER_MAIL_IDS_KEY]: [...seenMailIds] });
  } catch (err) {
    console.warn(BURNER_PREFIX, 'Failed to persist seen mail ids:', err?.message || err);
  }
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  const source = value || '';
  if (!/&(?:lt|gt|quot|amp|#\d+|#x[0-9a-f]+);/i.test(source)) return source;

  const textarea = document.createElement('textarea');
  textarea.innerHTML = source;
  return textarea.value;
}

function extractEmail(value) {
  return normalizeText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
}

function extractVerificationCode(text) {
  const source = text || '';

  const matchCn = source.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = source.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = source.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

function extractOpenAIVerificationCode(text, options = {}) {
  const source = normalizeText(text || '');
  const { allowLoose = false } = options;
  const isLikelyNoiseCode = (code) => code === '202123' || /^(\d)\1{5}$/.test(code);

  const strongPatterns = [
    /(?:openai|chatgpt|verification|verify|confirmation|login|security|code|验证码|驗證碼|代码|代碼)[^0-9]{0,120}(\d{6})/i,
    /(\d{6})[^0-9]{0,120}(?:openai|chatgpt|verification|verify|confirmation|login|security|code|验证码|驗證碼|代码|代碼)/i,
    /(?:code|验证码|驗證碼|代码|代碼)\s*(?:is|:|：)?\s*(\d{6})/i,
  ];

  for (const pattern of strongPatterns) {
    const match = source.match(pattern);
    if (match?.[1] && !isLikelyNoiseCode(match[1])) return match[1];
  }

  if (!allowLoose) return null;

  const looseMatches = [...source.matchAll(/\b(\d{6})\b/g)].map(match => match[1]);
  return looseMatches.find(code => !/^20\d{4}$/.test(code) && !isLikelyNoiseCode(code)) || null;
}

function parseHtmlDocument(value) {
  const decoded = decodeHtmlEntities(value || '');
  if (!/<[a-z][\s\S]*>/i.test(decoded)) return null;

  const htmlMatch = decoded.match(/<html[\s\S]*<\/html>/i);
  const html = htmlMatch ? htmlMatch[0] : decoded;
  return new DOMParser().parseFromString(html, 'text/html');
}

function getReadableDocumentText(doc) {
  if (!doc) return '';

  const clone = doc.cloneNode(true);
  clone.querySelectorAll('head, style, script, noscript, svg').forEach(el => el.remove());
  return normalizeText(clone.body?.innerText || clone.body?.textContent || '');
}

function extractCodeFromHtmlDocument(doc) {
  if (!doc?.body) return null;

  const cleanDoc = doc.cloneNode(true);
  cleanDoc.querySelectorAll('head, style, script, noscript, svg').forEach(el => el.remove());

  for (const el of cleanDoc.body.querySelectorAll('p, td, div, span, strong, b')) {
    const text = normalizeText(el.textContent || '');
    const exactMatch = text.match(/^(\d{6})$/);
    if (exactMatch && exactMatch[1] !== '202123' && !/^(\d)\1{5}$/.test(exactMatch[1])) {
      return exactMatch[1];
    }
  }

  return extractOpenAIVerificationCode(getReadableDocumentText(cleanDoc), { allowLoose: true });
}

function extractCodeFromHtmlValue(value) {
  const doc = parseHtmlDocument(value);
  return doc ? extractCodeFromHtmlDocument(doc) : null;
}

function extractCodeFromEmailFrame(frame) {
  try {
    const frameCode = extractCodeFromHtmlDocument(frame.contentDocument);
    if (frameCode) return frameCode;
  } catch (err) {
    console.debug(BURNER_PREFIX, 'Unable to read email iframe document:', err?.message || err);
  }

  const srcdoc = frame.getAttribute('srcdoc');
  return srcdoc ? extractCodeFromHtmlValue(srcdoc) : null;
}

function getOpenMessageDetail(rowId) {
  const detailRoot = rowId
    ? document.querySelector(`#message-${CSS.escape(rowId)}`)
    : document.querySelector('.mailbox .message');
  const emailFrame = detailRoot?.querySelector('iframe.tm-email-frame, iframe[srcdoc]')
    || document.querySelector('.mailbox .message iframe.tm-email-frame, .mailbox .message iframe[srcdoc]');
  const detailTextarea = (rowId ? document.querySelector(`#message-${CSS.escape(rowId)} textarea`) : null)
    || detailRoot?.querySelector('textarea')
    || document.querySelector('.message textarea');

  return { detailRoot, emailFrame, detailTextarea };
}

async function waitForDetailCode(rowId, timeout = 4000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const { detailRoot, emailFrame, detailTextarea } = getOpenMessageDetail(rowId);
    const frameCode = emailFrame ? extractCodeFromEmailFrame(emailFrame) : null;
    if (frameCode) return frameCode;

    const detailText = detailTextarea?.value || detailTextarea?.textContent || detailRoot?.textContent || '';
    const detailCode = extractCodeFromHtmlValue(detailText)
      || extractOpenAIVerificationCode(detailText, { allowLoose: true });
    if (detailCode) return detailCode;

    await sleep(200);
  }

  return null;
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function findVisibleElement(selectors) {
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

function findElementByText(selectors, pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const text = normalizeText(el.textContent || el.value || '');
      if (regex.test(text)) {
        return el;
      }
    }
  }
  return null;
}

function findClickableByText(pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  const candidates = Array.from(document.querySelectorAll('button, a, input, [role="button"], .cursor-pointer, .app-action, .actions *, form *'));
  const matches = candidates
    .filter(el => isVisible(el) && regex.test(normalizeText(el.textContent || el.value || '')))
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return (aRect.width * aRect.height) - (bRect.width * bRect.height);
    });

  for (const el of matches) {
    return el.closest('button, a, [role="button"], .cursor-pointer, .app-action, form') || el;
  }

  return null;
}

function findEmailInSelectors(selectors) {
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const email = extractEmail(el?.textContent || el?.value || '');
      if (email) return email;
    }
  }
  return '';
}

function getVisibleMailboxEmail() {
  const selectors = [
    '#email_id',
    '.actions #email_id',
    '.in-app-actions #email_id',
    '.in-app-actions .block.appearance-none',
    '.in-app-actions .relative .block.appearance-none',
    '.in-app-actions form .block.appearance-none',
    '.actions .block.appearance-none',
  ];

  return findEmailInSelectors(selectors);
}

function getCurrentEmail() {
  const visibleEmail = getVisibleMailboxEmail();
  if (visibleEmail) return visibleEmail;

  const switchMenuEmail = findEmailInSelectors([
    '.actions a[href*="/switch/"]',
    '.in-app-actions a[href*="/switch/"]',
  ]);
  if (switchMenuEmail) return switchMenuEmail;

  const titleEmail = extractEmail(document.title);
  if (titleEmail) return titleEmail;

  for (const root of document.querySelectorAll('.actions [wire\\:initial-data]')) {
    try {
      const raw = root.getAttribute('wire:initial-data');
      if (!raw) continue;
      const data = JSON.parse(raw);
      const email = extractEmail(data?.serverMemo?.data?.email || '');
      if (email) return email;
    } catch {}
  }

  return '';
}

function getChallengeSuccessElement() {
  return document.querySelector('#challenge-success-text');
}

function detectBurnerSecurityChallenge() {
  const title = normalizeText(document.title);
  const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || '');
  const challengeFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[title*="security challenge" i]');
  const challengeInput = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][type="hidden"]');
  const successVisible = isVisible(getChallengeSuccessElement());
  const mailboxReady = Boolean(getCurrentEmail() || findNewButton() || findRandomButton());
  const challengeSuccessText = /verification successful|验证成功|验证已成功|正在等待 burnermailbox\.com 响应|等待 burnermailbox\.com 响应/i.test(bodyText);

  if (mailboxReady || successVisible || challengeSuccessText) {
    return { active: false };
  }

  const active =
    /just a moment/i.test(title)
    || /进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人|ray id/i.test(title)
    || /performing security verification|verifies you are not a bot|verify you are not a bot|security service to protect against malicious bots|ray id|进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人/i.test(bodyText)
    || Boolean(challengeFrame)
    || Boolean(challengeInput)
    || location.href.includes('__cf_chl');

  return {
    active,
    message: BURNER_CHALLENGE_REQUIRED_MESSAGE,
  };
}

function throwIfBurnerChallengeRequired() {
  const challenge = detectBurnerSecurityChallenge();
  if (challenge.active) {
    throw new Error(challenge.message);
  }
}

async function waitForMailboxReady(timeout = 20000, options = {}) {
  const { detectChallenge = false } = options;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (detectChallenge) {
      throwIfBurnerChallengeRequired();
    }

    const email = getCurrentEmail();
    if (email || findNewButton() || findRandomButton()) {
      return;
    }

    await sleep(250);
  }

  throw new Error('Burner Mailbox page did not become ready.');
}

function findNewButton() {
  return findElementByText(
    ['.actions .cursor-pointer', '.actions div', '.actions button', '.actions a'],
    /^(new|新的)$|new email|新邮件/i
  );
}

function findRandomButton() {
  return findElementByText(
    [
      'form[wire\\:submit\\.prevent="random"] input[value="Random"]',
      'form[wire\\:submit\\.prevent="random"] input[value="Create a Random Email"]',
      'form[wire\\:submit\\.prevent="random"] input[type="submit"]',
      'form[wire\\:submit\\.prevent="random"] button',
      '.app-action input[type="submit"]',
      '.app-action button',
      'input[type="submit"]',
      'button',
      '[role="button"]',
    ],
    /random|create a random email|随机|创建随机电子邮件/i
  ) || findClickableByText(/^random$/i);
}

function submitLivewireFormFromControl(control) {
  const form = control?.closest?.('form');
  if (form && typeof form.requestSubmit === 'function') {
    form.requestSubmit(control.matches('button, input[type="submit"]') ? control : undefined);
    return true;
  }

  return false;
}

function clickOrSubmitControl(control) {
  if (!control) return;
  if (submitLivewireFormFromControl(control)) return;
  simulateClick(control);
}

function findRefreshButton() {
  return findElementByText(
    ['.actions .cursor-pointer', '.actions div', '.actions button', '.actions a'],
    /^(refresh|刷新)$/
  );
}

function findCopyButton() {
  return findElementByText(
    ['.btn_copy', '.actions .cursor-pointer', '.actions div', '.actions button', '.actions a'],
    /^(copy|复制)$/
  );
}

async function fetchBurnerEmail(payload = {}) {
  const { generateNew = true } = payload;

  log(`Burner Mailbox: ${generateNew ? 'Generating' : 'Reading'} temporary email...`);
  await waitForMailboxReady(20000, { detectChallenge: true });

  const currentEmail = getCurrentEmail();
  if (currentEmail && !generateNew) {
    log(`Burner Mailbox: Reusing existing email ${currentEmail}`, 'ok');
    return { email: currentEmail, generated: false };
  }

  const previousEmail = currentEmail;
  const newButton = findNewButton();
  if (!newButton && !findRandomButton()) {
    throw new Error('Could not find the Burner Mailbox "New" button.');
  }

  if (newButton) {
    await humanPause(300, 900);
    simulateClick(newButton);
    log('Burner Mailbox: Opened new mailbox panel');
    await sleep(700);
  } else {
    log('Burner Mailbox: Random email panel already open');
  }

  const randomButton = await waitForRandomButton(10000);
  await humanPause(300, 900);
  clickOrSubmitControl(randomButton);
  log('Burner Mailbox: Clicked random email creation');
  await sleep(300);

  const createButton = findElementByText(
    ['form[wire\\:submit\\.prevent="create"] input[type="submit"]', 'form[wire\\:submit\\.prevent="create"] button', 'input[type="submit"]', 'button'],
    /^create$/i
  );
  if (createButton && createButton !== randomButton) {
    await humanPause(150, 350);
    clickOrSubmitControl(createButton);
    log('Burner Mailbox: Clicked create email button');
  }

  await waitForMailboxActions(15000, { detectChallenge: true });
  const copyButton = findCopyButton();
  if (copyButton) {
    await humanPause(150, 450);
    simulateClick(copyButton);
    log('Burner Mailbox: Clicked copy button after generation');
    await sleep(250);
  }

  const nextEmail = await waitForEmailChange(previousEmail, 15000, { detectChallenge: true });
  log(`Burner Mailbox: Ready email ${nextEmail}`, 'ok');

  return { email: nextEmail, generated: true };
}

async function prepareBurnerEmail(payload = {}) {
  const { generateNew = true } = payload;

  await waitForMailboxReady(20000, { detectChallenge: true });

  const currentEmail = getCurrentEmail();
  if (currentEmail && !generateNew) {
    return { email: currentEmail, generated: false, previousEmail: currentEmail };
  }

  const newButton = findNewButton();
  if (!newButton && !findRandomButton()) {
    throw new Error('Could not find the Burner Mailbox "New" button.');
  }

  if (newButton) {
    await humanPause(250, 700);
    simulateClick(newButton);
    log('Burner Mailbox: Opened new mailbox panel');
    await sleep(700);
  } else {
    log('Burner Mailbox: Random email panel already open');
  }

  return {
    ok: true,
    previousEmail: currentEmail,
    generated: false,
  };
}

async function clickRandomBurnerEmail(payload = {}) {
  const { previousEmail = '' } = payload;

  const randomButton = await waitForRandomButton(10000, { detectChallenge: true });
  await humanPause(250, 700);
  clickOrSubmitControl(randomButton);
  log('Burner Mailbox: Clicked random email creation');
  await sleep(300);

  const createButton = findElementByText(
    ['form[wire\\:submit\\.prevent="create"] input[type="submit"]', 'form[wire\\:submit\\.prevent="create"] button', 'input[type="submit"]', 'button'],
    /^create$/i
  );
  if (createButton && createButton !== randomButton) {
    await humanPause(150, 350);
    clickOrSubmitControl(createButton);
    log('Burner Mailbox: Clicked create email button');
  }

  return {
    ok: true,
    previousEmail,
  };
}

async function readBurnerEmail(payload = {}) {
  const previousEmail = extractEmail(payload.previousEmail || '');

  await waitForMailboxReady(20000, { detectChallenge: true });

  const copyButton = findCopyButton();
  if (copyButton) {
    await humanPause(100, 250);
    simulateClick(copyButton);
    log('Burner Mailbox: Clicked copy button while reading current email');
    await sleep(200);
  }

  const current = getVisibleMailboxEmail() || getCurrentEmail();
  if (!current) {
    return { email: '', changed: false };
  }

  return {
    email: current,
    changed: Boolean(current && current !== previousEmail),
    previousEmail,
  };
}

async function waitForRandomButton(timeout = 10000, options = {}) {
  const { detectChallenge = false } = options;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (detectChallenge) {
      throwIfBurnerChallengeRequired();
    }
    const button = findRandomButton();
    if (button) return button;
    await sleep(200);
  }
  throw new Error('Could not find the random-email button after clicking New.');
}

async function waitForEmailChange(previousEmail = '', timeout = 15000, options = {}) {
  const { detectChallenge = false } = options;
  const start = Date.now();
  const previous = extractEmail(previousEmail);

  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (detectChallenge) {
      throwIfBurnerChallengeRequired();
    }

    const current = getVisibleMailboxEmail() || getCurrentEmail();
    if (current && current !== previous) {
      return current;
    }

    await sleep(250);
  }

  const current = getCurrentEmail();
  if (current) return current;

  throw new Error('Timed out waiting for Burner Mailbox to show the generated email.');
}

async function waitForMailboxActions(timeout = 15000, options = {}) {
  const { detectChallenge = false } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (detectChallenge) {
      throwIfBurnerChallengeRequired();
    }

    const email = getVisibleMailboxEmail();
    if (email) {
      return;
    }

    await sleep(250);
  }

  throw new Error('Timed out waiting for Burner Mailbox to return to the mailbox action view.');
}

function getMailboxRows() {
  return Array.from(document.querySelectorAll('.mailbox .list [data-id], .messages [data-id], .tm-message-row'));
}

function getRowId(row) {
  return row?.getAttribute('data-id') || '';
}

function getRowText(row) {
  return normalizeText(row?.textContent || '');
}

function collectExistingRowIds() {
  return new Set(getMailboxRows().map(getRowId).filter(Boolean));
}

function rowMatchesFilters(rowText, senderFilters = [], subjectFilters = []) {
  const lower = rowText.toLowerCase();
  const senderMatch = senderFilters.some(f => lower.includes((f || '').toLowerCase()));
  const subjectMatch = subjectFilters.some(f => lower.includes((f || '').toLowerCase()));
  const keywordMatch = /openai|chatgpt|verify|verification|confirm|login|验证码|代码|code/.test(lower);
  return senderMatch || subjectMatch || keywordMatch;
}

async function refreshMailbox() {
  const refreshButton = findRefreshButton();
  if (!refreshButton) return;

  simulateClick(refreshButton);
  await sleep(1200);
}

async function extractCodeFromRow(row) {
  const rowId = getRowId(row);
  const rowCode = extractOpenAIVerificationCode(getRowText(row));
  if (rowCode) return rowCode;

  simulateClick(row);
  const detailCode = await waitForDetailCode(rowId);

  const backButton = findElementByText(
    ['.message [x-on\\:click]', '.message button', '.message .cursor-pointer'],
    /go back|mailbox|返回收件箱/i
  );
  if (backButton) {
    await humanPause(150, 400);
    simulateClick(backButton);
    await sleep(250);
  }

  return detailCode;
}

async function pollBurnerMailbox(step, payload) {
  const {
    senderFilters = [],
    subjectFilters = [],
    maxAttempts = 20,
    intervalMs = 3000,
  } = payload;

  await waitForMailboxReady(20000, { detectChallenge: true });
  log(`Step ${step}: Starting Burner Mailbox poll (max ${maxAttempts} attempts)`);

  const existingIds = collectExistingRowIds();
  log(`Step ${step}: Snapshotted ${existingIds.size} existing mailbox messages`);

  const fallbackAfter = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    throwIfBurnerChallengeRequired();
    log(`Polling Burner Mailbox... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshMailbox();
      throwIfBurnerChallengeRequired();
    }

    const rows = getMailboxRows();
    const useFallback = attempt > fallbackAfter;

    for (const row of rows) {
      const rowId = getRowId(row);
      if (!rowId || seenMailIds.has(rowId)) continue;
      if (!useFallback && existingIds.has(rowId)) continue;

      const rowText = getRowText(row);
      if (!rowMatchesFilters(rowText, senderFilters, subjectFilters)) continue;

      const code = await extractCodeFromRow(row);
      if (!code) continue;

      seenMailIds.add(rowId);
      await persistSeenMailIds();

      const source = existingIds.has(rowId) ? 'fallback' : 'new';
      log(`Step ${step}: Code found: ${code} (${source}, row ${rowId})`, 'ok');

      return {
        ok: true,
        code,
        emailTimestamp: Date.now(),
        mailId: rowId,
      };
    }

    if (attempt === fallbackAfter + 1) {
      log(`Step ${step}: No new mailbox messages yet, falling back to older matching messages`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(`No matching verification email found in Burner Mailbox after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s.`);
}
