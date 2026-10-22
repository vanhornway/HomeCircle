(() => {
  const cfg = window.HOMECIRCLE || {};
  const repo = cfg.repo || 'vanhornway/HomeCircle';
  const branch = cfg.branch || 'main';
  const repoUrl = `https://github.com/${repo}`;
  const raw = `https://raw.githubusercontent.com/${repo}/${branch}`;
  const installCmd = (args = '') =>
    `curl -fsSL ${raw}/deploy/install.sh | sudo bash${args ? ` -s -- ${args}` : ''}`;
  const cloudInit = `#cloud-config
package_update: true
packages: [git, curl, ufw]
runcmd:
  - ufw allow OpenSSH
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw allow 443/udp
  - ufw --force enable
  - curl -fsSL ${raw}/deploy/install.sh | HOMECIRCLE_MODE=public bash`;

  const HOSTS = [
    {
      id: 'render',
      name: 'Render',
      color: '#4b4fd6',
      blurb: 'One click, fully managed.',
      badge: 'Easiest',
      cost: '~$7/month',
      time: '~5 minutes',
      skill: 'No technical skills',
      action: { label: 'Deploy to Render', href: `https://render.com/deploy?repo=${encodeURIComponent(repoUrl)}` },
      steps: [
        '<strong>Click “Deploy to Render”</strong> and sign in. Render reads <code>render.yaml</code> and sets everything up, including a disk and a random setup code.',
        '<strong>Approve the Starter plan.</strong> A persistent disk needs a paid instance.',
        'When it says <strong>Live</strong>, copy your address (<code>…onrender.com</code>).',
        'Open <strong>Environment</strong> and reveal <code>SETUP_TOKEN</code>. That’s your setup code.',
        'In the HomeCircle app, tap <strong>Set up a new server</strong>.',
      ],
      tradeoff: 'Free Render instances sleep and lose their disk, so they won’t work for HomeCircle.',
    },
    {
      id: 'railway',
      name: 'Railway',
      color: '#6b3fd4',
      blurb: 'Managed, usage-based pricing.',
      badge: 'Easy',
      cost: '~$5/month',
      time: '~5 minutes',
      skill: 'No technical skills',
      action: cfg.railwayTemplate
        ? { label: 'Deploy on Railway', href: cfg.railwayTemplate }
        : { label: 'Open Railway', href: 'https://railway.com/new' },
      notice: cfg.railwayTemplate ? '' : 'One-click Railway deploys need a published template. Until there is one, follow these steps.',
      steps: cfg.railwayTemplate
        ? [
            '<strong>Click “Deploy on Railway”</strong> and sign in.',
            'Railway creates the service, a volume at <code>/data</code>, and a random <code>SETUP_TOKEN</code>.',
            'Open <strong>Settings → Networking</strong> and copy your <code>…up.railway.app</code> address.',
            'Copy <code>SETUP_TOKEN</code> from <strong>Variables</strong>, then tap <strong>Set up a new server</strong> in the app.',
          ]
        : [
            `<strong>New Project → Deploy from GitHub repo</strong> and choose your copy of <a href="${repoUrl}">HomeCircle</a>.`,
            '<strong>Settings → Volumes → Add volume</strong> with mount path <code>/data</code>.',
            '<strong>Variables:</strong> <code>SETUP_TOKEN</code> = <code>${{secret(24)}}</code> and <code>TRUST_PROXY</code> = <code>true</code>.',
            '<strong>Settings → Networking → Generate domain</strong>, then copy the address.',
            'Copy <code>SETUP_TOKEN</code> and tap <strong>Set up a new server</strong> in the app.',
          ],
      tradeoff: 'Billing is usage-based. A family server is tiny, but check Railway’s current plan minimums.',
    },
    {
      id: 'fly',
      name: 'Fly.io',
      color: '#7b3fe4',
      blurb: 'Cheap, runs close to you.',
      badge: 'Low cost',
      cost: '~$3/month',
      time: '~10 minutes',
      skill: 'Comfortable with a terminal',
      action: { label: 'Install flyctl', href: 'https://fly.io/docs/flyctl/install/' },
      code: `git clone ${repoUrl}.git && cd HomeCircle
fly launch --copy-config --no-deploy --name my-family-homecircle
fly volumes create homecircle_data --size 1
fly secrets set SETUP_TOKEN=$(openssl rand -base64 18)
fly deploy
fly secrets list   # remember the SETUP_TOKEN you set`,
      steps: [
        'Install <strong>flyctl</strong> and run <code>fly auth login</code>.',
        'Run the commands on the right. Pick any app name.',
        'Your address is <code>https://&lt;app-name&gt;.fly.dev</code>.',
        'In the app, tap <strong>Set up a new server</strong> and use the token you set.',
      ],
      tradeoff: 'Keeps one small machine always on, so “Locate” requests always get through.',
    },
    {
      id: 'digitalocean',
      name: 'DigitalOcean',
      color: '#0b6efd',
      blurb: 'Your own VPS, set up for you.',
      badge: 'Full control',
      cost: '~$4–6/month',
      time: '~10 minutes',
      skill: 'Copy & paste',
      action: { label: 'Create a Droplet', href: 'https://cloud.digitalocean.com/droplets/new' },
      code: cloudInit,
      codeLabel: 'User data',
      steps: [
        'Create a Droplet: <strong>Ubuntu 24.04</strong>, the smallest size.',
        'Under <strong>Advanced options → Add initialization scripts</strong>, paste the user data on the right.',
        'Wait ~3 minutes, then <code>ssh root@&lt;droplet-ip&gt;</code>. Your address and setup code are shown at login.',
        'No domain needed: you’ll get <code>&lt;ip&gt;.sslip.io</code> with real HTTPS. You can add your own domain later.',
      ],
      tradeoff: 'You’re responsible for the server. Ubuntu installs security updates automatically.',
    },
    {
      id: 'hetzner',
      name: 'Hetzner',
      color: '#d50c2d',
      blurb: 'The cheapest VPS, EU-based.',
      badge: 'Cheapest',
      cost: '~€4/month',
      time: '~10 minutes',
      skill: 'Copy & paste',
      action: { label: 'Open Hetzner Cloud', href: 'https://console.hetzner.cloud/' },
      code: cloudInit,
      codeLabel: 'Cloud config',
      steps: [
        '<strong>Add server</strong>: <strong>Ubuntu 24.04</strong>, the smallest shared-CPU type, any location.',
        'Paste the config on the right into <strong>Cloud config</strong>.',
        'Wait ~3 minutes, then <code>ssh root@&lt;server-ip&gt;</code>. The address and setup code are shown at login.',
        'Open the app and tap <strong>Set up a new server</strong>.',
      ],
      tradeoff: 'Great value, with servers in the EU and US. Same self-managed trade-off as any VPS.',
    },
    {
      id: 'pi',
      name: 'Raspberry Pi',
      color: '#2f7d6d',
      blurb: 'At home. Data never leaves.',
      badge: 'Most private',
      cost: 'Hardware only',
      time: '~20 minutes',
      skill: 'Some setup',
      action: { label: 'Installer source', href: `${repoUrl}/blob/${branch}/deploy/install.sh` },
      variants: [
        {
          id: 'tailscale',
          label: 'Tailscale Funnel',
          code: installCmd('--mode tailscale'),
          note: 'Recommended. No router changes. You get a stable public address like <code>https://homecircle.tail1234.ts.net</code>. Phones don’t need Tailscale.',
        },
        {
          id: 'cloudflare',
          label: 'Cloudflare Tunnel',
          code: installCmd('--mode cloudflare --domain family.example.com --cloudflare-token <TOKEN>'),
          note: 'Needs a domain on Cloudflare. Create a tunnel in Zero Trust → Networks → Tunnels and route your hostname to <code>http://homecircle:8080</code>.',
        },
        {
          id: 'ports',
          label: 'Port forwarding',
          code: installCmd('--mode public --domain yourname.duckdns.org'),
          note: 'Forward TCP 80 and 443 on your router to the Pi, and point a dynamic DNS name (e.g. DuckDNS) at your home IP.',
        },
      ],
      steps: [
        'Flash <strong>64-bit Raspberry Pi OS Lite</strong> (Pi 3B+ or newer) and enable SSH.',
        'Choose how your family’s phones reach the Pi from anywhere, then run that command on the Pi.',
        'The installer sets up Docker, builds HomeCircle and prints your address and setup code.',
        'Open the app and tap <strong>Set up a new server</strong>.',
      ],
      tradeoff: 'Phones must reach your Pi from anywhere, not just home Wi‑Fi, hence a tunnel or port forward. With a tunnel, the provider only ever sees encrypted data.',
    },
  ];

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const hostsEl = $('.hosts');
  const detailEl = $('#host-detail');
  let current = 'render';
  let variant = 0;

  function renderTabs() {
    hostsEl.innerHTML = HOSTS.map(
      (h) => `<button class="host" role="tab" id="tab-${h.id}" aria-selected="${h.id === current}" aria-controls="host-detail" data-id="${h.id}">
        <span class="logo" style="background:${h.color}">${esc(h.name[0])}</span>
        <strong>${esc(h.name)}</strong>
        <small>${esc(h.blurb)}</small>
        <span class="badge">${esc(h.badge)}</span>
      </button>`,
    ).join('');
  }

  function codeBlock(code, label) {
    return `${label ? `<p class="muted small" style="margin-bottom:6px">${esc(label)}</p>` : ''}
      <div class="code-wrap">
      <pre class="code"><code>${esc(code)}</code></pre>
      <button class="btn small copy" type="button" data-copy="${esc(code)}">Copy</button>
    </div>`;
  }

  function renderDetail() {
    const h = HOSTS.find((x) => x.id === current);
    let right = '';
    if (h.variants) {
      const v = h.variants[variant] || h.variants[0];
      right = `<div class="subtabs">${h.variants
        .map((x, i) => `<button type="button" data-variant="${i}" aria-pressed="${i === variant}">${esc(x.label)}</button>`)
        .join('')}</div>
        <p class="muted small">${v.note}</p>
        ${codeBlock(v.code, 'Run on your Pi')}`;
    } else if (h.code) {
      right = codeBlock(h.code, h.codeLabel);
    } else {
      right = `<div class="flow" style="box-shadow:none">
        <div class="node"><span>☁️</span><b>${esc(h.name)}</b><small>runs the HomeCircle container</small></div>
        <div class="arrow">your address</div>
        <div class="node server"><span>📱</span><b>HomeCircle app</b><small>“Set up a new server”</small></div>
      </div>`;
    }
    detailEl.setAttribute('aria-labelledby', `tab-${h.id}`);
    detailEl.innerHTML = `<div>
        <h3>${esc(h.name)}</h3>
        <div class="meta"><span>${esc(h.cost)}</span><span>${esc(h.time)}</span><span>${esc(h.skill)}</span></div>
        ${h.notice ? `<p class="notice">${esc(h.notice)}</p>` : ''}
        <ol>${h.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
        <div class="cta-row"><a class="btn primary" href="${esc(h.action.href)}" target="_blank" rel="noopener noreferrer">${esc(h.action.label)}</a>
        <a class="btn" href="${repoUrl}/blob/${branch}/deploy/README.md" target="_blank" rel="noopener noreferrer">Full guide</a></div>
        <p class="tradeoff">${h.tradeoff}</p>
      </div>
      <div>${right}</div>`;
  }

  hostsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.host');
    if (!btn) return;
    current = btn.dataset.id;
    variant = 0;
    renderTabs();
    renderDetail();
    try {
      localStorage.setItem('hc-host', current);
    } catch {
      /* private mode */
    }
  });
  hostsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = HOSTS.findIndex((h) => h.id === current);
    current = HOSTS[(i + (e.key === 'ArrowRight' ? 1 : HOSTS.length - 1)) % HOSTS.length].id;
    renderTabs();
    renderDetail();
    $(`#tab-${current}`).focus();
  });
  detailEl.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-variant]');
    if (v) {
      variant = Number(v.dataset.variant);
      renderDetail();
      return;
    }
    const c = e.target.closest('[data-copy]');
    if (c) {
      try {
        await navigator.clipboard.writeText(c.dataset.copy);
        c.textContent = 'Copied';
      } catch {
        c.textContent = 'Select & copy';
      }
      setTimeout(() => (c.textContent = 'Copy'), 2000);
    }
  });

  try {
    const saved = localStorage.getItem('hc-host');
    if (saved && HOSTS.some((h) => h.id === saved)) current = saved;
  } catch {
    /* private mode */
  }
  renderTabs();
  renderDetail();

  // --- server check --------------------------------------------------------
  const result = $('#check-result');
  $('#check-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let url = $('#check-url').value.trim().replace(/\/+$/, '');
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    result.className = 'check-result';
    result.textContent = 'Checking…';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${url}/api/v1/info`, { signal: ctrl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
      clearTimeout(timer);
      const info = await res.json();
      if (info.app !== 'homecircle') throw new Error('not a HomeCircle server');
      result.className = 'check-result ok';
      result.textContent = info.setup
        ? `✓ HomeCircle ${info.version} is running and already has a circle. Ask an admin for an invite.`
        : `✓ HomeCircle ${info.version} is running and ready. Open the app → “Set up a new server”.`;
    } catch (err) {
      result.className = 'check-result err';
      result.textContent =
        err.name === 'AbortError'
          ? '✗ No answer after 10 seconds. It may still be starting, so try again in a minute.'
          : `✗ Couldn’t reach a HomeCircle server there (${err.message}). Check the address, and that it uses https.`;
    }
  });

  // --- store links -----------------------------------------------------------
  const stores = $('#store-links');
  const link = (href, label) =>
    href
      ? `<a class="btn primary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<span class="btn" aria-disabled="true" title="Coming soon">${label} · soon</span>`;
  const apkLabel = (version) => `⬇ Android app (APK)${version ? ` · v${esc(version)}` : ''}`;
  stores.innerHTML =
    (cfg.androidApk ? `<a class="btn primary" id="apk-link" href="${esc(cfg.androidApk)}">${apkLabel(cfg.androidVersion)}</a>` : '') +
    link(cfg.appStore, 'App Store') +
    link(cfg.playStore, '▶ Google Play') +
    (cfg.setupGuide ? `<a class="btn" href="${esc(cfg.setupGuide)}" target="_blank" rel="noopener noreferrer">Step-by-step guide</a>` : '');

  // --- what's new ------------------------------------------------------------
  const changelog = $('#changelog-list');
  if (changelog && Array.isArray(window.HOMECIRCLE_CHANGELOG)) {
    const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    changelog.innerHTML = window.HOMECIRCLE_CHANGELOG.map(
      (r, i) => `
      <details class="release"${i === 0 ? ' open' : ''}>
        <summary><span class="ver">v${esc(r.version)}</span><span class="rel-title">${esc(r.title)}</span><span class="rel-date">${esc(fmt(r.date))}</span></summary>
        <ul>${r.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <a class="rel-link" href="https://github.com/${esc(repo)}/releases/tag/v${esc(r.version)}" target="_blank" rel="noopener noreferrer">Release on GitHub</a>
      </details>`,
    ).join('');
  }

  // The latest release's version, date and size, so the button always matches
  // what it downloads. Falls back to cfg.androidVersion if GitHub can't be reached.
  const releaseNote = $('#apk-release');
  const showRelease = (version, date, bytes, url) => {
    if (!releaseNote || !version) return;
    const bits = [`Version ${esc(version)}`];
    if (date) bits.push(`released ${esc(new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}`);
    if (bytes) bits.push(`${Math.round(bytes / 1e6)} MB`);
    releaseNote.innerHTML = `${bits.join(' · ')}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">What’s new</a>` : ''}`;
  };
  if (cfg.androidApk) {
    showRelease(cfg.androidVersion, null, null, `https://github.com/${repo}/releases/latest`);
    fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rel) => {
        const version = String(rel?.tag_name || '').replace(/^v/, '');
        if (!version) return;
        const apk = (rel.assets || []).find((a) => a.name === 'HomeCircle.apk');
        const linkEl = $('#apk-link');
        if (linkEl) linkEl.textContent = `⬇ Android app (APK) · v${version}`;
        showRelease(version, rel.published_at, apk?.size, rel.html_url);
      })
      .catch(() => {});
  }
})();
