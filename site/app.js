(() => {
    'use strict';

    const TZ = 'Europe/Lisbon';
    const DAY = 86_400_000;
    const DAYS = 90;
    const REFRESH_MS = 60_000;

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dayLabelFmt = new Intl.DateTimeFormat('pt-PT', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const dateTimeFmt = new Intl.DateTimeFormat('pt-PT', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const timeFmt = new Intl.DateTimeFormat('pt-PT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    const relFmt = new Intl.RelativeTimeFormat('pt-PT', { numeric: 'auto' });

    const STATUS_LABEL = { up: 'Operacional', degraded: 'Lento', down: 'Em baixo' };

    let data = null;
    let source = null;

    // ── helpers ──────────────────────────────────────────────

    function lastDays(n) {
        const today = Date.parse(dayKeyFmt.format(new Date()) + 'T12:00:00Z');
        return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY).toISOString().slice(0, 10));
    }

    function pct(v, digits = 2) {
        if (v == null || Number.isNaN(v)) return '—';
        if (v >= 100) return '100%';
        return v.toFixed(digits).replace('.', ',') + '%';
    }

    function ms(v) {
        if (v == null || Number.isNaN(v)) return '—';
        return v >= 1000 ? (v / 1000).toFixed(2).replace('.', ',') + ' s' : Math.round(v) + ' ms';
    }

    function ago(iso) {
        const diff = (Date.parse(iso) - Date.now()) / 1000;
        const abs = Math.abs(diff);
        if (abs < 60) return 'agora mesmo';
        if (abs < 3600) return relFmt.format(Math.round(diff / 60), 'minute');
        if (abs < 86400) return relFmt.format(Math.round(diff / 3600), 'hour');
        return relFmt.format(Math.round(diff / 86400), 'day');
    }

    function duration(fromIso, toIso) {
        const mins = Math.max(1, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 60_000));
        if (mins < 60) return `${mins} min`;
        const h = Math.floor(mins / 60), m = mins % 60;
        if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
        const d = Math.floor(h / 24);
        return `${d} d ${h % 24} h`;
    }

    function uptimeFor(site, days) {
        let n = 0, up = 0;
        for (const key of lastDays(days)) {
            const d = site.daily[key];
            if (d) { n += d.n; up += d.up; }
        }
        return n ? (up / n) * 100 : null;
    }

    function uptime24h(site) {
        const r = site.recent || [];
        return r.length ? (r.filter((x) => x[2]).length / r.length) * 100 : null;
    }

    function avgResponse(site) {
        const ok = (site.recent || []).filter((x) => x[2]);
        return ok.length ? ok.reduce((s, x) => s + x[1], 0) / ok.length : null;
    }

    function level(day) {
        if (!day || !day.n) return 'none';
        const u = (day.up / day.n) * 100;
        if (u >= 99.9) return 'full';
        if (u >= 99) return 'high';
        if (u >= 95) return 'mid';
        return 'low';
    }

    function hostname(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
    }

    // ── data ────────────────────────────────────────────────

    async function resolveSource() {
        try {
            const res = await fetch('config.json', { cache: 'no-store' });
            if (res.ok) {
                const cfg = await res.json();
                if (cfg.repo) return `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch || 'data'}/status.json`;
            }
        } catch { /* local preview */ }
        return 'data/status.json';
    }

    async function load() {
        source ||= await resolveSource();
        const res = await fetch(`${source}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    // ── render ──────────────────────────────────────────────

    function renderHero() {
        const hero = document.querySelector('.hero');
        const down = data.sites.filter((s) => s.status === 'down');
        const slow = data.sites.filter((s) => s.status === 'degraded');
        let state = 'up', title, sub;

        if (!data.sites.length) {
            title = 'Sem serviços <em>configurados</em>';
            sub = 'Adicione websites ao ficheiro sites.json para começar a monitorizar.';
        } else if (down.length) {
            state = 'down';
            title = down.length === data.sites.length
                ? 'Interrupção <em>geral</em>'
                : `Interrupção <em>${down.length === 1 ? 'parcial' : 'em ' + down.length + ' serviços'}</em>`;
            sub = `${down.map((s) => esc(s.name)).join(', ')} ${down.length === 1 ? 'está' : 'estão'} indisponível. A equipa já foi notificada.`;
        } else if (slow.length) {
            state = 'degraded';
            title = 'Desempenho <em>reduzido</em>';
            sub = `${slow.map((s) => esc(s.name)).join(', ')} ${slow.length === 1 ? 'está' : 'estão'} a responder mais devagar do que o habitual.`;
        } else {
            title = 'Todos os sistemas <em>operacionais</em>';
            sub = 'Todos os serviços estão a funcionar normalmente. Verificamos cada um a cada cinco minutos.';
        }

        const ageMin = (Date.now() - Date.parse(data.generatedAt)) / 60_000;
        if (ageMin > 30) sub += ` <br>Última atualização dos dados ${ago(data.generatedAt)}.`;

        hero.dataset.state = state;
        $('overall').innerHTML = title;
        $('overall-sub').innerHTML = sub;
        $('eyebrow').textContent = { up: 'Estado dos serviços', degraded: 'Em observação', down: 'Incidente em curso' }[state];
    }

    function renderStats() {
        const sites = data.sites;
        const ups = sites.map((s) => uptimeFor(s, 30)).filter((v) => v != null);
        const rts = sites.map(avgResponse).filter((v) => v != null);
        const avgUp = ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : null;
        const avgRt = rts.length ? rts.reduce((a, b) => a + b, 0) / rts.length : null;

        $('stat-uptime').textContent = pct(avgUp);
        $('stat-response').innerHTML = avgRt == null ? '—' : avgRt >= 1000
            ? `${(avgRt / 1000).toFixed(2).replace('.', ',')}<small>s</small>`
            : `${Math.round(avgRt)}<small>ms</small>`;
        $('stat-count').textContent = sites.length;
        $('stat-checked').textContent = ago(data.generatedAt);
        $('stat-checked').title = dateTimeFmt.format(new Date(data.generatedAt));
    }

    function chartSvg(site) {
        const pts = site.recent || [];
        if (pts.length < 2) return '<p class="chart-empty">Ainda a recolher dados de tempo de resposta.</p>';

        const W = 600, H = 120;
        const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
        const ok = pts.filter((p) => p[2]);
        const max = Math.max(200, ...ok.map((p) => p[1])) * 1.15;
        const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
        const y = (v) => H - (v / max) * H;

        let line = '', started = false;
        for (const p of pts) {
            if (!p[2]) { started = false; continue; }
            line += `${started ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`;
            started = true;
        }
        const area = ok.length
            ? `M${x(ok[0][0]).toFixed(1)},${H}` + ok.map((p) => `L${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('') + `L${x(ok[ok.length - 1][0]).toFixed(1)},${H}Z`
            : '';
        const fails = pts.filter((p) => !p[2]).map((p) => `<line class="fail" x1="${x(p[0])}" x2="${x(p[0])}" y1="${H - 10}" y2="${H}"/>`).join('');
        const id = `fill-${site.slug}`;
        const minV = ok.length ? Math.min(...ok.map((p) => p[1])) : null;
        const maxV = ok.length ? Math.max(...ok.map((p) => p[1])) : null;

        return `
            <div class="chart-head"><span>Tempo de resposta · 24h</span><span>mín <b>${ms(minV)}</b> · méd <b>${ms(avgResponse(site))}</b> · máx <b>${ms(maxV)}</b></span></div>
            <div class="chart" data-slug="${esc(site.slug)}">
                <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfico de tempo de resposta nas últimas 24 horas">
                    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0" stop-color="#C8A96E" stop-opacity="0.28"/><stop offset="1" stop-color="#C8A96E" stop-opacity="0"/>
                    </linearGradient></defs>
                    <line class="grid" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>
                    <line class="grid" x1="0" x2="${W}" y1="${H}" y2="${H}"/>
                    <path d="${area}" fill="url(#${id})"/>
                    <path class="line" d="${line}"/>
                    ${fails}
                    <line class="cursor-line" x1="0" x2="0" y1="0" y2="${H}"/>
                </svg>
            </div>
            <div class="chart-axis"><span>${timeFmt.format(new Date(t0))}</span><span>${timeFmt.format(new Date(t1))}</span></div>`;
    }

    function renderServices(openSlugs) {
        const days = lastDays(DAYS);
        $('services').innerHTML = data.sites.map((s) => {
            const bars = days.map((k) => {
                const d = s.daily[k];
                return `<span class="bar lv-${level(d)}" tabindex="0" data-day="${k}" aria-label="${k}"></span>`;
            }).join('');
            const u90 = uptimeFor(s, DAYS), u45 = uptimeFor(s, 45);
            return `
            <li class="svc" data-status="${s.status}" data-slug="${esc(s.slug)}">
                <div class="svc-head">
                    <span class="svc-dot" aria-hidden="true"></span>
                    <div class="svc-id">
                        <h3>${esc(s.name)}</h3>
                        <div class="svc-sub">
                            <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(hostname(s.url))}</a>
                            ${s.description ? `<span>${esc(s.description)}</span>` : ''}
                        </div>
                    </div>
                    <div class="svc-meta">
                        <span class="pill">${STATUS_LABEL[s.status]}</span>
                        <span class="svc-ms" title="${s.error ? esc(s.error) : 'Último tempo de resposta'}">${s.status === 'down' ? esc(s.error || 'Sem resposta') : ms(s.responseTime)}</span>
                    </div>
                </div>
                <div class="bars" aria-label="Disponibilidade diária">${bars}</div>
                <div class="bars-legend">
                    <span><span class="d90">90 dias</span><span class="d45">45 dias</span></span>
                    <span class="rule"></span>
                    <span><strong><span class="d90">${pct(u90)}</span><span class="d45">${pct(u45)}</span></strong> disponível</span>
                    <span class="rule"></span>
                    <span>Hoje</span>
                </div>
                <details${openSlugs.has(s.slug) ? ' open' : ''}>
                    <summary>Detalhes</summary>
                    <div class="panel">
                        <div class="periods">
                            <div class="period"><span>24 horas</span><b>${pct(uptime24h(s))}</b></div>
                            <div class="period"><span>7 dias</span><b>${pct(uptimeFor(s, 7))}</b></div>
                            <div class="period"><span>30 dias</span><b>${pct(uptimeFor(s, 30))}</b></div>
                            <div class="period"><span>90 dias</span><b>${pct(u90)}</b></div>
                        </div>
                        <div>${chartSvg(s)}</div>
                    </div>
                </details>
            </li>`;
        }).join('');
    }

    function renderIncidents() {
        const cutoff = Date.now() - DAYS * DAY;
        const list = (data.incidents || []).filter((i) => !i.end || Date.parse(i.start) > cutoff).slice(0, 20);
        if (!list.length) {
            $('incidents').innerHTML = `
                <li class="empty"><svg aria-hidden="true"><use href="#mark"/></svg>
                <span>Sem incidentes registados nos últimos 90 dias.</span></li>`;
            return;
        }
        const repo = source && source.startsWith('https://raw.githubusercontent.com/') ? source.split('/').slice(3, 5).join('/') : null;
        $('incidents').innerHTML = list.map((i) => `
            <li class="inc${i.end ? '' : ' inc--open'}">
                <span class="svc-dot" aria-hidden="true"></span>
                <span class="inc-title">${esc(i.name)} <small>${esc(i.reason || '')}</small></span>
                <span class="pill">${i.end ? 'Resolvido' : 'Em curso'}</span>
                <span class="inc-when">${dateTimeFmt.format(new Date(i.start))} · ${duration(i.start, i.end)}${
                    repo && i.issue ? ` · <a href="https://github.com/${repo}/issues/${i.issue}" target="_blank" rel="noopener">#${i.issue}</a>` : ''}</span>
            </li>`).join('');
    }

    function render() {
        const openSlugs = new Set([...document.querySelectorAll('.svc details[open]')].map((d) => d.closest('.svc').dataset.slug));
        renderHero();
        renderStats();
        renderServices(openSlugs);
        renderIncidents();
    }

    function renderError(err) {
        document.querySelector('.hero').dataset.state = 'degraded';
        $('overall').innerHTML = 'Dados <em>indisponíveis</em>';
        $('overall-sub').textContent = 'Não foi possível obter o estado dos serviços. A página volta a tentar automaticamente.';
        $('services').innerHTML = '';
        console.error(err);
    }

    // ── tooltip ─────────────────────────────────────────────

    const tip = $('tip');

    function showTip(html, x, y) {
        tip.innerHTML = html;
        tip.hidden = false;
        const r = tip.getBoundingClientRect();
        const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
        const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
    }

    function hideTip() {
        tip.hidden = true;
    }

    function barTip(bar) {
        const site = data.sites.find((s) => s.slug === bar.closest('.svc').dataset.slug);
        const key = bar.dataset.day;
        const d = site.daily[key];
        const label = dayLabelFmt.format(new Date(key + 'T12:00:00Z'));
        const body = d && d.n
            ? `<span>${pct((d.up / d.n) * 100)} disponível</span><span>${d.up ? ms(d.ms / d.up) + ' de média' : 'Sem respostas'}</span>${d.n - d.up ? `<span>${d.n - d.up} falha${d.n - d.up > 1 ? 's' : ''} em ${d.n} verificações</span>` : ''}`
            : '<span>Sem dados</span>';
        const r = bar.getBoundingClientRect();
        showTip(`<b>${label}</b>${body}`, r.left + r.width / 2, r.top);
    }

    document.addEventListener('pointerover', (e) => {
        const bar = e.target.closest?.('.bar');
        if (bar) barTip(bar);
    });
    document.addEventListener('focusin', (e) => {
        if (e.target.classList?.contains('bar')) barTip(e.target);
    });
    document.addEventListener('pointerout', (e) => {
        if (e.target.closest?.('.bar, .chart')) hideTip();
    });
    document.addEventListener('focusout', hideTip);

    document.addEventListener('pointermove', (e) => {
        const chart = e.target.closest?.('.chart');
        if (!chart) return;
        const site = data.sites.find((s) => s.slug === chart.dataset.slug);
        const pts = site.recent;
        const svg = chart.querySelector('svg');
        const rect = svg.getBoundingClientRect();
        const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
        const t = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
        let best = pts[0];
        for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
        const cx = ((best[0] - t0) / Math.max(1, t1 - t0)) * 600;
        const cl = chart.querySelector('.cursor-line');
        cl.setAttribute('x1', cx); cl.setAttribute('x2', cx);
        showTip(`<b>${timeFmt.format(new Date(best[0]))}</b><span>${best[2] ? ms(best[1]) : 'Falhou'}</span>`,
            rect.left + (cx / 600) * rect.width, rect.top);
    });

    // ── boot ────────────────────────────────────────────────

    async function refresh() {
        try {
            data = await load();
            render();
        } catch (err) {
            if (!data) renderError(err);
        }
    }

    $('year').textContent = new Date().getFullYear();
    refresh();
    setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
