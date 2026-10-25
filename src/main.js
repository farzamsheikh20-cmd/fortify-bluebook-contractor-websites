import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { canonicalProfileUrl, clean, domainKey, emailsFrom, extractWebsite, isBlueBookProfile, normalizeUrl, profileKey, profilesFromHtml, safeCampaignId } from './helpers.js';

await Actor.init();
const defaults = {
  startUrls: ['https://www.thebluebook.com/search.html?class=2200&region=36'],
  maximumNewCompanies: 100, maximumProfilesVisited: 200, maximumListingPagesThisRun: 10,
  requireWebsite: true, collectEmails: true, visitCompanyWebsitesForEmails: false,
  useResidentialProxy: true, proxyCountryCode: 'US', campaignName: 'bluebook-contractors',
  resetProgress: false, pageTimeoutSecs: 60, delayMillis: 1200
};
const input = { ...defaults, ...(await Actor.getInput()) };
input.startUrls = [...new Set((input.startUrls || []).map(url => normalizeUrl(url)).filter(Boolean))];
const campaignId = safeCampaignId(input.campaignName);
const kv = await Actor.openKeyValueStore(`campaign-${campaignId}`);
let progress = input.resetProgress ? null : await kv.getValue('PROGRESS');
if (!progress || !Array.isArray(progress.pendingProfiles)) {
  progress = { listingQueue: [], pendingProfiles: [], seenListings: [], discoveredProfiles: [], seenProfiles: [], seenDomains: [], totalOutput: 0, masterDatasetName: `master-${campaignId}` };
}
for (const url of input.startUrls) {
  if (isBlueBookProfile(url)) {
    const profile = canonicalProfileUrl(url);
    const key = profileKey(profile);
    if (key && !progress.discoveredProfiles.includes(key)) {
      progress.discoveredProfiles.push(key);
      progress.pendingProfiles.push({ url: profile, sourceUrl: url });
    }
  } else if (!progress.seenListings.includes(url) && !progress.listingQueue.some(item => item.url === url)) {
    progress.listingQueue.push({ url, sourceUrl: url });
  }
}
const listingQueue = progress.listingQueue;
const pending = progress.pendingProfiles;
const seenListings = new Set(progress.seenListings);
const discoveredProfiles = new Set(progress.discoveredProfiles);
const seenProfiles = new Set(progress.seenProfiles);
const seenDomains = new Set(progress.seenDomains);
const master = await Actor.openDataset(progress.masterDatasetName);
const runDataset = await Actor.openDataset();

async function save() {
  progress.listingQueue = listingQueue;
  progress.pendingProfiles = pending;
  progress.seenListings = [...seenListings];
  progress.discoveredProfiles = [...discoveredProfiles];
  progress.seenProfiles = [...seenProfiles];
  progress.seenDomains = [...seenDomains];
  await kv.setValue('PROGRESS', progress);
}
if (input.resetProgress) await save();

let proxyConfiguration;
if (input.useResidentialProxy) {
  proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: input.proxyCountryCode || 'US' });
  if (!proxyConfiguration) throw new Error('Residential proxy could not be created. Enable Apify Proxy access or disable useResidentialProxy.');
}
let browser;
let context;
let page;

async function launchBrowser() {
  let browserProxy;
  if (proxyConfiguration) {
    const sessionId = `bluebook${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const proxyUrl = await proxyConfiguration.newUrl(sessionId);
    const parsed = new URL(proxyUrl);
    browserProxy = { server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`, username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.APIFY_CHROME_EXECUTABLE_PATH || process.env.APIFY_DEFAULT_BROWSER_PATH || '/usr/bin/google-chrome',
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
    ...(browserProxy ? { proxy: browserProxy } : {})
  });
  context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36', locale: 'en-US' });
  page = await context.newPage();
  page.setDefaultTimeout(Math.min(input.pageTimeoutSecs * 1000, 30000));
}

