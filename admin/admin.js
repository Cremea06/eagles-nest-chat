/* CHG-173: read-only admin console. Polls two same-origin GETs. Text only (textContent): nothing from the server is
   ever parsed as HTML. No buttons change anything. */
(function () {
  'use strict';
  var POLL_MS = 5000;
  var timer = null;
  var failed = 0;

  function $(id) { return document.getElementById(id); }
  function set(id, text) { var e = $(id); if (e) e.textContent = text == null ? '–' : String(text); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function mb(b) { return (b / 1048576).toFixed(0) + ' MB'; }
  function dur(sec) {
    sec = Math.max(0, Math.floor(sec));
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm ' + (sec % 60) + 's';
  }
  function when(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    return isNaN(d) ? '–' : d.toLocaleString();
  }
  function clock(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '–' : d.toLocaleTimeString();
  }
  function yn(b) { return b ? 'Yes' : 'No'; }

  function render(o) {
    var r = o.room, s = o.server, t = o.tailgate, f = o.featured;
    set('who', (o.owner && o.owner.name) || 'Owner');
    set('r-members', r.members); set('r-guests', r.guests);
    set('r-mpm', r.messages ? r.messages.perMinute : '–'); set('r-m5', r.messages ? r.messages.last5min : '–');
    set('r-connected', r.connected); set('r-registered', r.registered);
    set('r-pause', r.chatPause.paused ? 'Paused' + (r.chatPause.by ? ' by ' + r.chatPause.by : '') : 'On');
    set('r-play', r.tailgatePlay.playing ? 'Yes' + (r.tailgatePlay.by ? ' (started by ' + r.tailgatePlay.by + ')' : '') : 'No');
    set('r-edit', r.editMode ? 'On' : 'Off');
    set('r-live', r.broadcasting);
    set('r-whisper', (r.whispers.membersOnly ? 'Members only. ' : 'Guests allowed. ') + r.whispers.note);

    var spark = $('r-spark'); clear(spark);
    var series = (r.messages && r.messages.series) || [];
    var max = Math.max(1, Math.max.apply(null, series.length ? series : [0]));
    for (var i = 0; i < series.length; i++) {
      var bar = el('span', 'bar');
      bar.style.height = Math.round(4 + (series[i] / max) * 36) + 'px';
      bar.title = series[i] + ' msg';
      spark.appendChild(bar);
    }

    var ul = $('r-names'); clear(ul);
    if (!r.names.length) ul.appendChild(el('li', 'empty', 'Nobody has joined.'));
    for (var j = 0; j < r.names.length; j++) {
      var li = el('li', r.names[j].guest ? 'guest' : 'member', r.names[j].name);
      li.appendChild(el('span', 'tag', r.names[j].guest ? 'guest' : 'member'));
      ul.appendChild(li);
    }
    if (r.namesTruncated) ul.appendChild(el('li', 'empty', 'List cut at 200 names.'));

    set('s-started', when(s.startedAt)); set('s-uptime', dur(s.uptimeSec)); set('s-node', s.node);
    set('s-mem', mb(s.memory.rss) + ' resident');
    set('s-heap', mb(s.memory.heapUsed) + ' of ' + mb(s.memory.heapTotal));
    set('s-sys', mb(s.system.totalMem - s.system.freeMem) + ' used of ' + mb(s.system.totalMem) + ' (' + s.system.cpus + ' cores)');
    set('s-load', s.system.loadavg.join(' / '));
    set('s-commit', s.commit.atStart || 'unknown'); set('s-commit2', s.commit.onDisk || 'unknown');
    $('s-restart').hidden = !s.commit.changedSinceStart;

    set('t-mode', t.mode); set('t-override', t.override); set('t-source', t.source || 'none');
    set('t-embed', t.embedId || 'none'); set('t-live', yn(t.live));
    set('t-twitch', (t.twitch ? 'On' : 'Off') + (t.twitchChannel ? ' (' + t.twitchChannel + ')' : ''));
    set('t-poll', t.pollingEnabled ? 'On' : 'Off (TAILGATE_POLL=0)');
    set('t-token', t.tokenConfigured ? 'Configured' : 'Not configured (Tailgate changes are off)');

    var fl = $('f-list'); clear(fl);
    for (var k = 0; k < f.creators.length; k++) {
      var c = f.creators[k];
      var row = el('li', c.live ? 'on' : '');
      row.appendChild(el('span', 'dot'));
      row.appendChild(el('span', 'cname', c.name));
      row.appendChild(el('span', 'tag' + (c.live ? ' live' : ''), c.live ? 'LIVE' : 'offline'));
      fl.appendChild(row);
    }
    set('f-note', !f.polling ? 'Live checks are off (FEATURED_POLL=0).' :
      f.checkedAt ? 'Cached ' + f.cacheSeconds + ' s. Last check ' + when(f.checkedAt) + '.' : 'No check yet. It runs when someone loads the Featured card.');

    set('status', 'Updated ' + clock(o.generatedAt) + (o.audit.deniedAttempts ? ' · ' + o.audit.deniedAttempts + ' blocked request(s) since start' : ''));
  }

  var LABEL = { server_start: 'Server started', tailgate: 'Tailgate changed', tailgate_play: 'Tailgate play', chat_pause: 'Chat pause', edit_mode: 'Edit mode', admin_view: 'Admin page viewed' };
  function detail(e) {
    var d = e.detail || {}, p = [];
    if (e.type === 'chat_pause') return (d.paused ? 'Paused' : 'Turned on') + (d.by ? ' by ' + d.by : '');
    if (e.type === 'tailgate_play') return (d.playing ? 'Started' : 'Stopped') + (d.by ? ' by ' + d.by : '');
    if (e.type === 'edit_mode') return (d.on ? 'On' : 'Off') + (d.name ? ': ' + d.name : '');
    if (e.type === 'tailgate') {
      p.push('mode ' + (d.mode || '?'), 'override ' + (d.override || '?'));
      if (d.source) p.push('source ' + d.source);
      if (d.embedId) p.push('embed ' + d.embedId);
      if (d.twitch) p.push('twitch on');
      return p.join(', ');
    }
    return '';
  }
  function renderAudit(a) {
    var body = $('a-body'); clear(body);
    for (var i = 0; i < a.entries.length; i++) {
      var e = a.entries[i], tr = el('tr');
      tr.appendChild(el('td', 'when', when(e.at)));
      tr.appendChild(el('td', '', LABEL[e.type] || e.type));
      tr.appendChild(el('td', '', detail(e)));
      body.appendChild(tr);
    }
    set('a-note', a.entries.length + ' of the last ' + a.max + ' events since the server started. Memory only; no chat text, no whispers.');
  }

  function get(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }).then(function (r) {
      if (r.status === 404) { var e = new Error('gone'); e.gone = true; throw e; }
      if (r.status === 429) { var e2 = new Error('rate'); e2.rate = true; throw e2; }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }
  function tick() {
    Promise.all([get('/api/admin/overview'), get('/api/admin/audit')]).then(function (v) {
      failed = 0; render(v[0]); renderAudit(v[1]); schedule();
    }).catch(function (e) {
      if (e.gone) { set('status', 'Signed out or access ended. Sign in to the chat as the owner, then reload.'); return; }
      failed += 1;
      set('status', e.rate ? 'Slow down: too many requests. Retrying…' : 'Could not refresh (' + failed + '). Retrying…');
      schedule();
    });
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, POLL_MS * (failed ? Math.min(6, failed + 1) : 1));
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(timer); else tick();
  });
  tick();
})();
