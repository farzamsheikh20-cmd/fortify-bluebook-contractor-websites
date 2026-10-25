const BLOCKED_HOSTS = [
  'thebluebook.com', 'bluebook.com', 'dodgeconstructionnetwork.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'pinterest.com',
  'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'google.com',
  'apple.com', 'feedburner.com'
];

export const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function safeCampaignId(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'bluebook-contractors';
}

export function normalizeUrl(value, base = undefined) {
  try {
    let candidate = clean(value);
    const markdown = candidate.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/i);
    if (markdown) candidate = markdown[2];
    candidate = candidate.replace(/\\~/g, '~').replace(/&amp;/g, '&');
    const url = new URL(candidate, base);
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function isBlueBookProfile(value) {
  try {
    const url = new URL(value);
    return /(^|\.)thebluebook\.com$/i.test(url.hostname) && /^\/iProView\/\d+/i.test(url.pathname);
  } catch { return false; }
}

export function profileKey(value) {
  try { return new URL(value).pathname.match(/^\/iProView\/(\d+)/i)?.[1] || null; }
  catch { return null; }
}

export function canonicalProfileUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized || !isBlueBookProfile(normalized)) return null;
  const url = new URL(normalized);
  const parts = url.pathname.split('/').filter(Boolean);
  url.pathname = `/${parts.slice(0, 3).join('/')}/`;
  url.search = '';
  return url.href;
}

export function domainKey(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
}

function decodeCandidate(value) {
  let result = String(value || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  try { result = decodeURIComponent(result); } catch {}
  return result;
}

export function unwrapExternalUrl(value) {
  try {
    const url = new URL(decodeCandidate(value));
    if (/(^|\.)thebluebook\.com$/i.test(url.hostname)) {
      for (const key of ['url', 'u', 'target', 'redirect', 'redirect_url', 'to']) {
        const nested = url.searchParams.get(key);
        if (nested && /^https?:/i.test(decodeCandidate(nested))) return normalizeUrl(decodeCandidate(nested));
      }
      return null;
    }
    return normalizeUrl(url.href);
  } catch { return null; }
}

export function isExternalWebsite(value) {
  const url = unwrapExternalUrl(value);
  const domain = domainKey(url);
  if (!domain || BLOCKED_HOSTS.some(host => domain === host || domain.endsWith(`.${host}`))) return false;
  return !/\.(?:png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|eot|pdf)(?:$|\?)/i.test(url);
}

export function extractWebsite(html, links = []) {
  const preferred = links
    .filter(link => /website|visit (?:our )?(?:site|website)|company website|web site/i.test(clean(link.text)) || /website/i.test(clean(link.ariaLabel)))
    .map(link => unwrapExternalUrl(link.href))
    .find(isExternalWebsite);
  if (preferred) return preferred;
  const decoded = decodeCandidate(html);
  const section = decoded.match(/(?:Website|Company Website)[\s\S]{0,1200}?href=["']([^"']+)["']/i)?.[1];
  const sectionUrl = unwrapExternalUrl(section);
  if (isExternalWebsite(sectionUrl)) return sectionUrl;
  for (const pattern of [
    /"(?:website|websiteUrl|companyWebsite|externalUrl)"\s*:\s*"(https?:[^"\\]+(?:\\.[^"\\]*)*)"/gi,
    /(?:Website|Company Website)[\s\S]{0,800}?(https?:\/\/[^"'<>\s]+)/gi
  ]) {
    for (const match of decoded.matchAll(pattern)) {
      const candidate = unwrapExternalUrl(match[1]);
      if (isExternalWebsite(candidate)) return candidate;
    }
  }
  return null;
}

export function emailsFrom(value) {
  const matches = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map(email => email.toLowerCase()).filter(email =>
    !/example\.(com|org|net)$/.test(email)
    && !/@(?:thebluebook|bluebook|dodge|sentry|wixpress)\./.test(email)
    && !/\.(?:png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|eot)$/i.test(email)
  ))];
}

export function profilesFromHtml(html, base = 'https://www.thebluebook.com/') {
  const decoded = decodeCandidate(html);
  const candidates = [];
  for (const match of decoded.matchAll(/(?:https?:\/\/(?:www\.)?thebluebook\.com)?\/iProView\/\d+\/[^"'<>\s?#]+(?:\/[^"'<>\s?#]+)?\/?/gi)) {
    const url = canonicalProfileUrl(normalizeUrl(match[0], base));
    if (url) candidates.push(url);
  }
  return [...new Set(candidates)];
}