async function rotateBrowser() {
  await browser?.close().catch(() => {});
  await launchBrowser();
  log.info('Residential proxy rotated to a fresh session');
}

await launchBrowser();
if (input.useResidentialProxy) log.info('US residential proxy enabled');

async function navigate(url, targetPage = page) {
  const response = await targetPage.goto(url, { waitUntil: 'domcontentloaded', timeout: input.pageTimeoutSecs * 1000 });
  await targetPage.waitForTimeout(input.delayMillis);
  const status = response?.status() || null;
  const title = await targetPage.title().catch(() => '');
  const text = clean(await targetPage.locator('body').innerText().catch(() => ''));
  if (status === 403 || /captcha|verify you are human|access denied|forbidden|can't connect to the server/i.test(`${title} ${text.slice(0, 1500)}`)) {
    throw new Error(`Blue Book access challenge detected (HTTP ${status || 'unknown'}). Use a US residential proxy or retry with a new session.`);
  }
  return { status, title, bodyLength: text.length, finalUrl: targetPage.url() };
}

async function discoverListings() {
  let pages = 0;
  while (listingQueue.length && pages < input.maximumListingPagesThisRun) {
    const item = listingQueue.shift();
    if (!item?.url || seenListings.has(item.url)) continue;
    try {
      const queuedUrl = new URL(item.url);
      const originalUrl = new URL(item.sourceUrl);
      if (!originalUrl.searchParams.has('searchTerm')) queuedUrl.searchParams.delete('searchTerm');
      item.url = queuedUrl.href;
    } catch {}
    try {
      const navigation = await navigate(item.url);
      const links = await page.locator('a[href]').evaluateAll(elements => elements.map(a => ({ href: a.href, text: (a.innerText || '').trim(), rel: a.rel || '', ariaLabel: a.getAttribute('aria-label') || '' })));
      const html = await page.content();
      const candidates = [...links.map(link => canonicalProfileUrl(link.href)).filter(Boolean), ...profilesFromHtml(html)];
      let added = 0;
      for (const url of new Set(candidates)) {
        const key = profileKey(url);
        if (!key || discoveredProfiles.has(key)) continue;
        discoveredProfiles.add(key);
        pending.push({ url, sourceUrl: item.sourceUrl });
        added++;
      }
      let nextUrl = null;
      if (added > 0) {
        const currentUrl = new URL(item.url);
        const sourceUrl = new URL(item.sourceUrl);
        const currentPage = Number.parseInt(currentUrl.searchParams.get('page') || '1', 10);
        currentUrl.searchParams.set('page', String(currentPage + 1));
        if (!sourceUrl.searchParams.has('searchTerm')) currentUrl.searchParams.delete('searchTerm');
        nextUrl = currentUrl.href;
      }
      if (nextUrl && !seenListings.has(nextUrl) && !listingQueue.some(queued => queued.url === nextUrl)) listingQueue.push({ url: nextUrl, sourceUrl: item.sourceUrl });
      seenListings.add(item.url);
      pages++;
      await save();
      log.info('Blue Book listing page discovered', { listingUrl: item.url, browserStatus: navigation.status, browserTitle: navigation.title, browserBodyLength: navigation.bodyLength, anchorsFound: links.length, profilesAdded: added, pendingProfiles: pending.length, remainingListingPages: listingQueue.length });
    } catch (error) {
      if (/access challenge|HTTP 403/i.test(error.message) && (item.proxyRetries || 0) < 3) {
        item.proxyRetries = (item.proxyRetries || 0) + 1;
        listingQueue.unshift(item);
        await save();
        log.warning('Blue Book blocked this residential IP; rotating and retrying', { url: item.url, retry: item.proxyRetries });
        await rotateBrowser();
        continue;
      }
      listingQueue.unshift(item);
      await save();
      log.error('Blue Book listing discovery stopped safely', { url: item.url, message: error.message });
      break;
    }
  }
}

