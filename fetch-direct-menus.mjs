#!/usr/bin/env node
/**
* fetch-direct-menus.mjs
*
* タベカル未収録チェーン（directOfficialOnly）の期間限定メニューを
* 各公式サイトから直接取得し、menus.json を生成するスタンドアロンスクリプト。
*
* 取得ロジックは pugyon/Menus の scripts/sync-tabecal.js から移植したもの。
* 外部依存なし（Node 20 組み込み fetch のみ）。永続キャッシュは持たず、
* 取得失敗で0件になったチェーンは既存 menus.json の前回データを維持する。
*
* 出力:./menus.json
* { "generated_at": ISO文字列,
* "chains": { "<slug>": { "name": 表示名, "items": [...]}}}
*/
import { writeFile, readFile} from 'node:fs/promises';
import { dirname, join} from 'node:path';
import { fileURLToPath} from 'node:url';

const OUTPUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'menus.json');
const PRICE_PLACEHOLDER = '店舗公表値';

/* 対象チェーン（pugyon/Menus の chains.json で directOfficialOnly: true の5件と同内容） */
const CHAINS = [
{
id: 'katsuya', name: 'かつや', slug: 'katsuya', domain: 'arclandservice.co.jp',
menuPage: 'https://www.arclandservice.co.jp/katsuya/menu/',
logo: 'https://www.arclandservice.co.jp/katsuya/wp-content/themes/arclandservice-group/assets/img/katsuya/common/logo.svg',
emoji: '🍛', bg: '#f9e0c7', defaultCategory: '期間限定', directOfficialOnly: true, enabled: true
},
{
id: 'karayama', name: 'からやま', slug: 'karayama', domain: 'arclandservice.co.jp',
menuPage: 'https://www.arclandservice.co.jp/karayama/menu/',
logo: 'https://www.arclandservice.co.jp/karayama/wp-content/themes/arclandservice-group/assets/img/karayama/common/logo.svg',
emoji: '🍗', bg: '#fef08a', defaultCategory: '期間限定', directOfficialOnly: true, enabled: true
},
{
id: 'cocos', name: 'ココス', slug: 'cocos-jpn', domain: 'cocos-jpn.co.jp',
menuPage: 'https://www.cocos-jpn.co.jp/menu/',
logo: 'https://www.cocos-jpn.co.jp/files/common/logo.png',
emoji: '🍽️', bg: '#fef3c7', defaultCategory: '期間限定', directOfficialOnly: true, enabled: true
},
{
id: 'sutadonya', name: '伝説のすた丼屋', slug: 'sutadonya', domain: 'sutadonya.com',
menuPage: 'https://sutadonya.com/menu/',
logo: 'https://sutadonya.com/wp/wp-content/themes/sutadon/shared/img/shared/logo.png',
emoji: '🥩', bg: '#fee2e2', defaultCategory: '期間限定', directOfficialOnly: true, enabled: true
},
{
id: 'marugen', name: '丸源ラーメン', slug: 'marugen', domain: 'syodai-marugen.jp',
menuPage: 'https://www.syodai-marugen.jp/menu/season',
logo: 'https://www.syodai-marugen.jp/wp-content/themes/official2026/assets/images/common/logo.svg',
emoji: '🍜', bg: '#fde8e8', defaultCategory: '期間限定', directOfficialOnly: true, enabled: true
}
];

const BROWSER_HEADERS = {
'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function fetchWithRetry(url, timeoutMs = 6000, maxRetries = 1) {
for (let attempt = 1; attempt <= maxRetries; attempt++) {
try {
const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs)});
if (res.ok) return res;
console.warn(`[Fetch Notice] ${url} returned ${res.status}`);
if (res.status === 404) return null;
} catch (err) {
console.warn(`[Fetch Notice] ${url} error (${err.message})`);
if (attempt === maxRetries) return null;
await new Promise(r => setTimeout(r, 400));
}
}
return null;
}

async function fetchText(url, timeoutMs = 8000) {
try {
const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow'});
if (!res.ok) return null;
return await res.text();
} catch {
return null;
}
}

/* =====================================================================
* HTML からの画像候補抽出（og:image / twitter:image / JSON-LD）
* ===================================================================== */
function resolveUrlMaybeRelative(u, base) {
if (!u) return '';
try { return new URL(u, base).href;} catch { return u;}
}

function extractJsonLdImage(html) {
const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
const imageOf = (node) => {
if (!node || typeof node!== 'object') return '';
if (typeof node.image === 'string') return node.image;
if (Array.isArray(node.image)) {
for (const im of node.image) {
if (typeof im === 'string') return im;
if (im && typeof im.url === 'string') return im.url;
}
}
if (node.image && typeof node.image.url === 'string') return node.image.url;
return '';
};
const flatten = (data, acc = []) => {
if (Array.isArray(data)) { data.forEach(d => flatten(d, acc)); return acc;}
if (data && typeof data === 'object') {
acc.push(data);
if (Array.isArray(data['@graph'])) data['@graph'].forEach(d => flatten(d, acc));
}
return acc;
};
const PRODUCT_TYPES = ['Product', 'Recipe', 'MenuItem', 'Article', 'NewsArticle', 'BlogPosting', 'WebPage'];
const typeOf = (node) => {
const t = node['@type'];
return Array.isArray(t)? t.join(' '): (t || '');
};
for (const b of blocks) {
try {
const nodes = flatten(JSON.parse(b[1].trim()));
for (const node of nodes) {
if (PRODUCT_TYPES.some(t => typeOf(node).includes(t))) {
const v = imageOf(node);
if (v) return v;
}
}
for (const node of nodes) {
if (/Person|Organization/i.test(typeOf(node))) continue;
const v = imageOf(node);
if (v) return v;
}
} catch { /* JSON-LDが壊れているページは無視 */}
}
return '';
}

