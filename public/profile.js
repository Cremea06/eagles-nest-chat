// CHG-115 — fills /u/<name> from GET /api/profile/<name>. textContent only (never sets HTML).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function fail(text) { $('name').textContent = text; document.title = 'Profile · Milliway'; }
  var seg = location.pathname.replace(/^\/u\//, '').split('/')[0];
  var name;
  try { name = decodeURIComponent(seg); } catch (e) { return fail('No such member.'); }
  if (!name) return fail('No such member.');
  fetch('/api/profile/' + encodeURIComponent(name), { credentials: 'omit', headers: { Accept: 'application/json' } })
    .then(function (r) { return r.status === 200 ? r.json() : Promise.reject(r.status); })
    .then(function (p) {
      if (!p || typeof p.username !== 'string') return fail('No such member.');
      $('name').textContent = p.username;
      document.title = p.username + ' · Milliway';
      $('tier').textContent = typeof p.tier === 'string' ? p.tier : 'Member';
      $('tier').hidden = false;
      if (typeof p.joined === 'string') $('joined').textContent = 'Joined ' + p.joined;
    })
    .catch(function (s) { fail(s === 429 ? 'Slow down, try again in a minute.' : 'No such member.'); });
})();
