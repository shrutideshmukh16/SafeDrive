/* ===========================================================
   SafeDrive Dashboard - app.js
   -----------------------------------------------------------
   Two modes:
   1. DEMO mode  (default) - everything runs in the browser and
      is saved in localStorage. No server needed.
   2. LIVE mode - enter your Python server URL in Settings.
      The dashboard then reads/writes through the Flask API
      (backend/app.py) and shows the confirmation countdown that
      the server controls.
   =========================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'safedrive_state_v1';
  var CIRC = 339.292; // 2 * PI * 54 (ring circumference)
  var ACCENTS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0d9488', '#475569'];
  var MAX_CONTACTS = 10;
  var PHONE_RE = /^\+?[0-9]{10,13}$/;

  /* ---------------- State ---------------- */
  function defaults() {
    return {
      apiUrl: '',
      profile: {
        name: 'Car Owner', phone: '+919800000000',
        vehicle_name: 'My Car', vehicle_number: 'MH-00-XX-0000', vehicle_model: 'Hatchback'
      },
      contacts: [
        { id: 'c1', name: 'Mother', relation: 'Family', phone: '+919800000001', primary: true },
        { id: 'c2', name: 'Brother', relation: 'Family', phone: '+919800000002', primary: false }
      ],
      settings: {
        confirm_seconds: 60, notify_sms: true, notify_call: true, notify_push: true,
        theme: 'auto', accent: '#2563eb'
      },
      history: []
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw), d = defaults();
        return {
          apiUrl: saved.apiUrl || '',
          profile: Object.assign(d.profile, saved.profile),
          contacts: Array.isArray(saved.contacts) ? saved.contacts : d.contacts,
          settings: Object.assign(d.settings, saved.settings),
          history: Array.isArray(saved.history) ? saved.history : []
        };
      }
    } catch (e) { /* ignore corrupt storage */ }
    return defaults();
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage blocked */ }
  }

  var state = load();
  var vehicle = { status: 'safe', lat: 18.5204, lng: 73.8567, updated: Date.now() };
  var current = null;          // event being confirmed / last accident event
  var deadline = 0, totalSeconds = 60, tickTimer = null, pollTimer = null, lastBeep = -1;

  /* ---------------- Helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function fmtTime(ms) { return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  function cleanPhone(p) { return String(p || '').replace(/[\s\-()]/g, ''); }
  function hexToRgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function toast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast' + (type === 'err' ? ' err' : '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 3600);
  }
  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      beep.ctx = beep.ctx || new Ctx();
      var o = beep.ctx.createOscillator(), g = beep.ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.06;
      o.connect(g); g.connect(beep.ctx.destination);
      o.start(); o.stop(beep.ctx.currentTime + 0.12);
    } catch (e) { /* audio not allowed */ }
  }

  /* ---------------- Backend adapter ---------------- */
  var api = {
    base: function () { return (state.apiUrl || '').replace(/\/+$/, ''); },
    on: function () { return !!this.base(); },
    call: function (method, path, body) {
      return fetch(this.base() + path, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
          return data;
        });
      });
    }
  };

  function setConn(kind, text) {
    var el = $('connPill');
    el.className = 'conn' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  function syncFromServer() {
    return api.call('GET', '/api/state').then(function (s) {
      state.profile = Object.assign(state.profile, s.profile);
      state.contacts = s.contacts || [];
      state.settings = Object.assign(state.settings, s.settings);
      state.history = s.history || [];
      save(); setConn('live', 'Live: connected');
      renderAll();
    });
  }

  function startPolling() {
    clearInterval(pollTimer);
    if (!api.on()) { setConn('', 'Demo mode'); return; }
    pollStatus();
    pollTimer = setInterval(pollStatus, 2000);
  }

  function pollStatus() {
    if (!api.on()) return;
    api.call('GET', '/api/status').then(function (s) {
      setConn('live', 'Live: connected');
      var loc = s.location || {};
      if (typeof loc.lat === 'number') { vehicle.lat = loc.lat; vehicle.lng = loc.lng; }
      if (s.status === 'confirming' && s.event) {
        if (vehicle.status !== 'confirming' || !current || current.id !== s.event.id) {
          enterConfirming(s.event, s.seconds_left);
        } else {
          deadline = Date.now() + s.seconds_left * 1000; // re-sync with server clock
        }
      } else if (s.status === 'accident') {
        if (vehicle.status !== 'accident') {
          current = s.event; vehicle.status = 'accident'; hideOverlay(); stopTick();
          syncFromServer().catch(function () {});
          toast('Accident confirmed. Family has been alerted.', 'err');
        }
      } else if (vehicle.status !== 'safe') { // server says safe again
        vehicle.status = 'safe'; current = null; hideOverlay(); stopTick();
        syncFromServer().catch(function () {});
      }
      vehicle.updated = Date.now();
      renderStatus();
    }).catch(function () { setConn('bad', 'Server unreachable'); });
  }

  /* ---------------- Theme / personalization ---------------- */
  function applyTheme() {
    var t = state.settings.theme, dark = t === 'dark' ||
      (t === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var accent = state.settings.accent || '#2563eb';
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-soft', hexToRgba(accent, 0.14));
  }

  /* ---------------- Rendering ---------------- */
  function renderAll() {
    applyTheme(); renderGreeting(); renderProfile(); renderStatus();
    renderContacts(); renderHistory(); renderSettings(); renderAlertLog(); renderSummary();
  }

  function renderGreeting() {
    var h = new Date().getHours();
    var part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    $('greeting').textContent = part + ', ' + state.profile.name.split(' ')[0];
    var s = vehicle.status;
    $('subGreeting').textContent = s === 'safe' ? 'Your vehicle is being monitored.' :
      s === 'confirming' ? 'Possible accident - waiting for your confirmation.' : 'Accident alert is active.';
  }

  function renderProfile() {
    var p = state.profile;
    $('sideAvatar').textContent = (p.name || '?').trim().charAt(0).toUpperCase();
    $('sideName').textContent = p.name;
    $('sideVehicle').textContent = p.vehicle_name + ' - ' + p.vehicle_number;
    $('vName').textContent = p.vehicle_name;
    $('vNumber').textContent = p.vehicle_number;
    $('vModel').textContent = p.vehicle_model;
    $('vDriver').textContent = p.name;
  }

  var map, marker;
  function initMap() {
    if (typeof L === 'undefined') return;
    try {
      map = L.map('map', { zoomControl: true }).setView([vehicle.lat, vehicle.lng], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);
      marker = L.marker([vehicle.lat, vehicle.lng], { icon: pinIcon('safe') }).addTo(map);
      var fb = document.querySelector('.map-fallback'); if (fb) fb.remove();
    } catch (e) { map = null; }
  }
  function pinIcon(kind) {
    return L.divIcon({ className: '', html: '<div class="pin ' + kind + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  function renderStatus() {
    var s = vehicle.status, hero = $('hero');
    var cfg = {
      safe:       { cls: 'safe',     title: 'Safe',               text: 'No accident detected. Live monitoring is active.', pill: 'Monitoring', pin: 'safe' },
      confirming: { cls: 'warn',     title: 'Confirming...',      text: 'Impact detected. Waiting for the owner to confirm.', pill: 'Awaiting confirmation', pin: 'warn' },
      accident:   { cls: 'accident', title: 'Accident detected',  text: 'Emergency contacts have been alerted with the live location.', pill: 'Alert sent', pin: 'accident' }
    }[s];
    hero.className = 'card hero ' + cfg.cls;
    $('heroTitle').textContent = cfg.title;
    $('heroText').textContent = cfg.text;
    $('heroPill').className = 'pill ' + (cfg.cls === 'accident' ? 'danger' : cfg.cls);
    $('heroPillText').textContent = cfg.pill;
    $('crashBtn').hidden = s !== 'safe';
    $('resetBtn').hidden = s !== 'accident';
    $('vUpdated').textContent = fmtTime(vehicle.updated);
    $('coords').textContent = vehicle.lat.toFixed(4) + ', ' + vehicle.lng.toFixed(4);
    if (map && marker) {
      marker.setLatLng([vehicle.lat, vehicle.lng]);
      marker.setIcon(pinIcon(cfg.pin));
      if (s !== 'safe') map.setView([vehicle.lat, vehicle.lng], 16);
    }
    renderGreeting();
  }

  function renderSummary() {
    $('sContacts').textContent = state.contacts.length;
    $('sWindow').textContent = state.settings.confirm_seconds + 's';
    $('sEvents').textContent = state.history.length;
  }

  function renderContacts() {
    var ul = $('contactList');
    $('contactCount').textContent = state.contacts.length + ' of ' + MAX_CONTACTS;
    if (!state.contacts.length) { ul.innerHTML = '<p class="empty">No contacts yet. Add a family member.</p>'; return; }
    ul.innerHTML = state.contacts.map(function (c) {
      return '<li><div class="avatar">' + esc(c.name.charAt(0).toUpperCase()) + '</div>' +
        '<div class="info"><strong>' + esc(c.name) + (c.primary ? ' <span class="badge">Primary</span>' : '') + '</strong>' +
        '<small>' + esc(c.relation || 'Family') + ' - ' + esc(c.phone) + '</small></div>' +
        '<div class="row-actions">' +
        (c.primary ? '' : '<button class="mini" data-act="primary" data-id="' + esc(c.id) + '">Make primary</button>') +
        '<button class="mini del" data-act="del" data-id="' + esc(c.id) + '">Delete</button></div></li>';
    }).join('');
  }

  function outcomeLabel(o) { return o === 'alert_sent' ? 'Alert sent' : o === 'false_alarm' ? 'False alarm' : o; }
  function reasonLabel(r) {
    return { no_response: 'No response in time', driver_needs_help: 'Driver asked for help', owner_safe: 'Owner confirmed safe' }[r] || (r || '-');
  }

  function renderHistory() {
    var body = $('historyBody');
    $('historyEmpty').hidden = state.history.length > 0;
    body.innerHTML = state.history.map(function (e) {
      var notified = (e.alerts || []).length ? (e.alerts.length + ' contact' + (e.alerts.length > 1 ? 's' : '')) : 'None';
      return '<tr><td>' + esc(fmtTime(e.time)) + '</td>' +
        '<td><span class="pill ' + (e.outcome === 'alert_sent' ? 'danger' : 'safe') + '">' + esc(outcomeLabel(e.outcome)) + '</span></td>' +
        '<td>' + esc(reasonLabel(e.reason)) + '</td>' +
        '<td>' + esc(e.peak_g) + ' g, ' + esc(e.tilt) + '&deg;</td>' +
        '<td>' + esc(notified) + '</td>' +
        '<td><a target="_blank" rel="noopener" href="https://www.google.com/maps?q=' + esc(e.lat) + ',' + esc(e.lng) + '">Open map</a></td></tr>';
    }).join('');
  }

  function renderAlertLog() {
    var last = state.history.filter(function (e) { return e.outcome === 'alert_sent'; })[0];
    var box = $('alertLog');
    if (!last) { box.innerHTML = '<p class="empty">No alerts sent yet.</p>'; $('alertTime').textContent = ''; return; }
    $('alertTime').textContent = fmtTime(last.time);
    box.innerHTML = (last.alerts || []).map(function (a) {
      var chips = (a.channels || []).map(function (c) { return '<span class="chip ok">' + esc(c) + ' sent</span>'; }).join('');
      return '<div class="alert-row"><div><strong>' + esc(a.name) + '</strong><small>' + esc(a.phone) + '</small></div><div class="chips">' + chips + '</div></div>';
    }).join('') || '<p class="empty">Alert was sent but no channels were enabled.</p>';
  }

  function renderSettings() {
    var p = state.profile, s = state.settings;
    $('pName').value = p.name; $('pPhone').value = p.phone;
    $('pVehicleName').value = p.vehicle_name; $('pVehicleNumber').value = p.vehicle_number; $('pVehicleModel').value = p.vehicle_model;
    $('sConfirm').value = s.confirm_seconds; $('sConfirmOut').textContent = s.confirm_seconds + ' s';
    $('sSms').checked = !!s.notify_sms; $('sCall').checked = !!s.notify_call; $('sPush').checked = !!s.notify_push;
    $('apiUrl').value = state.apiUrl;
    Array.prototype.forEach.call($('themeSeg').children, function (b) { b.classList.toggle('on', b.dataset.theme === s.theme); });
    $('swatches').innerHTML = ACCENTS.map(function (c) {
      return '<button class="swatch' + (c === s.accent ? ' on' : '') + '" style="background:' + c + '" data-color="' + c + '" aria-label="Accent ' + c + '"></button>';
    }).join('');
  }

  /* ---------------- Live sensor meters ---------------- */
  function setMeters(g, tilt, vib) {
    $('mAccelVal').textContent = g.toFixed(1) + ' g';
    $('mTiltVal').textContent = Math.round(tilt) + '°';
    $('mVibVal').textContent = Math.round(vib) + '%';
    $('mAccel').style.width = Math.min(100, g / 8 * 100) + '%';
    $('mTilt').style.width = Math.min(100, tilt / 90 * 100) + '%';
    $('mVib').style.width = Math.min(100, vib) + '%';
    $('mAccel').classList.toggle('hot', g >= 4);
    $('mTilt').classList.toggle('hot', tilt >= 60);
    $('mVib').classList.toggle('hot', vib >= 70);
  }
  setInterval(function () {
    if (vehicle.status !== 'safe') return;
    setMeters(1 + Math.random() * 0.25, Math.random() * 5, 4 + Math.random() * 12);
  }, 1200);

  /* ---------------- Confirmation flow ---------------- */
  function showOverlay() { $('overlay').hidden = false; document.body.style.overflow = 'hidden'; }
  function hideOverlay() { $('overlay').hidden = true; document.body.style.overflow = ''; }
  function stopTick() { clearInterval(tickTimer); tickTimer = null; }

  function enterConfirming(ev, secondsLeft) {
    current = ev; vehicle.status = 'confirming';
    vehicle.lat = ev.lat; vehicle.lng = ev.lng; vehicle.updated = Date.now();
    totalSeconds = state.settings.confirm_seconds;
    deadline = Date.now() + secondsLeft * 1000;
    setMeters(ev.peak_g, ev.tilt, 90);
    lastBeep = -1;
    showOverlay(); renderStatus(); stopTick();
    tickTimer = setInterval(tick, 200); tick();
  }

  function tick() {
    var left = Math.max(0, (deadline - Date.now()) / 1000);
    var whole = Math.ceil(left);
    $('ringNum').textContent = whole;
    $('ringFg').style.strokeDashoffset = String(CIRC * (1 - left / totalSeconds));
    if (whole !== lastBeep && whole > 0 && whole <= 10) { beep(); }
    lastBeep = whole;
    if (left <= 0) {
      stopTick();
      if (!api.on()) escalate('no_response'); // in live mode the server escalates and we pick it up by polling
    }
  }

  function startLocalEvent() {
    var ev = {
      id: uid(), time: Date.now(),
      lat: vehicle.lat + (Math.random() - 0.5) * 0.02, lng: vehicle.lng + (Math.random() - 0.5) * 0.02,
      peak_g: +(5 + Math.random() * 3).toFixed(1), tilt: Math.round(55 + Math.random() * 30),
      outcome: 'pending', reason: '', alerts: []
    };
    enterConfirming(ev, state.settings.confirm_seconds);
  }

  function simulateCrash() {
    if (vehicle.status !== 'safe') return;
    beep(); // unlock audio inside a click
    if (api.on()) {
      api.call('POST', '/api/device/event', {
        device_id: 'ESP32-S3-DEMO', accel_g: 6.2, tilt_deg: 72, vibration: 0.92,
        lat: vehicle.lat + (Math.random() - 0.5) * 0.02, lng: vehicle.lng + (Math.random() - 0.5) * 0.02
      }).then(pollStatus).catch(function () {
        toast('Server unreachable - running locally', 'err'); startLocalEvent();
      });
    } else { startLocalEvent(); }
  }

  function respond(kind) { // kind: 'safe' | 'help'
    if (!current) return;
    if (api.on()) {
      api.call('POST', '/api/event/' + encodeURIComponent(current.id) + '/respond', { response: kind })
        .then(function () { pollStatus(); }).catch(function (e) { toast('Could not send response: ' + e.message, 'err'); });
      return;
    }
    if (kind === 'safe') resolveSafe(); else escalate('driver_needs_help');
  }

  function resolveSafe() {
    stopTick(); hideOverlay();
    current.outcome = 'false_alarm'; current.reason = 'owner_safe'; current.alerts = [];
    state.history.unshift(current); save();
    vehicle.status = 'safe'; current = null; vehicle.updated = Date.now();
    renderAll(); toast('Glad you are safe. Alert cancelled - no one was notified.');
  }

  function escalate(reason) {
    stopTick(); hideOverlay();
    var s = state.settings;
    var channels = [];
    if (s.notify_sms) channels.push('SMS');
    if (s.notify_call) channels.push('Call');
    if (s.notify_push) channels.push('App');
    current.outcome = 'alert_sent'; current.reason = reason;
    current.alerts = state.contacts.map(function (c) { return { name: c.name, phone: c.phone, channels: channels.slice() }; });
    state.history.unshift(current); save();
    vehicle.status = 'accident'; vehicle.updated = Date.now();
    renderAll();
    toast(state.contacts.length ? 'Alert sent to ' + state.contacts.length + ' contact(s).' : 'Alert triggered, but no contacts are saved.', 'err');
  }

  function markSafe() {
    if (api.on()) {
      api.call('POST', '/api/event/resolve').then(pollStatus).catch(function (e) { toast(e.message, 'err'); });
      return;
    }
    vehicle.status = 'safe'; current = null; vehicle.updated = Date.now();
    setMeters(1, 0, 5); renderAll();
  }

  /* ---------------- Contacts ---------------- */
  function addContact(e) {
    e.preventDefault();
    var name = $('cName').value.trim(), relation = $('cRelation').value.trim() || 'Family', phone = cleanPhone($('cPhone').value);
    var err = $('contactError'); err.textContent = '';
    if (!name) { err.textContent = 'Please enter a name.'; return; }
    if (!PHONE_RE.test(phone)) { err.textContent = 'Enter a valid phone number (10-13 digits, optional +).'; return; }
    if (state.contacts.length >= MAX_CONTACTS) { err.textContent = 'You can link up to ' + MAX_CONTACTS + ' contacts.'; return; }
    if (state.contacts.some(function (c) { return c.phone === phone; })) { err.textContent = 'This number is already linked.'; return; }
    var contact = { id: uid(), name: name, relation: relation, phone: phone, primary: state.contacts.length === 0 };
    var done = function (c) {
      state.contacts.push(c); save(); renderContacts(); renderSummary();
      $('contactForm').reset(); toast(c.name + ' added.');
    };
    if (api.on()) {
      api.call('POST', '/api/contacts', contact).then(done).catch(function (er) { err.textContent = er.message; });
    } else { done(contact); }
  }

  function contactAction(e) {
    var btn = e.target.closest('button[data-act]'); if (!btn) return;
    var id = btn.dataset.id, act = btn.dataset.act;
    if (act === 'del') {
      var c = state.contacts.filter(function (x) { return x.id === id; })[0];
      if (!c || !window.confirm('Remove ' + c.name + ' from your emergency contacts?')) return;
      var after = function () {
        var wasPrimary = c.primary;
        state.contacts = state.contacts.filter(function (x) { return x.id !== id; });
        if (wasPrimary && state.contacts.length) state.contacts[0].primary = true;
        save(); renderContacts(); renderSummary(); toast(c.name + ' removed.');
      };
      if (api.on()) api.call('DELETE', '/api/contacts/' + encodeURIComponent(id)).then(after).catch(function (er) { toast(er.message, 'err'); });
      else after();
    } else if (act === 'primary') {
      var set = function () {
        state.contacts.forEach(function (x) { x.primary = x.id === id; });
        save(); renderContacts();
      };
      if (api.on()) api.call('PUT', '/api/contacts/' + encodeURIComponent(id) + '/primary').then(set).catch(function (er) { toast(er.message, 'err'); });
      else set();
    }
  }

  /* ---------------- Settings ---------------- */
  function pushSettings() {
    save();
    if (api.on()) api.call('PUT', '/api/settings', state.settings).catch(function () { toast('Could not save settings to server.', 'err'); });
  }

  function saveProfile(e) {
    e.preventDefault();
    var err = $('profileError'); err.textContent = '';
    var p = {
      name: $('pName').value.trim(), phone: cleanPhone($('pPhone').value),
      vehicle_name: $('pVehicleName').value.trim(), vehicle_number: $('pVehicleNumber').value.trim().toUpperCase(),
      vehicle_model: $('pVehicleModel').value.trim()
    };
    if (!p.name) { err.textContent = 'Name is required.'; return; }
    if (!PHONE_RE.test(p.phone)) { err.textContent = 'Enter a valid phone number.'; return; }
    if (!p.vehicle_name || !p.vehicle_number) { err.textContent = 'Vehicle nickname and number are required.'; return; }
    var done = function () { state.profile = Object.assign(state.profile, p); save(); renderAll(); toast('Profile saved.'); };
    if (api.on()) api.call('PUT', '/api/profile', p).then(done).catch(function (er) { err.textContent = er.message; });
    else done();
  }

  function connect() {
    var url = $('apiUrl').value.trim();
    if (url && !/^https?:\/\//i.test(url)) { toast('Address must start with http:// or https://', 'err'); return; }
    state.apiUrl = url; save();
    if (!url) { clearInterval(pollTimer); setConn('', 'Demo mode'); toast('Back to demo mode.'); return; }
    setConn('', 'Connecting...');
    syncFromServer().then(function () { startPolling(); toast('Connected to server.'); })
      .catch(function () { setConn('bad', 'Server unreachable'); toast('Could not reach ' + url, 'err'); });
  }

  /* ---------------- Events ---------------- */
  function switchView(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) { b.classList.toggle('active', b.dataset.view === name); });
    window.scrollTo(0, 0);
    if (name === 'dashboard' && map) setTimeout(function () { map.invalidateSize(); }, 50);
  }

  function bind() {
    $('nav').addEventListener('click', function (e) { var b = e.target.closest('.nav-item'); if (b) switchView(b.dataset.view); });
    $('crashBtn').addEventListener('click', simulateCrash);
    $('resetBtn').addEventListener('click', markSafe);
    $('btnSafe').addEventListener('click', function () { respond('safe'); });
    $('btnHelp').addEventListener('click', function () { respond('help'); });
    $('contactForm').addEventListener('submit', addContact);
    $('contactList').addEventListener('click', contactAction);
    $('profileForm').addEventListener('submit', saveProfile);
    $('connectBtn').addEventListener('click', connect);

    $('sConfirm').addEventListener('input', function () { $('sConfirmOut').textContent = this.value + ' s'; });
    $('sConfirm').addEventListener('change', function () { state.settings.confirm_seconds = +this.value; pushSettings(); renderSummary(); });
    [['sSms', 'notify_sms'], ['sCall', 'notify_call'], ['sPush', 'notify_push']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () { state.settings[pair[1]] = this.checked; pushSettings(); });
    });

    $('themeSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      state.settings.theme = b.dataset.theme; pushSettings(); applyTheme(); renderSettings();
    });
    $('swatches').addEventListener('click', function (e) {
      var b = e.target.closest('.swatch'); if (!b) return;
      state.settings.accent = b.dataset.color; pushSettings(); applyTheme(); renderSettings();
    });
    $('themeBtn').addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      state.settings.theme = isDark ? 'light' : 'dark'; pushSettings(); applyTheme(); renderSettings();
    });
    $('clearHistory').addEventListener('click', function () {
      if (!state.history.length || !window.confirm('Clear all accident history on this device?')) return;
      state.history = []; save(); renderHistory(); renderSummary(); renderAlertLog();
    });
    $('resetData').addEventListener('click', function () {
      if (!window.confirm('Reset all demo data (profile, contacts, history, settings)?')) return;
      state = defaults(); save(); clearInterval(pollTimer); setConn('', 'Demo mode'); renderAll(); toast('Demo data reset.');
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (state.settings.theme === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('overlay').hidden) e.preventDefault(); });
  }

  /* ---------------- Boot ---------------- */
  bind();
  initMap();
  renderAll();
  setMeters(1, 0, 5);
  if (api.on()) { syncFromServer().then(startPolling).catch(function () { setConn('bad', 'Server unreachable'); startPolling(); }); }
})();