function extractMetaImages(html, baseUrl) {
const get = (re) => { const m = html.match(re); return m? resolveUrlMaybeRelative(m[1], baseUrl): '';};
const og = get(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i)
|| get(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
const twitter = get(/<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
|| get(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
const jsonLd = resolveUrlMaybeRelative(extractJsonLdImage(html), baseUrl);
return { jsonLd, og, twitter};
}

function isGenericImageUrl(u) {
if (!u) return true;
let host = '';
let path = u;
try { const parsed = new URL(u); host = parsed.hostname; path = parsed.pathname;} catch { /* 相対URLなどはパス扱い */}
if (/(^|\.)gravatar\.com$/i.test(host)) return true;
return /(ogp|og_img|og-image|ogimage|logo|default|noimage|no_image|placeholder|avatar)/i.test(path);
}

function extractPageImageNearName(html, name, baseUrl) {
if (!name) return '';
const nameIdx = html.indexOf(name);
if (nameIdx < 0) return '';
const candidates = [];
const re = /(?:https?:)?\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp)/gi;
let m;
while ((m = re.exec(html))!== null) {
const u = resolveUrlMaybeRelative(m[0].startsWith('//')? 'https:' + m[0]: m[0], baseUrl);
if (isGenericImageUrl(u)) continue;
if (!/(menu|cmsimage|uploads|product)/i.test(u)) continue;
candidates.push({ url: u, dist: Math.abs(m.index - nameIdx)});
}
candidates.sort((a, b) => a.dist - b.dist);
return candidates.length && candidates[0].dist < 6000? candidates[0].url: '';
}

function normalizeName(s) {
return (s || '')
.replace(/[\s　]/g, '')
.replace(/[〜～]/g, '〜')
.replace(/[（]/g, '(')
.replace(/[）]/g, ')')
.replace(/[®™]/g, '')
.replace(/坦/g, '担')
.toLowerCase();
}

/* =====================================================================
* 商品リンク（sourceUrl）の品質検証（sync-tabecal.js の classifyItemLink 移植）
* ===================================================================== */
function isDomainRootUrl(u) {
if (!u) return false;
try {
const p = new URL(u).pathname;
return p === '' || p === '/' || /\/index\.(html?|php|shtml)$/i.test(p);
} catch { return false;}
}

function nameMatchKeys(name) {
const n = normalizeName(name);
const keys = new Set();
if (n) keys.add(n);
const stripTail = (s) => s.replace(/\([^()]*\)$/, '');
const stripHead = (s) => s.replace(/^]*】/, '');
for (const v of [stripTail(n), stripHead(n), stripHead(stripTail(n))]) if (v) keys.add(v);
for (let cut = 2; cut <= 8; cut++) {
if (n.length - cut >= 6) keys.add(n.slice(cut));
}
return [...keys].filter(k => k.length >= 3);
}

function nameTokensMatch(name, normalizedHaystack) {
const toks = (name || '').split(/[\s　]+/).map(normalizeName).filter(t => t.length >= 2);
if (toks.length < 2) return false;
return toks.every(t => normalizedHaystack.includes(t));
}

function extractPageTitle(html) {
const m = (html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
return m? m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').trim(): '';
}

function htmlToPlainText(html) {
return (html || '')
.replace(/<script[\s\S]*?<\/script>/gi, ' ')
.replace(/<style[\s\S]*?<\/style>/gi, ' ')
.replace(/<[^>]+>/g, ' ')
.replace(/&[a-z#0-9]+;/gi, ' ');
}

const linkPageCache = new Map();
async function fetchTextCached(url) {
if (!linkPageCache.has(url)) linkPageCache.set(url, await fetchText(url, 9000));
return linkPageCache.get(url);
}

async function classifyItemLink({ name, chain, url}) {
const menuPage = chain?.menuPage || '';
if (!url) return { url: menuPage, quality: 'fallback', reason: 'empty'};
if (menuPage && url === menuPage) return { url, quality: 'fallback', reason: 'menu_page'};
if (isDomainRootUrl(url)) return { url: menuPage || url, quality: 'fallback', reason: 'domain_root'};
const html = await fetchTextCached(url);
if (!html) return { url, quality: 'unverified', reason: 'fetch_failed'};
const title = extractPageTitle(html);
if (title.includes('店のメニュー')) return { url: menuPage || url, quality: 'fallback', reason: 'store_page'};
const keys = nameMatchKeys(name);
const nTitle = normalizeName(title);
if (keys.some(k => nTitle.includes(k)) || nameTokensMatch(name, nTitle)) {
return { url, quality: 'exact', reason: null};
}
const nText = normalizeName(htmlToPlainText(html));
if (keys.some(k => nText.includes(k)) || nameTokensMatch(name, nText)) {
return { url, quality: 'contains', reason: null};
}
return { url, quality: 'unverified', reason: 'name_not_found'};
}

/* =====================================================================
 * 画像リゾルバ（sync-tabecal.js の resolveOfficialImage 移植）
 * 永続キャッシュの代わりに実行内メモリキャッシュのみ使う。
 * 優先順位: メモリキャッシュ → 商品ページ og/JSON-LD → 公式索引ページ
 *           → WordPress REST → Yahoo!画像検索
 * ===================================================================== */
const imageMemCache = new Map(); // `${brand}|${name}` -> result

const menuIndexHtmlCache = new Map();

async function findProductPageOnIndex(chain, name) {
  const menuPage = chain.menuPage;
  if (!menuPage) return '';
  if (!menuIndexHtmlCache.has(menuPage)) {
    menuIndexHtmlCache.set(menuPage, await fetchText(menuPage, 9000));
  }
  const html = menuIndexHtmlCache.get(menuPage);
  if (!html) return '';
  const target = normalizeName(name);
  if (!target) return '';
  const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const text = normalizeName(m[2].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' '));
    if (text.length >= 4 && (text.includes(target) || (target.length >= 5 && target.includes(text)))) {
      const url = resolveUrlMaybeRelative(m[1], menuPage);
      if (url && chain.domain && url.includes(chain.domain)) return url;
    }
  }
  return '';
}

async function resolveViaOgPipeline(pageUrl, chain, name) {
  if (!pageUrl) return null;
  const html = await fetchTextCached(pageUrl);
  if (!html) return null;
  if (extractPageTitle(html).includes('店のメニュー')) return null;
  const { jsonLd, og, twitter } = extractMetaImages(html, pageUrl);
  const onDomain = chain?.domain ? pageUrl.includes(chain.domain) : false;
  for (const [img, method] of [[jsonLd, 'json_ld'], [og, 'og_image'], [twitter, 'og_image']]) {
    if (img && !isGenericImageUrl(img)) {
      return { image: img, sourceUrl: pageUrl, isOfficial: onDomain, method };
    }
  }
  const near = extractPageImageNearName(html, name, pageUrl);
  if (near) {
    return { image: near, sourceUrl: pageUrl, isOfficial: onDomain, method: 'page_img' };
  }
  return null;
}

function wpBaseFromChain(chain) {
  const logo = chain?.logo || '';
  const i = logo.indexOf('/wp-content/');
  return i > 0 ? logo.slice(0, i) : null;
}

async function resolveViaWpRest(chain, name) {
  const base = wpBaseFromChain(chain);
  if (!base) return null;
  try {
    const res = await fetchWithRetry(`${base}/wp-json/wp/v2/search?search=${encodeURIComponent(name)}&per_page=5`, 6000, 1);
    if (!res) return null;
    const arr = await res.json().catch(() => null);
    if (!Array.isArray(arr)) return null;
    for (const hit of arr) {
      if (hit?.url && chain.domain && hit.url.includes(chain.domain)) {
        const og = await resolveViaOgPipeline(hit.url, chain, name);
        if (og) return og;
      }
    }
  } catch { /* WP RESTが無効なサイトでは静かにフォールスルー */ }
  return null;
}

async function searchYahooImages(query, timeoutMs = 4500) {
  const url = `https://search.yahoo.co.jp/image/search?p=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const html = await res.text();
    const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!scriptMatch) return [];
    const data = JSON.parse(scriptMatch[1]);
    return data.props?.initialProps?.pageProps?.algos || [];
  } catch {
    return [];
  }
}

async function resolveViaYahoo(brand, name, chain) {
  const domain = chain?.domain || '';
  const fallbackUrl = chain?.menuPage || (domain ? `https://${domain}/` : 'https://google.com/');
  if (!domain) return null;

  const pickFromAlgos = (algos) => {
    const match = algos.find(r => (r.refererUrl || '').includes(domain) || (r.original?.url || '').includes(domain));
    return match || null;
  };

  const siteAlgos = await searchYahooImages(`${brand} ${name} site:${domain}`);
  const siteMatch = pickFromAlgos(siteAlgos);
  if (siteMatch) {
    const referer = siteMatch.refererUrl || siteMatch.shareUrl || '';
    if (referer && referer.includes(domain)) {
      const og = await resolveViaOgPipeline(referer, chain, name);
      if (og) return og;
    }
    const imgUrl = siteMatch.original?.url || siteMatch.main?.url || siteMatch.imageSrc || '';
    if (imgUrl) {
      return {
        image: imgUrl,
        sourceUrl: referer && referer.includes(domain) ? referer : fallbackUrl,
        isOfficial: true,
        method: 'official_site_search'
      };
    }
  }

  const generalAlgos = await searchYahooImages(`${brand} ${name}`, 4000);
  const generalMatch = pickFromAlgos(generalAlgos);
  if (generalMatch) {
    const referer = generalMatch.refererUrl || generalMatch.shareUrl || '';
    if (referer && referer.includes(domain)) {
      const og = await resolveViaOgPipeline(referer, chain, name);
      if (og) return og;
    }
    const imgUrl = generalMatch.original?.url || generalMatch.main?.url || generalMatch.imageSrc || '';
    if (imgUrl) {
      return {
        image: imgUrl,
        sourceUrl: referer && referer.includes(domain) ? referer : fallbackUrl,
        isOfficial: true,
        method: 'general_official_match'
      };
    }
  }
  if (generalAlgos.length > 0) {
    const top = generalAlgos[0];
    const imgUrl = top.original?.url || top.main?.url || top.imageSrc || '';
    if (imgUrl) {
      return { image: imgUrl, sourceUrl: fallbackUrl, isOfficial: false, method: 'general_top' };
    }
  }
  return null;
}

async function resolveOfficialImage({ brand, name, chain, sourceUrlHint = '' }) {
  const key = `${brand}|${name}`;
  const cached = imageMemCache.get(key);
  if (cached && cached.image) {
    return {
      image: cached.image,
      sourceUrl: cached.sourceUrl || sourceUrlHint || chain?.menuPage || '',
      isOfficial: cached.isOfficial !== false,
      method: cached.method || 'cached'
    };
  }

  const fallbackUrl = chain?.menuPage || sourceUrlHint || '';
  let result = null;

  const isSpecificPage = (u) => u && chain?.menuPage && u !== chain.menuPage && !u.endsWith('/index.html');
  if (!result && isSpecificPage(sourceUrlHint)) {
    result = await resolveViaOgPipeline(sourceUrlHint, chain, name);
    if (result && !result.isOfficial && chain?.domain && !sourceUrlHint.includes(chain.domain)) result = null;
  }

  if (!result && chain) {
    const pageUrl = await findProductPageOnIndex(chain, name);
    if (pageUrl) {
      result = await resolveViaOgPipeline(pageUrl, chain, name);
    }
  }

  if (!result && chain) {
    result = await resolveViaWpRest(chain, name);
  }

  if (!result) {
    result = await resolveViaYahoo(brand, name, chain || {});
    if (result) await new Promise(r => setTimeout(r, 300));
  }

  if (!result) {
    result = { image: '', sourceUrl: sourceUrlHint || fallbackUrl, isOfficial: false, method: 'fallback_menu_page' };
  }
  if (!result.sourceUrl) result.sourceUrl = sourceUrlHint || fallbackUrl;
  if (isDomainRootUrl(result.sourceUrl)) {
    result.sourceUrl = chain?.menuPage || '';
  }

  if (result.image) imageMemCache.set(key, result);
  return result;
}

/* =====================================================================
* 丸源ラーメン（syodai-marugen.jp / WordPress）の期間限定メニュー取得
* 優先順位: (1) WP REST API JSON → (2) RSS → (3) HTML構造パース
* （2026-11-04 時点では REST はサイト側で無効化、RSS はニュース専用のため
* 実効経路は HTML パース）
* ===================================================================== */
const MARUGEN_BASE = 'https://www.syodai-marugen.jp';

function findImgTagByClass(html, classToken) {
const re = /<img[^>]*>/g;
let m;
while ((m = re.exec(html))!== null) {
if (m[0].includes(classToken)) return m[0];
}
return '';
}

function imgAttr(tag, attr) {
if (!tag) return '';
const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
return m? m[1]: '';
}

async function tryMarugenWpRest(chain) {
try {
const res = await fetchWithRetry(`${MARUGEN_BASE}/wp-json/wp/v2/types`, 6000, 1);
if (!res) return null;
const types = await res.json().catch(() => null);
if (!types || typeof types!== 'object' || types.code) return null;
const typeKey = Object.keys(types).find(k => /menu|season/.test(k)
|| /menu|season/.test(types[k]?.rest_base || ''));
if (!typeKey) return null;
const restBase = types[typeKey].rest_base || typeKey;
const listRes = await fetchWithRetry(`${MARUGEN_BASE}/wp-json/wp/v2/${restBase}?per_page=50`, 8000, 1);
if (!listRes) return null;
const posts = await listRes.json().catch(() => null);
if (!Array.isArray(posts)) return null;
const items = [];
for (const p of posts) {
const name = htmlToPlainText(p.title?.rendered || '').replace(/\s+/g, ' ').trim();
if (!name) continue;
const body = htmlToPlainText(p.content?.rendered || '');
const taxM = body.match(/税込\s*([0-9,]+)\s*円/);
items.push({
name,
price: taxM? `¥${taxM[1]}`: '',
detail: '',
image: p._embedded?.['wp:featuredmedia']?.[0]?.source_url || '',
sourceUrl: p.link || chain.menuPage,
periodText: ''
});
}
return items.length > 0? items: null;
} catch {
return null;
}
}

async function tryMarugenRss(chain) {
try {
const xml = await fetchText(`${MARUGEN_BASE}/feed`, 8000);
if (!xml) return null;
const items = [];
for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
const b = m[1];
const link = (b.match(/<link>([^<]+)<\/link>/) || [])[1] || '';
if (!/\/menu\/season/.test(link)) continue;
const rawContent = (b.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/) || [])[1] || '';
const imgM = rawContent.match(/<img[^>]+src="([^"]+)"/);
const body = htmlToPlainText(rawContent);
const taxM = body.match(/税込\s*([0-9,]+)\s*円/);
const title = htmlToPlainText((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
if (!title ||!taxM ||!imgM) continue;
items.push({
name: title,
price: `¥${taxM[1]}`,
detail: '',
image: imgM[1],
sourceUrl: link,
periodText: ''
});
}
return items.length > 0? items: null;
} catch {
return null;
}
}

function extractMarugenPeriod(html) {
const text = htmlToPlainText(html).replace(/\s+/g, ' ');
const cleaned = text.replace(/下記店舗では販売期間が異なります[\s\S]{0,320}/g, '');
const m = cleaned.match(/(20\d\d年\d+月\d+日)\s*[〜～~]\s*(20\d\d年\d+月\d+日)/);
return m? `${m[1]}〜${m[2]}`: '';
}

function parseMarugenSeasonSections(html, pageUrl) {
const out = [];
const secRe = /<section id="menu-\d+"[^>]*>([\s\S]*?)<\/section>/g;
let m;
while ((m = secRe.exec(html))!== null) {
const b = m[1];
const imgTag = findImgTagByClass(b, 'season__menu--img');
const name = imgAttr(imgTag, 'alt').trim();
const src = imgAttr(imgTag, 'src');
if (!name) continue;
const taxM = b.match(/--text--price-tax">（税込([0-9,]+)円）/);
const baseM = b.match(/--text--price">([0-9,]+)/);
const detailM = b.match(/--text--detail">([\s\S]*?)<\/p>/);
out.push({
name,
price: taxM? `¥${taxM[1]}`: (baseM? `¥${baseM[1]}`: ''),
detail: detailM? htmlToPlainText(detailM[1]).replace(/\s+/g, ' ').trim(): '',
image: src? resolveUrlMaybeRelative(src, pageUrl): '',
sourceUrl: pageUrl
});
}
return out;
}

function parseMarugenDessertSection(html, pageUrl) {
const secM = html.match(/<section class="seasonDessert"[^>]*>([\s\S]*?)<\/section>/);
if (!secM) return [];
const b = secM[1];
let name = imgAttr(findImgTagByClass(b, 'season__container--title'), 'alt').trim();
if (!name) name = extractPageTitle(html).replace(/\s*[|｜].*$/, '').trim();
if (!name) return [];
const src = imgAttr(findImgTagByClass(b, 'seasonDessert--img'), 'src');
const taxM = b.match(/seasonDessert--text--price-tax">（税込([0-9,]+)円）/);
const baseM = b.match(/seasonDessert--text--price">([0-9,]+)/);
const descM = b.match(/seasonDessert--text--description[^>]*>([\s\S]*?)<\/div>/);
return [{
name,
price: taxM? `¥${taxM[1]}`: (baseM? `¥${baseM[1]}`: ''),
detail: descM? htmlToPlainText(descM[1]).replace(/\s+/g, ' ').trim(): '',
image: src? resolveUrlMaybeRelative(src, pageUrl): '',
sourceUrl: pageUrl
}];
}

function marugenToItem(chain, r, idx) {
return {
id: `marugen_lim_${idx + 1}`,
brand: chain.name,
brandSlug: chain.slug || chain.id,
category: '期間限定',
name: r.name,
description: r.detail
? `${r.detail}`
: '',
price: r.price || '店舗公表値',
sourceUrl: r.sourceUrl || chain.menuPage,
emoji: chain.emoji || '🍜',
bg: chain.bg || '#fde8e8',
isLimited: true,
isNew: true,
isOfficial: true,
sourceDate: r.periodText? `販売期間: ${r.periodText}`: '期間限定メニュー',
image: r.image || ''
};
}

async function fetchMarugenLimitedMenus(chain) {
const restItems = await tryMarugenWpRest(chain);
if (restItems && restItems.length > 0) {
console.log(`[Marugen] WP REST API から ${restItems.length} 件取得`);
return restItems.map((it, i) => marugenToItem(chain, it, i));
}
const rssItems = await tryMarugenRss(chain);
if (rssItems && rssItems.length > 0) {
console.log(`[Marugen] RSS から ${rssItems.length} 件取得`);
return rssItems.map((it, i) => marugenToItem(chain, it, i));
}
const listUrls = [...new Set([chain.menuPage, `${MARUGEN_BASE}/menu/season_dessert`])];
const productUrls = [];
for (const lu of listUrls) {
const html = await fetchText(lu, 9000);
if (!html) continue;
for (const m of html.matchAll(/href="(https:\/\/www\.syodai-marugen\.jp\/menu\/season(?:_dessert)?\/[a-zA-Z0-9_\-]+)"/g)) {
if (!productUrls.includes(m[1])) productUrls.push(m[1]);
}
}
const items = [];
for (const url of productUrls.slice(0, 8)) {
const html = await fetchText(url, 9000);
if (!html) continue;
const periodText = extractMarugenPeriod(html);
const raw = [...parseMarugenSeasonSections(html, url),...parseMarugenDessertSection(html, url)];
for (const r of raw) {
if (!r.name || items.some(i => i.name === r.name)) continue;
items.push(marugenToItem(chain, {...r, periodText}, items.length));
}
}
console.log(`[Marugen] HTMLパースで ${items.length} 件取得（商品ページ ${productUrls.length} 件を巡回）`);
return items;
}

/* =====================================================================
* 公式サイト直接パース（sync-tabecal.js の fetchOfficialLimitedMenus 移植）
* ===================================================================== */
async function fetchOfficialLimitedMenus(chain) {
const items = [];
const domain = chain.domain || '';

try {
if (chain.slug === 'marugen' || chain.name === '丸源ラーメン' || domain.includes('syodai-marugen')) {
return await fetchMarugenLimitedMenus(chain);
}

// かつや公式の期間限定メニュー直接パース
if (chain.slug === 'katsuya' || chain.name === 'かつや') {
const res = await fetch('https://www.arclandservice.co.jp/katsuya/menu/', {
headers: { 'User-Agent': 'Mozilla/5.0'},
signal: AbortSignal.timeout(6000)
});
if (res.ok) {
const html = await res.text();
const regex = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*menu-list__link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
let m;
while ((m = regex.exec(html))!== null) {
const url = m[1];
const block = m[2];
if (block.includes('期間限定')) {
const nameM = block.match(/class="menu-list__name">([^<]+)</);
const taxPriceM = block.match(/class="menu-price__tax">([^<]+)</);
const numPriceM = block.match(/class="menu-price__number--katsuya">([^<]+)</);
const bgM = block.match(/url\(([^)]+)\)/i);
const name = nameM? nameM[1].trim(): '';
if (!name) continue;
if (name.endsWith('弁当') || url.includes('TO-') || (bgM && bgM[1].includes('TO-'))) continue;
const price = taxPriceM? taxPriceM[1].trim(): (numPriceM? `¥${numPriceM[1].trim()}`: '店舗公表値');
const img = bgM? bgM[1].replace(/['"]/g, '').trim(): '';
if (!items.some(it => it.name === name)) {
items.push({
id: `katsuya_lim_${items.length + 1}`,
brand: chain.name,
brandSlug: chain.slug || chain.id,
category: '期間限定',
name: name,
description: `${price}。かつや公式発表の期間限定・新メニュー`,
price: price,
sourceUrl: url,
emoji: chain.emoji || '🍛',
bg: chain.bg || '#f9e0c7',
isLimited: true,
isNew: true,
isOfficial: true,
sourceDate: '期間限定メニュー',
image: img
});
}
}
}
}
return items;
}

// からやま公式の期間限定メニュー直接パース
if (chain.slug === 'karayama' || chain.name === 'からやま') {
const res = await fetch('https://www.arclandservice.co.jp/karayama/menu/', {
headers: { 'User-Agent': 'Mozilla/5.0'},
signal: AbortSignal.timeout(6000)
});
if (res.ok) {
const html = await res.text();
const regex = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*menu-list__link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
let m;
while ((m = regex.exec(html))!== null) {
const url = m[1];
const block = m[2];
if (block.includes('期間限定')) {
const nameM = block.match(/class="menu-list__name">([^<]+)</);
const taxPriceM = block.match(/class="menu-price__tax">([^<]+)</);
const numPriceM = block.match(/class="menu-price__number--karayama">([^<]+)</) || block.match(/class="menu-price__number">([^<]+)</);
const bgM = block.match(/url\(([^)]+)\)/i);
const name = nameM? nameM[1].trim(): '';
if (!name) continue;
if (name.endsWith('弁当') || url.includes('TO-') || (bgM && bgM[1].includes('TO-'))) continue;
const price = taxPriceM? taxPriceM[1].trim(): (numPriceM? `¥${numPriceM[1].trim()}`: '店舗公表値');
const img = bgM? bgM[1].replace(/['"]/g, '').trim(): '';
if (!items.some(it => it.name === name)) {
items.push({
id: `karayama_lim_${items.length + 1}`,
brand: chain.name,
brandSlug: chain.slug || chain.id,
category: '期間限定',
name: name,
description: `${price}。からやま公式発表の期間限定・新メニュー`,
price: price,
sourceUrl: url,
emoji: chain.emoji || '🍗',
bg: chain.bg || '#fef08a',
isLimited: true,
isNew: true,
isOfficial: true,
sourceDate: '期間限定メニュー',
image: img
});
}
}
}
}
return items;
}

// 伝説のすた丼屋公式のおすすめ・新メニュー・期間限定メニュー直接パース
if (chain.slug === 'sutadonya' || chain.name.includes('すた丼') || domain.includes('sutadonya')) {
const res = await fetch('https://sutadonya.com/menu/', {
headers: { 'User-Agent': 'Mozilla/5.0'},
signal: AbortSignal.timeout(8000)
});
if (res.ok) {
const html = await res.text();
const sliderMatch = html.match(/おすすめメニュー[\s\S]*?<div class="slider">([\s\S]*?)<\/div>/i);
if (sliderMatch) {
const slides = [...sliderMatch[1].matchAll(/<a href="([^"]+)"[^>]*>[\s\S]*?<img src="([^"]+)" alt="([^"]+)"/gi)];
for (const s of slides) {
const link = s[1];
const img = s[2];
const alt = s[3];
const nameM = alt.match(/「([^」]+)」/);
let name = nameM? nameM[1].trim(): alt.replace(/^[0-9\/\(（）\)\s～〜]+[販売開始中！]+/, '').trim();
if (alt.includes('チャーハン')) name = 'すた丼屋流 チャーハン';
if (name === chain.name || name.includes('新業態') || name.includes('オープン') || name.includes('DNA')) continue;
if (name &&!items.some(i => i.name === name)) {
items.push({
id: `sutadon_lim_${items.length + 1}`,
brand: chain.name,
brandSlug: chain.slug || chain.id,
category: '期間限定',
name: name,
description: `${alt}`,
price: '店舗公表値',
sourceUrl: link,
emoji: chain.emoji || '🥩',
bg: chain.bg || '#fee2e2',
isLimited: true,
isNew: true,
isOfficial: true,
sourceDate: '新メニュー・期間限定',
image: img
});
}
}
}
}

try {
const resNews = await fetch('https://sutadonya.com/category/news/', {
headers: { 'User-Agent': 'Mozilla/5.0'},
signal: AbortSignal.timeout(8000)
});
if (resNews.ok) {
const htmlNews = await resNews.text();
const newsLinks = [...htmlNews.matchAll(/<a[^>]*href="([^"]*\/[0-9]{4}\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
for (const nl of newsLinks.slice(0, 15)) {
const link = nl[1];
const text = nl[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
if ((text.includes('販売開始') || text.includes('販売中') || text.includes('新登場') || text.includes('期間限定')) && text.includes('「')) {
const nameM = text.match(/「([^」]+)」/);
if (nameM) {
const name = nameM[1].trim();
if (name === chain.name || name.includes('特典') || name.includes('ポイントカード') || name.includes('新業態') || name.includes('オープン')) continue;
if (!items.some(i => i.name === name)) {
let img = '';
try {
const artRes = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0'}, signal: AbortSignal.timeout(4000)});
if (artRes.ok) {
const artHtml = await artRes.text();
const imgM = artHtml.match(/<article[\s\S]*?<img[^>]*src="([^"]+)"/i) || artHtml.match(/<div class="post-thumb"[\s\S]*?<img[^>]*src="([^"]+)"/i);
if (imgM) img = imgM[1];
}
} catch (e) {}

items.push({
id: `sutadon_lim_${items.length + 1}`,
brand: chain.name,
brandSlug: chain.slug || chain.id,
category: '期間限定',
name: name,
description: `${text.slice(0, 45)}...`,
price: '店舗公表値',
sourceUrl: link,
emoji: chain.emoji || '🥩',
bg: chain.bg || '#fee2e2',
isLimited: true,
isNew: true,
isOfficial: true,
sourceDate: '新メニュー・期間限定',
image: img
});
}
}
}
}
}
} catch (e) {
console.warn(`[Sutadon News Warning]:`, e.message);
}
return items;
}

// ココス公式の期間限定・フェアメニュー直接パース
if (chain.slug === 'cocos' || chain.slug === 'cocos-jpn' || chain.name === 'ココス' || domain.includes('cocos-jpn')) {
const menuRes = await fetch('https://www.cocos-jpn.co.jp/menu/', {
headers: { 'User-Agent': 'Mozilla/5.0'},
signal: AbortSignal.timeout(8000)
});
if (menuRes.ok) {
const html = await menuRes.text();
const fairLinks = [...html.matchAll(/<a[^>]*href="(\/menu_contents\/[a-zA-Z0-9_\-]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi)]
.map(m => 'https://www.cocos-jpn.co.jp' + m[1])
.filter((v, i, a) => a.indexOf(v) === i);

for (const fairUrl of fairLinks.slice(0, 4)) {
try {
const fRes = await fetch(fairUrl, {
headers: { 'User-Agent': 'Mozilla/5.0'},
signal: AbortSignal.timeout(6000)
});
if (!fRes.ok) continue;
const fHtml = await fRes.text();

const cardMatches = [...fHtml.matchAll(/<li[^>]*class="[^"]*box_c[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)];
for (const cm of cardMatches) {
const block = cm[1];
const imgM = block.match(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/i);
const nameM = block.match(/<h3[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i) || block.match(/<h3[^>]*>([^<]+)<\/h3>/i);
const name = (nameM? nameM[1]: (imgM? imgM[2]: '')).trim();
if (!name || name === 'おすすめフェア・メニュー' || name.includes("Coco's App") || name.includes('公式SNS')) continue;

const taxInM = block.match(/class="tax_in"[^>]*>\(?<span>税込<\/span>([^<)]+)\)?/i) || block.match(/<span>税込<\/span>\s*¥?\s*([0-9,]+)/i);
const taxExM = block.match(/class="tax_ex"[^>]*><span>¥<\/span>([0-9,]+)/i);
let price = '店舗公表値';
if (taxInM) {
price = '税込¥' + taxInM[1].replace(/[^0-9,]/g, '').trim();
} else if (taxExM) {
price = '¥' + taxExM[1].trim();
}

const descM = block.match(/class="item_desc"[^>]*>([\s\S]*?)<\/p>/i);
const desc = descM? descM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(): '';

const linkM = block.match(/<a[^>]*href="([^"]+)"[^>]*class="btn"/i) || block.match(/<a[^>]*href="([^"]+)"/i);
const link = linkM? (linkM[1].startsWith('http')? linkM[1]: 'https://www.cocos-jpn.co.jp' + linkM[1]): fairUrl;

let img = '';
if (imgM) {
img = imgM[1].startsWith('http')? imgM[1]: 'https://www.cocos-jpn.co.jp' + imgM[1];
}

if (!items.some(i => i.name === name)) {
items.push({
id: `cocos_lim_${items.length + 1}`,
brand: chain.name,
brandSlug: chain.slug || chain.id,
category: '期間限定',
name: name,
description: desc? `${desc.slice(0, 50)}...`: `${price}。季節の限定メニュー`,
price: price,
sourceUrl: link,
emoji: chain.emoji || '🍽️',
bg: chain.bg || '#fef3c7',
isLimited: true,
isNew: true,
isOfficial: true,
sourceDate: '限定フェア・今月のグルメ',
image: img
});
}
}
} catch (e) {
console.warn(`[Cocos Fair Warning] ${fairUrl}:`, e.message);
}
}
}
return items;
}
} catch (err) {
console.warn(`[Official Parser Warning] ${chain.name}:`, err.message);
}

return items;
}

/* =====================================================================
 * 価格リゾルバ（sync-tabecal.js の該当部分を移植）
 * '店舗公表値' の項目だけを対象にする（永続価格キャッシュは持たない）。
 * ===================================================================== */
function formatPriceYen(n) {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

function parsePriceNumber(s) {
  const n = parseInt(String(s ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolvePriceSutadonya(item) {
  const url = item.sourceUrl || '';
  if (!url.includes('sutadonya.com')) return null;
  const html = await fetchTextCached(url);
  if (!html) return null;
  const text = htmlToPlainText(html)
    .replace(/([0-9])[\s　]*,[\s　]*([0-9])/g, '$1,$2')
    .replace(/([0-9])[\s　]+([0-9])/g, '$1$2');
  const variants = [...new Set([item.name, item.name.replace(/^すた丼屋流\s*/, '')])].filter(v => v.length >= 2);
  const patterns = [
    /通常価格\s*[0-9,]+\s*円\s*[（(]\s*税込\s*([0-9,]+)\s*円\s*[）)]/,
    /[0-9,]+\s*円\s*[（(]\s*税込\s*([0-9,]+)\s*円\s*[）)]/,
    /([0-9,]+)\s*円\s*[（(]\s*税込\s*[）)]/
  ];
  const occurrences = [];
  for (const v of variants) {
    let idx = text.indexOf(v);
    while (idx !== -1) {
      const before = idx === 0 ? '' : text[idx - 1];
      if (!/[ぁ-んァ-ヶ一-龥々]/.test(before)) occurrences.push({ idx, end: idx + v.length });
      idx = text.indexOf(v, idx + 1);
    }
  }
  for (const re of patterns) {
    for (const o of occurrences) {
      const seg = text.slice(o.end, o.end + 90);
      const m = seg.match(re);
      if (m && m.index <= 25) {
        const p = parsePriceNumber(m[1]);
        if (p != null) return { price: formatPriceYen(p), method: 'sutadonya_news_article' };
      }
    }
  }
  for (const re of patterns) {
    for (const o of occurrences) {
      const m = text.slice(o.idx, o.idx + 240).match(re);
      if (m) {
        const p = parsePriceNumber(m[1]);
        if (p != null) return { price: formatPriceYen(p), method: 'sutadonya_news_article' };
      }
    }
  }
  return null;
}

async function resolvePriceGeneric(item, chain) {
  const url = item.sourceUrl || '';
  if (!url || url === chain?.menuPage || isDomainRootUrl(url)) return null;
  const html = await fetchTextCached(url);
  if (!html) return null;
  const text = htmlToPlainText(html);
  const idx = text.indexOf(item.name);
  if (idx === -1) return null;
  const win = text.slice(idx, idx + 200);
  const m = win.match(/[（(]\s*税込\s*[¥￥]?\s*([0-9,]+)\s*円?\s*[）)]/)
    || win.match(/([0-9,]+)\s*円\s*[（(]\s*税込\s*[）)]/);
  if (m) {
    const p = parsePriceNumber(m[1]);
    if (p != null) return { price: formatPriceYen(p), method: 'generic_page_tax_price' };
  }
  return null;
}

async function resolveItemPrice(item, chain) {
  const slug = chain?.slug || item.brandSlug || '';
  try {
    if (slug === 'sutadonya') return await resolvePriceSutadonya(item);
    return await resolvePriceGeneric(item, chain);
  } catch (err) {
    console.warn(`[Price] ${item.brand}「${item.name}」の価格解決中にエラー:`, err.message);
    return null;
  }
}

/* =====================================================================
 * メイン処理
 * ===================================================================== */
async function main() {
  // 前回の menus.json（取得失敗チェーンのデータ維持用）
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUTPUT_PATH, 'utf-8'));
  } catch { /* 初回は無し */ }

  const chainsOut = {};
  const warnings = [];
  let total = 0;

  for (const chain of CHAINS) {
    const slug = chain.slug || chain.id;
    console.log(`[Fetch] ${chain.name} (${slug}) 取得中...`);
    let items = [];
    try {
      items = await fetchOfficialLimitedMenus(chain);
    } catch (err) {
      console.warn(`[Fetch] ${chain.name}: 取得エラー`, err.message);
      items = [];
    }

    // 公式パース由来で画像が無い項目は、統合パイプラインで補完する
    if (items.length > 0) {
      for (const it of items) {
        if (!it.image) {
          const resolved = await resolveOfficialImage({
            brand: it.brand,
            name: it.name,
            chain,
            sourceUrlHint: it.sourceUrl || ''
          });
          if (resolved.image) {
            it.image = resolved.image;
            it.isOfficial = resolved.isOfficial;
            it.imageMethod = resolved.method;
            if (resolved.sourceUrl && resolved.sourceUrl !== chain.menuPage) it.sourceUrl = resolved.sourceUrl;
          }
        }
      }

      // 商品リンク（sourceUrl）品質の監査
      for (const it of items) {
        const r = await classifyItemLink({ name: it.name, chain, url: it.sourceUrl || '' });
        if (r.url !== (it.sourceUrl || '')) it.sourceUrl = r.url;
      }

      // 価格リゾルバ（'店舗公表値' の項目のみ）
      for (const it of items) {
        if (!it.price || it.price === PRICE_PLACEHOLDER) {
          const r = await resolveItemPrice(it, chain);
          if (r?.price) {
            it.price = r.price;
            it.priceMethod = r.method;
          } else {
            it.price = PRICE_PLACEHOLDER;
          }
        }
      }
    }

    // 0件のチェーンは前回データを維持する（元パイプラインと同じ方針）
    if (items.length === 0) {
      const prevItems = previous?.chains?.[slug]?.items;
      if (Array.isArray(prevItems) && prevItems.length > 0) {
        items = prevItems;
        warnings.push(`${chain.name}: 今回0件のため前回データ（${prevItems.length}件）を維持`);
      } else {
        warnings.push(`${chain.name}: 0件（前回データも無し）`);
      }
    }

    chainsOut[slug] = { name: chain.name, items };
    total += items.length;
    console.log(`[Fetch] ${chain.name}: ${items.length} 件`);
  }

  const out = {
    generated_at: new Date().toISOString(),
    chains: chainsOut
  };
  await writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`[Done] menus.json を生成しました（全 ${total} 件）`);
  for (const w of warnings) console.warn(`[Warning] ${w}`);

  if (total === 0) {
    console.error('[Error] 全チェーン0件のため異常終了します');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
