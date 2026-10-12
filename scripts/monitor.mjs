// Checks every site in sites.json and updates <dataDir>/status.json.
// Usage: node scripts/monitor.mjs [sites.json] [dataDir]
//
// Optional per-site fields in sites.json:
//   slug            stable id (defaults to a slug of the name)
//   method          HTTP method (default GET)
//   expectedStatus  array of accepted status codes (default: any 2xx/3xx)
//   keyword         text that must appear in the response body
//   timeout         ms before giving up (default 15000)
//   degradedAfter   ms above which the site is shown as "degraded" (default 3000)
//
// When GITHUB_TOKEN and GITHUB_REPOSITORY are set, an issue is opened when a
// site goes down and closed when it recovers (GitHub emails watchers).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [sitesPath = 'sites.json', dataDir = 'data'] = process.argv.slice(2);
const statusPath = join(dataDir, 'status.json');

const DAY_MS = 86_400_000;
const KEEP_DAYS = 90;
const KEEP_INCIDENTS = 100;
const TZ = 'Europe/Lisbon';
const USER_AGENT = 'TimelessExpressionStatus/1.0 (+https://github.com/' + (process.env.GITHUB_REPOSITORY || '') + ')';

const dayKey = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

const slugify = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(site) {
  const started = performance.now();
  try {
    const res = await fetch(site.url, {
      method: site.method || 'GET',
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(site.timeout || 15_000),
    });
    const ms = Math.round(performance.now() - started);
    const okCode = site.expectedStatus ? site.expectedStatus.includes(res.status) : res.status >= 200 && res.status < 400;
    // Cloudflare marks responses from its own bot protection with cf-mitigated.
    let error = okCode ? null : `HTTP ${res.status}`;
    if (!okCode && res.headers.get('cf-mitigated')) error = `Bloqueado pelo Cloudflare (HTTP ${res.status})`;
    else if (res.status === 403 && res.headers.get('server') === 'cloudflare') error = 'HTTP 403 (provável bloqueio do Cloudflare)';
    if (okCode && site.keyword) {
      const body = await res.text();
      if (!body.includes(site.keyword)) error = `Texto "${site.keyword}" não encontrado`;
    } else {
      await res.body?.cancel();
    }
    return { up: !error, code: res.status, ms, error, ray: res.headers.get('cf-ray') };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    const reason = err.name === 'TimeoutError' ? 'Tempo limite excedido' : err.cause?.code || err.message;
    return { up: false, code: 0, ms, error: reason };
  }
}

async function check(site) {
  let result = await probe(site);
  // One retry to avoid flagging transient network blips as outages.
  if (!result.up) {
    await sleep(5_000);
    result = await probe(site);
  }
  return result;
}

async function github(path, method, body) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return await res.json();
  } catch (err) {
    console.warn(`GitHub API ${method} ${path} failed: ${err.message}`);
    return null;
  }
}

async function loadStatus() {
  try {
    return JSON.parse(await readFile(statusPath, 'utf8'));
  } catch {
    return { sites: [], incidents: [] };
  }
}

const config = JSON.parse(await readFile(sitesPath, 'utf8'));
const previous = await loadStatus();
const now = new Date();
const nowMs = now.getTime();
const today = dayKey(now);
const oldestDay = dayKey(new Date(nowMs - (KEEP_DAYS - 1) * DAY_MS));
const incidents = previous.incidents || [];

const sites = config.sites.map((s) => ({ ...s, slug: s.slug || slugify(s.name) }));
const results = await Promise.all(sites.map(check));

const updated = [];
for (const [i, site] of sites.entries()) {
  const result = results[i];
  const prev = previous.sites.find((p) => p.slug === site.slug) || { daily: {}, recent: [] };
  const status = !result.up ? 'down' : result.ms > (site.degradedAfter || 3_000) ? 'degraded' : 'up';

  const daily = Object.fromEntries(Object.entries(prev.daily || {}).filter(([d]) => d >= oldestDay));
  const day = (daily[today] ||= { n: 0, up: 0, ms: 0 });
  day.n += 1;
  if (result.up) {
    day.up += 1;
    day.ms += result.ms;
  }

  const recent = (prev.recent || []).filter(([t]) => t > nowMs - DAY_MS);
  recent.push([nowMs, result.ms, result.up ? 1 : 0]);

  const open = incidents.find((x) => x.slug === site.slug && !x.end);
  if (!result.up && !open) {
    const issue = await github('/issues', 'POST', {
      title: `🔴 ${site.name} está em baixo`,
      body: `**${site.name}** (${site.url}) deixou de responder.\n\n- Motivo: ${result.error}\n- Início: ${now.toISOString()}\n\nEsta issue fecha automaticamente quando o serviço recuperar.`,
      labels: ['incidente'],
    });
    incidents.unshift({
      slug: site.slug,
      name: site.name,
      start: now.toISOString(),
      end: null,
      reason: result.error,
      issue: issue?.number ?? null,
    });
    console.log(`DOWN  ${site.name}: ${result.error}${result.ray ? ` (Cloudflare Ray ID ${result.ray})` : ''}`);
  } else if (result.up && open) {
    open.end = now.toISOString();
    if (open.issue) {
      const mins = Math.max(1, Math.round((nowMs - Date.parse(open.start)) / 60_000));
      await github(`/issues/${open.issue}/comments`, 'POST', {
        body: `🟢 **${site.name}** recuperou após ${mins} min (HTTP ${result.code}, ${result.ms} ms).`,
      });
      await github(`/issues/${open.issue}`, 'PATCH', { state: 'closed' });
    }
    console.log(`UP    ${site.name}: recovered`);
  } else {
    console.log(`${result.up ? 'OK   ' : 'DOWN '} ${site.name}: ${result.code} in ${result.ms} ms${!result.up && result.ray ? ` (Cloudflare Ray ID ${result.ray})` : ''}`);
  }

  updated.push({
    slug: site.slug,
    name: site.name,
    url: site.url,
    description: site.description || '',
    status,
    code: result.code,
    responseTime: result.ms,
    error: result.error,
    lastChecked: now.toISOString(),
    since: prev.status === status && prev.since ? prev.since : now.toISOString(),
    daily,
    recent,
  });
}

await mkdir(dataDir, { recursive: true });
await writeFile(
  statusPath,
  JSON.stringify({ generatedAt: now.toISOString(), sites: updated, incidents: incidents.slice(0, KEEP_INCIDENTS) }) + '\n',
);
