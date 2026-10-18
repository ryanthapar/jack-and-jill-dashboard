(() => {
  const METRICS = [
    ['doors', 'Doors knocked'], ['contacts', 'Contacts'], ['calls', 'Calls made'],
    ['conversations', 'Conversations'], ['leads', 'Leads generated'],
  ];
  const root = document.getElementById('app');
  const state = { user: null, tab: null, week: null, today: null };

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'style') { if (v) el.style.cssText = v; }
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/login') { state.user = null; render(); throw new Error('Please sign in again'); }
    if (!res.ok) throw new Error((data.error || 'Request failed') + (data.reason ? ` (${data.reason})` : ''));
    return data;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekStartOf = (s) => addDays(s, -((new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const fmt = (s, opts) => new Date(s + 'T00:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
  const short = (s) => fmt(s, { month: 'short', day: 'numeric' });
  const pct = (v, g) => (g > 0 ? Math.round((v / g) * 100) : null);
  function flash(el, text, ok) { el.className = 'msg ' + (ok ? 'ok' : 'err'); el.textContent = text; }

  function numberInputs(values, prefix) {
    return METRICS.map(([k, label]) => h('div', {}, h('label', { for: prefix + k }, label),
      h('input', { id: prefix + k, name: k, type: 'number', min: 0, max: 100000, step: 1, inputmode: 'numeric', value: values ? values[k] : 0, required: true })));
  }
  function readNumbers(form) {
    const out = {};
    for (const [k] of METRICS) out[k] = Number(form.elements[k].value);
    return out;
  }
  function weekNav(onChange) {
    const start = state.week;
    return h('div', { class: 'weeknav' },
      h('button', { class: 'btn small', onclick: () => onChange(addDays(start, -7)), 'aria-label': 'Previous week' }, '← Prev'),
      h('strong', {}, `${short(start)} – ${short(addDays(start, 6))}`),
      h('button', { class: 'btn small', onclick: () => onChange(addDays(start, 7)), 'aria-label': 'Next week' }, 'Next →'),
      start !== weekStartOf(state.today) && h('button', { class: 'btn small', onclick: () => onChange(weekStartOf(state.today)) }, 'This week'));
  }

  // ---------- views ----------
  function loginView() {
    const msg = h('div', { class: 'msg err', role: 'alert' });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { user } = await api('POST', '/api/login', { email: form.email.value, password: form.password.value });
          state.user = user; state.tab = null; render();
        } catch (err) { msg.textContent = err.message; }
      },
    },
      h('div', {}, h('label', { for: 'email' }, 'Email'), h('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'username', required: true, autofocus: true })),
      h('div', {}, h('label', { for: 'password' }, 'Password'), h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      h('div', {}, h('button', { class: 'btn primary', style: false }, 'Sign in')), msg);
    return h('div', { class: 'login' }, h('div', { class: 'card' }, h('h1', {}, 'Agent Tracker'), h('div', { class: 'muted' }, 'Sign in to log your activity'), form));
  }

  function metricCards(totals, goals) {
    return h('div', { class: 'grid' }, METRICS.map(([k, label]) => {
      const p = pct(totals[k], goals[k]);
      return h('div', { class: 'card metric' },
        h('div', { class: 'muted' }, label),
        h('div', { class: 'top' }, h('span', { class: 'val' }, totals[k]), h('span', { class: 'goal' }, goals[k] > 0 ? `goal ${goals[k]}` : 'no goal set')),
        h('div', { class: 'bar' + (p >= 100 ? ' done' : '') }, h('i', { style: `width:${Math.min(p || 0, 100)}%` })),
        h('div', { class: 'muted' }, p == null ? '—' : `${p}% of weekly goal`));
    }));
  }

  function dailyTable(daily) {
    return h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Day'), METRICS.map(([, l]) => h('th', {}, l)), h('th', {}, 'Logged'))),
      h('tbody', {}, daily.map((d) => {
        const future = d.date > state.today;
        return h('tr', {}, h('td', {}, fmt(d.date, { weekday: 'short', month: 'short', day: 'numeric' })),
          METRICS.map(([k]) => h('td', {}, d.entered ? d[k] : '–')),
          h('td', {}, d.entered ? h('span', { class: 'pill ok' }, '✓') : future ? '' : h('span', { class: 'pill bad' }, 'missing')));
      }))));
  }

  async function dashboardView(host, url, extra) {
    host.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
    const data = await api('GET', `${url}?week=${state.week}`);
    host.replaceChildren(...[
      extra ? extra(data) : null,
      weekNav((w) => { state.week = w; dashboardView(host, url, extra).catch(console.error); }),
      metricCards(data.totals, data.goals),
      h('div', { class: 'card' }, h('h2', {}, 'Daily breakdown'), dailyTable(data.daily))].filter(Boolean));
  }

  function logView(host) {
    let date = state.today;
    const msg = h('div', { role: 'status' });
    const formHost = h('div', {});
    async function load() {
      const data = await api('GET', `/api/dashboard?week=${weekStartOf(date)}`);
      const day = data.daily.find((d) => d.date === date);
      const form = h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api('PUT', '/api/stats', { date, ...readNumbers(form) });
            flash(msg, `Saved for ${fmt(date, { weekday: 'long', month: 'short', day: 'numeric' })}.`, true);
          } catch (err) { flash(msg, err.message, false); }
        },
      }, h('div', { class: 'grid' }, numberInputs(day, 'f-')), h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn primary' }, day.entered ? 'Update' : 'Save'), day.entered && h('span', { class: 'muted' }, 'Already logged — saving will overwrite.')));
      formHost.replaceChildren(form);
    }
    host.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Log daily stats'),
      h('div', { style: 'max-width:200px;margin-bottom:14px' }, h('label', { for: 'date' }, 'Date'),
        h('input', { id: 'date', type: 'date', value: date, max: state.today, onchange: (e) => { if (e.target.value) { date = e.target.value; msg.textContent = ''; load().catch((er) => flash(msg, er.message, false)); } } })),
      formHost, msg));
    load().catch((er) => flash(msg, er.message, false));
  }

  async function overviewView(host) {
    host.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
    const data = await api('GET', `/api/admin/overview?week=${state.week}`);
    const active = data.agents.filter((a) => a.active);
    const body = active.length
      ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Agent'), METRICS.map(([, l]) => h('th', {}, l)), h('th', {}, 'Days logged'))),
        h('tbody', {}, active.map((a) => h('tr', {},
          h('td', {}, h('button', { class: 'link', onclick: () => agentDetail(host, a) }, a.name)),
          METRICS.map(([k]) => {
            const p = pct(a.totals[k], a.goals[k]);
            return h('td', { class: 'cell' }, a.totals[k], h('small', {}, a.goals[k] > 0 ? `${p}% of ${a.goals[k]}` : 'no goal'));
          }),
          h('td', {}, `${a.daysEntered}/7`))))))
      : h('div', { class: 'muted' }, 'No agents yet. Add one in the Agents tab.');
    host.replaceChildren(weekNav((w) => { state.week = w; overviewView(host).catch(console.error); }), h('div', { class: 'card' }, h('h2', {}, 'Team progress'), body));
  }

  function agentDetail(host, a) {
    const back = h('button', { class: 'btn small', onclick: () => overviewView(host) }, '← Team');
    const inner = h('div', {});
    host.replaceChildren(h('div', { style: 'margin-bottom:12px' }, back, ' ', h('strong', {}, a.name)), inner);
    dashboardView(inner, `/api/admin/agents/${a.id}/dashboard`).catch(console.error);
  }

  async function goalsView(host) {
    const { agents } = await api('GET', `/api/admin/overview?week=${state.week}`);
    const active = agents.filter((a) => a.active);
    function goalForm(title, values, save, note) {
      const msg = h('div', { role: 'status' });
      const form = h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          if (note && !confirm(note)) return;
          try { await save(readNumbers(form)); flash(msg, 'Goals saved.', true); } catch (err) { flash(msg, err.message, false); }
        },
      }, h('div', { class: 'grid' }, numberInputs(values, 'g' + Math.random().toString(36).slice(2) + '-')), h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn primary' }, 'Save goals')), msg);
      return h('div', { class: 'card' }, h('h2', {}, title), form);
    }
    host.replaceChildren(
      h('p', { class: 'muted' }, 'Goals are weekly targets and apply to every week going forward.'),
      goalForm('Set for all agents', null, (v) => api('PUT', '/api/admin/goals/all', v), 'This overwrites every active and inactive agent\'s current goals. Continue?'),
      ...active.map((a) => goalForm(a.name, a.goals, (v) => api('PUT', `/api/admin/goals/${a.id}`, v))));
  }

  async function agentsView(host) {
    const { agents } = await api('GET', `/api/admin/overview?week=${state.week}`);
    const msg = h('div', { role: 'status' });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/admin/agents', { name: form.name.value, email: form.email.value, password: form.password.value });
          agentsView(host);
        } catch (err) { flash(msg, err.message, false); }
      },
    }, h('div', { class: 'grid' },
      h('div', {}, h('label', { for: 'an' }, 'Name'), h('input', { id: 'an', name: 'name', required: true, maxlength: 100 })),
      h('div', {}, h('label', { for: 'ae' }, 'Email'), h('input', { id: 'ae', name: 'email', type: 'email', required: true })),
      h('div', {}, h('label', { for: 'ap' }, 'Temporary password (8+ chars)'), h('input', { id: 'ap', name: 'password', type: 'text', minlength: 8, required: true, autocomplete: 'off' }))),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn primary' }, 'Add agent')), msg);
    const rows = agents.map((a) => h('tr', {},
      h('td', {}, a.name), h('td', {}, a.email), h('td', {}, a.active ? 'Active' : 'Inactive'),
      h('td', {}, h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn small', onclick: async () => { const pw = prompt(`New temporary password for ${a.name} (8+ chars):`); if (!pw) return; try { await api('PATCH', `/api/admin/agents/${a.id}`, { password: pw }); alert('Password updated.'); } catch (e) { alert(e.message); } } }, 'Reset password'),
        h('button', { class: 'btn small', onclick: async () => { await api('PATCH', `/api/admin/agents/${a.id}`, { active: !a.active }); agentsView(host); } }, a.active ? 'Deactivate' : 'Reactivate')))));
    host.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Add agent'), form),
      h('div', { class: 'card' }, h('h2', {}, 'Agents'), rows.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Status'), h('th', {}))), h('tbody', {}, rows))) : h('div', { class: 'muted' }, 'No agents yet.')));
  }

  function accountView(host) {
    const msg = h('div', { role: 'status' });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/me/password', { current: form.current.value, next: form.next.value }); form.reset(); flash(msg, 'Password changed.', true); }
        catch (err) { flash(msg, err.message, false); }
      },
    }, h('div', { class: 'grid' },
      h('div', {}, h('label', { for: 'cp' }, 'Current password'), h('input', { id: 'cp', name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
      h('div', {}, h('label', { for: 'np' }, 'New password (8+ chars)'), h('input', { id: 'np', name: 'next', type: 'password', autocomplete: 'new-password', minlength: 8, required: true }))),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn primary' }, 'Change password')), msg);
    host.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Change password'), form));
  }

  // ---------- shell ----------
  function appView() {
    const isAdmin = state.user.role === 'admin';
    const tabs = isAdmin
      ? [['overview', 'Team', overviewView], ['goals', 'Weekly goals', goalsView], ['agents', 'Agents', agentsView], ['account', 'Account', accountView]]
      : [['dashboard', 'My week', (host) => dashboardView(host, '/api/dashboard')], ['log', 'Log today', logView], ['account', 'Account', accountView]];
    if (!state.tab || !tabs.some((t) => t[0] === state.tab)) state.tab = tabs[0][0];
    const host = h('main', {});
    const view = tabs.find((t) => t[0] === state.tab)[2];
    Promise.resolve(view(host)).catch((e) => host.replaceChildren(h('div', { class: 'msg err' }, e.message)));
    return h('div', {},
      h('header', { class: 'top' }, h('h1', {}, 'Agent Tracker'), h('span', { class: 'muted' }, `${state.user.name} · ${state.user.role}`),
        h('button', { class: 'btn small', onclick: async () => { await api('POST', '/api/logout', {}).catch(() => {}); state.user = null; render(); } }, 'Sign out')),
      h('nav', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { class: id === state.tab ? 'on' : '', onclick: () => { state.tab = id; render(); } }, label))),
      host);
  }

  function render() {
    root.replaceChildren(state.user ? appView() : loginView());
  }

  (async () => {
    state.today = localToday();
    state.week = weekStartOf(state.today);
    try { state.user = (await api('GET', '/api/me')).user; } catch { state.user = null; }
    render();
  })();
})();
