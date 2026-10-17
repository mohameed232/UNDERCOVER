const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const URL = process.env.UNDERCOVER_URL || 'http://127.0.0.1:8000';

async function noOverflow(page) {
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(widths[0] <= widths[1], `horizontal overflow: ${widths.join(' > ')}`);
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  const colors = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  }));
  assert.equal(colors.background, 'rgb(245, 243, 239)');
  assert.equal(colors.primary, '#4d6f7d');
}

async function testPassPlay(browser) {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(URL);
  await noOverflow(page);
  await page.getByRole('button', { name: /جهاز واحد/ }).click();
  assert.equal(await page.locator('#hints').isChecked(), false);
  const names = ['آدم', 'سارة', 'ليان'];
  for (const [index, name] of names.entries()) await page.locator('.player-input').nth(index).fill(name);
  await page.getByRole('button', { name: 'بدء الجولة الأولى' }).click();
  const totals = new Map(names.map(name => [name, 0]));
  const pairs = new Set();
  for (let round = 1; round <= 5; round++) {
    const secrets = new Map();
    for (let index = 0; index < 3; index++) {
      const name = await page.locator('.player-name').innerText();
      assert.equal(await page.locator('.secret-word').count(), 0);
      await page.getByRole('button', { name: 'عرض الكلمة' }).click();
      const word = (await page.locator('.secret-word').textContent()).trim();
      secrets.set(name, word);
      assert.equal(await page.locator('.hint').count(), 0);
      await page.getByRole('button', { name: 'إخفاء والمتابعة' }).click();
      assert.equal(await page.locator('.secret-word').count(), 0);
    }
    const words = [...secrets.values()];
    const majority = words.find(word => words.filter(other => other === word).length === 2);
    const undercover = [...secrets].find(([,word]) => word !== majority)[0];
    const key = [...new Set(words)].sort().join('|');
    assert.ok(!pairs.has(key)); pairs.add(key);
    await page.locator('#begin-questions').click();
    const askers = new Set();
    for (let i = 0; i < 3; i++) {
      const [asker, target] = await page.locator('.assignment strong').allTextContents();
      assert.notEqual(asker, target); askers.add(asker);
      await page.locator('#question-done').click();
    }
    assert.equal(askers.size, 3);
    await page.getByText('النقاش الحر').waitFor();
    await page.locator('#begin-voting').click();
    for (let i = 0; i < 3; i++) {
      const voter = await page.locator('.player-name').innerText();
      await page.locator('#open-ballot').click();
      // All correct, including the undercover's self-vote.
      await page.getByRole('button', { name: undercover, exact: true }).click();
      await page.locator('#confirm-vote').click();
      totals.set(voter, totals.get(voter) + 1);
      if (i < 2) assert.equal(await page.locator('.reveal-name').count(), 0);
    }
    assert.equal(await page.locator('.reveal-name').innerText(), undercover);
    await page.locator('#handoff-guess').click();
    await page.locator('#open-guess').click();
    await page.getByRole('button', { name: majority, exact: true }).click();
    totals.set(undercover, totals.get(undercover) + 1);
    const rows = await page.locator('.score-table tbody tr').all();
    for (const row of rows) {
      const cells = await row.locator('td').allTextContents();
      assert.equal(Number(cells[2]), totals.get(cells[0]));
    }
    await noOverflow(page);
    await page.locator('#continue').click();
  }
  await page.getByText('اكتملت الجولات الخمس').waitFor();
  await page.locator('#new-session').click();
  assert.equal(await page.locator('#hints').isChecked(), false);
  assert.deepEqual(errors, []);
  await page.close();
}