async function extractProfile(item) {
  await navigate(item.url);
  const html = await page.content();
  const bodyText = clean(await page.locator('body').innerText().catch(() => ''));
  const links = await page.locator('a[href]').evaluateAll(elements => elements.map(a => ({ href: a.href, text: (a.innerText || '').trim(), ariaLabel: a.getAttribute('aria-label') || '' })));
  const title = clean(await page.title().catch(() => ''));
  const companyName = clean(await page.locator('h1').first().textContent().catch(() => '')) || clean(title.split('|')[0].replace(/\s+-\s+[^-]+,\s+[A-Z]{2}.*$/i, ''));
  const website = extractWebsite(html, links);
  const phoneMatches = [...bodyText.matchAll(/(?:Phone|Alt Phone|Telephone)?\s*[:.]?\s*(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/gi)].map(match => clean(match[1]));
  const phones = [...new Set(phoneMatches)].slice(0, 5);
  const address = bodyText.match(/\b\d{1,6}\s+[A-Za-z0-9 .#'&-]{2,100},?\s+[A-Za-z .'-]{2,60},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/)?.[0] || null;
  const tradeBlock = bodyText.match(/(?:Our main lines of business include|What We Do|Categories|Trades)\s*:?\s*(.{2,600}?)(?:Company Information|Project Experience|Regions|Locations|Contact Us|Gallery)/i)?.[1] || '';
  const trades = [...new Set(tradeBlock.split(/[,;•|]/).map(clean).filter(value => value.length > 2 && value.length < 100))].slice(0, 30);
  let emails = input.collectEmails ? emailsFrom(`${bodyText} ${html}`) : [];
  if (website && input.collectEmails && input.visitCompanyWebsitesForEmails) {
    const companyPage = await context.newPage();
    try {
      await navigate(website, companyPage);
      emails = [...new Set([...emails, ...emailsFrom(`${await companyPage.locator('body').innerText().catch(() => '')} ${await companyPage.content().catch(() => '')}`)])];
    } catch (error) { log.warning('Company website email visit failed; keeping Blue Book data', { website, message: error.message }); }
    finally { await companyPage.close(); }
  }
  return { companyName, website, websiteDomain: domainKey(website), email: emails[0] || null, allPublicEmails: emails, phone: phones[0] || null, allPhones: phones, address, trades, blueBookProfileUrl: item.url, sourceDirectoryUrl: item.sourceUrl || null, collectedAt: new Date().toISOString() };
}

let output = 0;
let visited = 0;
try {
  if (!pending.length) await discoverListings();
  while (output < input.maximumNewCompanies && visited < input.maximumProfilesVisited) {
    if (!pending.length) {
      if (!listingQueue.length) break;
      await discoverListings();
      if (!pending.length) break;
    }
    const item = pending.shift();
    const key = profileKey(item?.url);
    if (!key || seenProfiles.has(key)) { await save(); continue; }
    visited++;
    let row;
    try { row = await extractProfile(item); }
    catch (error) {
      pending.push(item);
      await save();
      if (/access challenge|HTTP 403/i.test(error.message)) await rotateBrowser();
      log.warning('Blue Book profile failed and remains queued', { url: item.url, message: error.message });
      continue;
    }
    seenProfiles.add(key);
    const domain = row.websiteDomain;
    if ((!domain && input.requireWebsite) || (domain && seenDomains.has(domain))) { await save(); continue; }
    if (domain) seenDomains.add(domain);
    await runDataset.pushData(row);
    await master.pushData(row);
    output++;
    progress.totalOutput++;
    await save();
    if (output % 10 === 0) log.info('Blue Book companies collected', { companiesOutputThisRun: output, profilesVisited: visited, pendingProfiles: pending.length, totalOutput: progress.totalOutput });
  }
} finally {
  await save();
  await browser.close();
}
log.info('Blue Book campaign run completed', { campaignId, profilesVisited: visited, companiesOutputThisRun: output, pendingProfiles: pending.length, remainingListingPages: listingQueue.length, totalOutput: progress.totalOutput, masterDatasetId: master.id });
await Actor.exit();