async function testLocalParty(browser) {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors = [];
  let authenticatedFrames = 0;
  let pollingResponses = 0;
  pages.forEach(page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framereceived', event => {
      if (JSON.parse(event.payload.toString()).type === 'state') authenticatedFrames += 1;
    }));
    page.on('response', response => {
      if (/\/api\/rooms\/[^/]+\/state$/.test(response.url()) && response.status() === 200) pollingResponses += 1;
    });
  });
  const names = ['ليان', 'سارة', 'عمر'];

  await pages[0].goto(`${URL}/party`);
  await pages[0].getByRole('button', { name: 'إنشاء غرفة' }).click();
  await pages[0].locator('#host-name').fill(names[0]);
  await pages[0].getByRole('button', { name: 'إنشاء الغرفة' }).click();
  const code = (await pages[0].locator('.room-code').textContent()).trim();
  await pages[0].evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await pages[0].locator('#copy-link').click();
  await pages[0].getByText(/اضغط مطولًا/).waitFor();
  await noOverflow(pages[0]);
  assert.match(code, /^[A-Z2-9]{5}$/);

  for (let index = 1; index < pages.length; index += 1) {
    await pages[index].goto(`${URL}/party?room=${code}`);
    await pages[index].locator('#player-name').fill(names[index]);
    await pages[index].getByRole('button', { name: 'انضمام' }).click();
    await pages[index].locator('.room-code').waitFor();
  }
  await pages[0].waitForFunction(() => !document.querySelector('[data-action="start_game"]')?.disabled);
  assert.equal(await pages[0].getByRole('button', { name: 'بدء الجلسة' }).isEnabled(), true);
  assert.equal(await pages[1].getByRole('button', { name: 'بدء الجلسة' }).count(), 0);
  await pages[0].getByRole('button', { name: 'بدء الجلسة' }).click();

  const totals = new Map(names.map(name => [name, 0]));
  const pairs = new Set();
  for (let round = 1; round <= 5; round += 1) {
    const secrets = new Map();
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      await page.getByRole('button', { name: 'عرض كلمتي' }).click();
      const word = (await page.locator('.secret-word').textContent()).trim();
      secrets.set(names[index], word);
      await page.getByRole('button', { name: 'إخفاء وأنا جاهز' }).click();
      assert.equal(await page.locator('.secret-word').count(), 0);
      await noOverflow(page);
    }
    const counts = new Map();
    for (const word of secrets.values()) counts.set(word, (counts.get(word) || 0) + 1);
    assert.equal(counts.size, 2);
    const majorityWord = [...counts].find(([, count]) => count === 2)[0];
    const undercoverWord = [...counts].find(([, count]) => count === 1)[0];
    const undercover = [...secrets].find(([, word]) => word === undercoverWord)[0];
    const key = [majorityWord, undercoverWord].sort().join('|');
    assert.ok(!pairs.has(key));
    pairs.add(key);

    await pages[0].getByRole('button', { name: 'بدء الأسئلة' }).click();
    await pages[0].locator('.assignment strong').first().waitFor();
    const askers = [];
    for (let question = 0; question < 3; question += 1) {
      const labels = await pages[0].locator('.assignment strong').allTextContents();
      assert.notEqual(labels[0], labels[1]);
      askers.push(labels[0]);
      await pages[0].getByRole('button', { name: question === 2 ? 'إنهاء الأسئلة' : 'السؤال التالي' }).click();
      if (question < 2) await pages[0].waitForFunction(previous => document.querySelector('.assignment strong')?.textContent !== previous, labels[0]);
      else await pages[0].getByText('النقاش الحر').waitFor();
    }
    assert.equal(new Set(askers).size, 3);
    await pages[0].getByRole('button', { name: 'بدء التصويت' }).click();
    // A vote on one phone must not clear a selection on a different phone.
    await pages[1].locator('.vote-choice').filter({ hasText: undercover }).click();
    for (const [index, page] of pages.entries()) {
      if (index !== 1) await page.locator('.vote-choice').filter({ hasText: undercover }).click();
      else assert.equal(await page.locator('#submit-vote').isEnabled(), true);
      await page.getByRole('button', { name: 'تأكيد التصويت' }).click();
      if (index === 0) await page.getByText('تم تسجيل صوتك').waitFor();
    }
    for (const name of names) totals.set(name, totals.get(name) + 1);
    const undercoverIndex = names.indexOf(undercover);
    await pages[undercoverIndex].getByRole('button', { name: majorityWord, exact: true }).click();
    totals.set(undercover, totals.get(undercover) + 1);

    await pages[0].locator('.score-table').waitFor();
    const rows = pages[0].locator('.score-table tbody tr');
    for (let index = 0; index < 3; index += 1) {
      const cells = await rows.nth(index).locator('td').allTextContents();
      assert.equal(Number(cells[2]), totals.get(cells[0]));
    }
    if (round === 1) {
      if (process.env.EXPECT_TRANSPORT === 'polling') {
        await contexts[1].setOffline(true);
        await pages[1].waitForFunction(() => document.querySelector('#connection-status').textContent.includes('انقطع الاتصال'));
        await contexts[1].setOffline(false);
        await pages[1].waitForFunction(() => document.querySelector('#connection-status').textContent === 'متصل');
        await pages[1].locator('.score-table').waitFor();
      }
      await pages[1].reload();
      await pages[1].locator('.score-table').waitFor();
      assert.equal((await pages[1].locator('.status-badge').textContent()).trim(), 'متصل');
    }
    if (round === 1 && process.env.EXPECT_TRANSPORT === 'polling') {
      // Delay a score snapshot until after the next-round response arrives.
      let releasePoll;
      let captured;
      const snapshotCaptured = new Promise(resolve => { captured = resolve; });
      let held = false;
      const handler = async route => {
        if (held) return route.continue();
        held = true;
        const response = await route.fetch();
        await new Promise(resolve => { releasePoll = resolve; captured(); });
        await route.fulfill({ response });
      };
      await pages[0].route('**/api/rooms/*/state', handler);
      await snapshotCaptured;
      await pages[0].getByRole('button', { name: 'الجولة التالية' }).click();
      await pages[0].locator('#show-secret').waitFor();
      const delivered = pages[0].waitForResponse(response => response.url().endsWith('/state'));
      releasePoll();
      await (await delivered).finished();
      await pages[0].evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await pages[0].locator('.score-table').count(), 0, 'An older HTTP snapshot must not undo the new round');
      await pages[0].unroute('**/api/rooms/*/state', handler);
    } else {
      await pages[0].getByRole('button', { name: round === 5 ? 'عرض النتيجة النهائية' : 'الجولة التالية' }).click();
    }
  }
  if (process.env.EXPECT_TRANSPORT === 'polling') {
    assert.ok(pollingResponses > 5, 'The blocked-WebSocket test must actually use HTTP polling');
    assert.equal(authenticatedFrames, 0);
  } else if (process.env.EXPECT_TRANSPORT === 'websocket') {
    assert.ok(authenticatedFrames > 5, 'The WebSocket test must receive authenticated states');
  }
  assert.equal(pairs.size, 5);
  await pages[0].getByText('اكتملت الجولات الخمس').waitFor();
  assert.deepEqual(errors, []);
  if (process.env.EXPECT_TRANSPORT === 'websocket') {
    const duplicate = await contexts[0].newPage();
    await duplicate.goto(`${URL}/party?room=${code}`);
    await duplicate.getByText('اكتملت الجولات الخمس').waitFor();
    await pages[0].getByText('تابع من النافذة الأخرى').waitFor();
    await duplicate.close();
  }
  await Promise.all(contexts.map(context => context.close()));
}

async function testEntryRecovery(browser) {
  const page = await browser.newPage();
  await page.goto(`${URL}/party?room=ABCDE`);
  await page.locator('#back').click();
  await page.locator('#show-create').waitFor();
  await page.evaluate(() => {
    localStorage.setItem('undercover-room-OOOOO', JSON.stringify({ room_code: 'OOOOO', player_id: 'invalid', token: 'invalid' }));
  });
  await page.goto(`${URL}/party?room=OOOOO`);
  await page.locator('#show-create').click();
  await page.locator('#host-name').waitFor();
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  await testEntryRecovery(browser);
  await testPassPlay(browser);
  await testLocalParty(browser);
  await browser.close();
  console.log('Browser smoke: five-round Pass & Play and Local Party sessions, mobile RTL, clipboard fallback, and reconnection passed');
})().catch(error => { console.error(error); process.exit(1); });
