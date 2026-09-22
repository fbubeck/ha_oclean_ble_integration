// oclean-card.js – Custom Lovelace card for the Oclean BLE integration.
//
// Config keys:
//   type: custom:oclean-card
//   title: Meine Oclean X Pro Elite
//   battery: sensor.oclean_zahnburste_akku
//   last_brush: sensor.oclean_zahnburste_letzte_putzzeit
//   score: sensor.oclean_zahnburste_score
//   coverage: sensor.oclean_zahnburste_abdeckung
//   pressure: sensor.oclean_zahnburste_druck
//   duration: sensor.oclean_zahnburste_dauer                   (optional – brushing time s)
//   overpressure: sensor.bad_oclean_zahnburste_anteil_uberdruck
//   brush_head_days: sensor.oclean_zahnburste_kopfalter          (optional)
//   brush_head_usage: sensor.oclean_zahnburste_kopf_putzvorgange (optional)
//   brush_head_wear: sensor.bad_oclean_zahnburste_burstenkopf_verschleiss (optional – wear %)
//   last_poll: sensor.oclean_zahnburste_letzte_abfrage           (optional)
//   weak_zone: sensor.oclean_zahnburste_schwachste_zone
//   current_zones: sensor.oclean_zahnburste_gereinigte_zonen   (optional – zone values from last session)
//   power_zones: sensor.oclean_zahnburste_power_verteilung      (optional – per-zone pressure/power overlay)
//   brush_image: image.oclean_zahnburste_putzabdeckung
//   heatmap_image: image.oclean_zahnburste_zonen_heatmap
//   refresh_button: button.oclean_zahnburste_update_now        (optional)
//   animations: true|false                                     (optional, default true)

class OcleanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._historyData    = null; // { day: count }
    this._scoreHistory   = null; // { day: [val, …] }
    this._covHistory     = null; // { day: [val, …] }
    this._durationHistory = null; // { day: [val, …] }  ← new
    this._debugHistory   = null;
    this._activeTab      = 0;    // 0=count 1=score 2=coverage 3=duration
    this._imageTab       = 0;    // 0=last session, 1=history average
    this._lastFetch      = 0;
  }

  setConfig(config) {
    if (!config) throw new Error('Oclean card: configuration required');
    this._config = config;
    this._render();
  }

  set hass(hass) {
    const changed = this._relevantChanged(hass);
    this._hass = hass;
    if (changed) this._render();
    this._fetchHistory();
  }

  // Only re-render when one of the entities configured in this card changes.
  _relevantChanged(newHass) {
    if (!this._hass || !this._config) return true;
    const c = this._config;
    const ids = [
      c.score, c.coverage, c.pressure, c.overpressure,
      c.battery, c.last_brush, c.last_poll, c.duration,
      c.brush_head_days, c.brush_head_usage, c.brush_head_wear,
      c.weak_zone, c.current_zones, c.power_zones,
      c.brush_image, c.heatmap_image,
    ].filter(Boolean);
    return ids.some(id => {
      const a = this._hass.states[id];
      const b = newHass.states[id];
      if (!a && !b) return false;
      if (!a || !b) return true;
      if (a.state !== b.state) return true;
      // For image entities, check image_last_updated attribute
      const aa = a.attributes, ba = b.attributes;
      return (aa && aa.image_last_updated) !== (ba && ba.image_last_updated);
    });
  }

  // ── Data helpers ─────────────────────────────────────────────────────────────

  _state(id) { return id && this._hass ? (this._hass.states[id] || null) : null; }

  _num(id) {
    const s = this._state(id);
    if (!s || s.state === 'unavailable' || s.state === 'unknown') return null;
    const v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }

  // Returns Unix seconds from either a numeric state or an ISO datetime state.
  _ts(id) {
    const s = this._state(id);
    if (!s || s.state === 'unavailable' || s.state === 'unknown') return null;
    const num = parseFloat(s.state);
    if (!isNaN(num) && num > 1_000_000_000) return Math.round(num); // already Unix seconds
    const ms = Date.parse(s.state); // ISO datetime → ms
    return isNaN(ms) ? null : Math.round(ms / 1000);
  }

  // Parse a raw state string to milliseconds (Unix or ISO); returns 0 on failure.
  static _stateToMs(val) {
    if (!val || val === 'unavailable' || val === 'unknown') return 0;
    const num = parseFloat(val);
    if (!isNaN(num) && num > 1_000_000_000) return num * 1000;
    const ms = Date.parse(val);
    return isNaN(ms) ? 0 : ms;
  }

  _str(id) {
    const s = this._state(id);
    return s && s.state !== 'unavailable' && s.state !== 'unknown' ? s.state : null;
  }

  _imgUrl(id) {
    const s = this._state(id);
    if (!s) return '';
    const base = (this._hass.auth && this._hass.auth.data && this._hass.auth.data.hassUrl) || '';
    const token = (s.attributes && s.attributes.access_token) || '';
    const ts = (s.attributes && s.attributes.image_last_updated) || Date.now();
    return `${base}/api/image_proxy/${id}?token=${token}&t=${ts}`;
  }

  // Returns { zones: {key: avgValue, …}, sessions: N } from the weak_zone sensor.
  _zoneData(id) {
    const s = this._state(id);
    if (!s || !s.attributes) return null;
    const a = s.attributes;
    const zones = {};
    for (const [k, v] of Object.entries(a)) {
      if (!['sessions_count', 'icon', 'friendly_name'].includes(k) && typeof v === 'number')
        zones[k] = v;
    }
    return Object.keys(zones).length > 0 ? { zones, sessions: a.sessions_count || 0 } : null;
  }

  // Returns { key: currentValue, … } from the cleaned_zones sensor (last session).
  _currentZones(id) {
    const s = this._state(id);
    if (!s || !s.attributes) return null;
    const zones = {};
    for (const [k, v] of Object.entries(s.attributes)) {
      if (!['icon', 'friendly_name'].includes(k) && typeof v === 'number')
        zones[k] = v;
    }
    return Object.keys(zones).length > 0 ? zones : null;
  }

  // Returns { key: powerLevel, … } from the power distribution sensor.
  _powerZones(id) {
    const s = this._state(id);
    if (!s || !s.attributes) return null;
    const zones = {};
    for (const [k, v] of Object.entries(s.attributes)) {
      if (['icon', 'friendly_name', 'gesture_array'].includes(k)) continue;
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (!isNaN(n)) zones[k] = n;
    }
    return Object.keys(zones).length > 0 ? zones : null;
  }

  // Normalise raw zone values to 0-100 for display.
  // gestureArray/021f values are on a 0-35 scale; anything with max ≤ 50 is
  // treated as relative (session max = 100%) so colour bands work correctly.
  _normalizeZones(zones) {
    if (!zones) return null;
    const maxVal = Math.max(...Object.values(zones).filter(v => v > 0), 0);
    if (maxVal === 0 || maxVal > 50) return zones;
    return Object.fromEntries(
      Object.entries(zones).map(([k, v]) => [k, v > 0 ? Math.round(v / maxVal * 100) : 0])
    );
  }

  // ── Refresh button action ────────────────────────────────────────────────────

  async _pressRefresh() {
    const id = this._config && this._config.refresh_button;
    if (!id || !this._hass) return;
    try {
      await this._hass.callService('button', 'press', { entity_id: id });
      this._lastFetch = 0; // invalidate chart cache so it reloads after the poll
    } catch (e) {
      console.debug('[oclean-card] refresh failed:', e);
    }
  }

  // ── History fetch (7-day chart) ──────────────────────────────────────────────

  // Extract state array for one entity from a WS history_during_period response.
  // wsData may be a dict {entityId: [...]} or an array (legacy single-entity format).
  _extractStates(wsData, entityId) {
    if (!wsData || !entityId) return [];
    if (Array.isArray(wsData)) return wsData[0] || [];
    return wsData[entityId] || [];
  }

  // Build a { "YYYY-MM-DD": [val, ...] } map from a flat array of {s, lu} entries.
  _buildValueHistory(states, emptyDays) {
    const byDay = {};
    for (const key of Object.keys(emptyDays)) byDay[key] = [];
    for (const s of states) {
      const val = parseFloat(s.s);
      if (isNaN(val) || val < 0) continue;
      const dayMs = s.lu ? s.lu * 1000 : (s.lc ? s.lc * 1000 : 0);
      if (!dayMs) continue;
      const day = new Date(dayMs).toISOString().slice(0, 10);
      if (day in byDay) byDay[day].push(val);
    }
    return byDay;
  }

  async _fetchHistory() {
    const c = this._config;
    const brushId = c && c.last_brush;
    if (!brushId || !this._hass) return;
    const now = Date.now();
    if (now - this._lastFetch < 300_000) return; // 5-min cache
    this._lastFetch = now;

    const scoreId    = c.score;
    const covId      = c.coverage;
    const durationId = c.duration;
    const start = new Date(now - 7 * 86_400_000).toISOString();
    const end   = new Date(now).toISOString();

    // Empty buckets for the last 7 days
    const emptyDays = {};
    for (let i = 0; i < 7; i++)
      emptyDays[new Date(now - i * 86_400_000).toISOString().slice(0, 10)] = 0;

    // ── Try single multi-entity WS call ──────────────────────────────────────
    let wsData = null;
    const entityIds = [brushId, scoreId, covId, durationId].filter(Boolean);
    try {
      wsData = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: start, end_time: end,
        entity_ids: entityIds,
        minimal_response: true,
      });
    } catch (e) {
      console.debug('[oclean-card] WS history failed:', e);
    }

    // ── Process brush timestamps → per-day count + session list ─────────────
    const counts      = { ...emptyDays };
    const sessionList = [];   // { day, ts } one entry per unique session (Unix s)
    const seen        = new Set();
    let brushStates   = this._extractStates(wsData, brushId);

    if (brushStates.length === 0) {
      // REST fallback for brush entity
      try {
        const path = `history/period/${encodeURIComponent(start)}` +
          `?end_time=${encodeURIComponent(end)}&filter_entity_id=${brushId}&minimal_response&no_attributes`;
        const restRes = await this._hass.callApi('GET', path);
        brushStates = ((restRes && restRes[0]) || []).map(e => ({ s: e.state }));
      } catch {}
    }

    // pollTs = when HA recorded the state change (lu/lc), NOT the brush-session
    // value itself.  Both last_brush and duration sensors are written in the same
    // coordinator poll cycle, so using lu for correlation gives a sub-second match.
    const _addSession = (ms, pollTs) => {
      if (ms > 0 && !seen.has(ms)) {
        seen.add(ms);
        const day = new Date(ms).toISOString().slice(0, 10);
        if (day in counts) { counts[day]++; sessionList.push({ day, ts: pollTs || ms / 1000 }); }
      }
    };
    for (const s of brushStates) {
      const ms    = OcleanCard._stateToMs(s.s !== undefined ? s.s : s.state);
      const pollTs = s.lu || s.lc || 0;
      _addSession(ms, pollTs);
    }
    const curBrush = this._hass.states[brushId];
    if (curBrush) {
      const ms     = OcleanCard._stateToMs(curBrush.state);
      const pollTs = Date.parse(curBrush.last_changed || curBrush.last_updated || '') / 1000;
      _addSession(ms, pollTs);
    }
    sessionList.sort((a, b) => a.ts - b.ts);

    // ── Process score / coverage → per-day value arrays ───────────────────────
    const scoreByDay = this._buildValueHistory(this._extractStates(wsData, scoreId), emptyDays);
    const covByDay   = this._buildValueHistory(this._extractStates(wsData, covId),   emptyDays);

    // Append current entity state (covers no-recorder case)
    for (const [eId, byDay] of [[scoreId, scoreByDay], [covId, covByDay]]) {
      if (!eId) continue;
      const cur = this._hass.states[eId];
      if (!cur) continue;
      const val = parseFloat(cur.state);
      if (isNaN(val)) continue;
      const chMs = Date.parse(cur.last_changed || cur.last_updated || '');
      if (!chMs) continue;
      const day = new Date(chMs).toISOString().slice(0, 10);
      if (day in byDay) byDay[day].push(val);
    }

    // ── Duration per session: dedup + cap to session count ───────────────────
    // The duration sensor re-reports the same value on every poll (10-20× per day).
    // Strategy: collect raw values in chronological order, remove consecutive
    // duplicates (poll re-reports), then take the last N values where N equals
    // the confirmed session count from _historyData (same source as "Putzen" tab).
    const durationByDay = {};
    for (const key of Object.keys(emptyDays)) durationByDay[key] = [];
    if (durationId) {
      const rawByDay = this._buildValueHistory(
        this._extractStates(wsData, durationId), emptyDays);
      // Append current entity state (covers no-recorder case)
      const curDur = this._hass.states[durationId];
      if (curDur) {
        const v   = parseFloat(curDur.state);
        const chMs = Date.parse(curDur.last_changed || curDur.last_updated || '');
        if (!isNaN(v) && v > 0 && chMs) {
          const day = new Date(chMs).toISOString().slice(0, 10);
          if (day in rawByDay) rawByDay[day].push(v);
        }
      }
      for (const [day, vals] of Object.entries(rawByDay)) {
        // Remove consecutive identical values (poll re-reports)
        const deduped = [];
        let prev = null;
        for (const v of vals) { if (v !== prev) { deduped.push(v); prev = v; } }
        // Cap to confirmed session count so stacked bar matches "Putzen" count
        const n = counts[day] || 0;
        durationByDay[day] = n > 0 ? deduped.slice(-n) : [];
      }
    }

    this._historyData    = counts;
    this._scoreHistory   = scoreByDay;
    this._covHistory     = covByDay;
    this._durationHistory = durationByDay;
    if (c.debug) this._debugHistory = { brushStates: brushStates.length, counts, scoreByDay, covByDay, durationByDay };
    this._render();
  }

  // ── Colour helpers ───────────────────────────────────────────────────────────

  _scoreColor(v) {
    if (v === null) return 'var(--secondary-text-color)';
    return v >= 90 ? '#4CAF50' : v >= 70 ? '#FF9800' : '#F44336';
  }
  _overColor(v) {
    if (v === null) return 'var(--secondary-text-color)';
    return v >= 60 ? '#F44336' : v >= 30 ? '#FF9800' : '#4CAF50';
  }
  _valueColor(v) {
    // Zone quality scale: green=good, yellow=okay, orange=weak, red=very weak.
    // Used by zone bars and the tooth SVG.
    return v >= 75 ? '#4CAF50'
      : v >= 50 ? '#FFC107'
      : v >= 25 ? '#FF9800'
      : '#F44336';
  }
  // Duration colour: green ≥ 120 s (2 min), orange ≥ 60 s (1 min), red otherwise
  _durationColor(v) {
    if (v === null) return 'var(--secondary-text-color)';
    return v >= 120 ? '#4CAF50' : v >= 60 ? '#FF9800' : '#F44336';
  }

  // Format seconds as "m:ss"
  static _fmtSec(s) {
    if (s === null || s === undefined) return '–';
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  _relTime(ts) {
    if (!ts) return null;
    const diff = Math.floor(Date.now() / 1000 - ts);
    if (diff < 90)     return 'gerade eben';
    if (diff < 3600)   return `vor ${Math.floor(diff / 60)} Min.`;
    if (diff < 86400)  return `vor ${Math.floor(diff / 3600)} Std.`;
    return `vor ${Math.floor(diff / 86400)} Tagen`;
  }

  _zoneLabel(key) {
    return {
      upper_left_out:  'Oben Links Außen',    upper_left_in:  'Oben Links Innen',
      lower_left_out:  'Unten Links Außen',   lower_left_in:  'Unten Links Innen',
      upper_right_out: 'Oben Rechts Außen',   upper_right_in: 'Oben Rechts Innen',
      lower_right_out: 'Unten Rechts Außen',  lower_right_in: 'Unten Rechts Innen',
    }[key] || key;
  }

  // ── Zone row with avg + current + delta ───────────────────────────────────────
  //
  //  [Label         ] [███████|   ]  72  +12
  //                           ^── thin marker at avg position
  //  The bar shows the CURRENT value; the marker shows the AVERAGE.
  //  When no current session data is available the bar shows the average directly.

  _zoneRow(key, avg, current, isWeak, colorFn) {
    const avgPct = Math.min(100, Math.max(0, avg));
    const hasCurrent = current !== null;
    const displayPct = hasCurrent ? Math.min(100, Math.max(0, current)) : avgPct;
    const delta = hasCurrent ? Math.round(current - avg) : null;

    const cf = colorFn || (v => this._valueColor(v));
    const barColor = cf(displayPct);
    const labelHtml = `${this._zoneLabel(key)}${isWeak ? ' ⚠' : ''}`;

    // Average marker always shown when current session data is present
    const markerHtml = hasCurrent
      ? `<div class="zone-avg-mark" style="left:${avgPct}%"></div>`
      : '';

    const numHtml = `<span class="zone-num">${Math.round(hasCurrent ? current : avg)}</span>`;

    let deltaHtml = '';
    if (hasCurrent) {
      const sign = delta >= 0 ? '+' : '';
      const col  = delta >= 0 ? '#4CAF50' : '#EF5350';
      deltaHtml = `<span class="zone-delta" style="color:${col}">${sign}${delta}</span>`;
    } else {
      // Keep column width stable when current_zones is configured but this key is missing
      deltaHtml = `<span class="zone-delta"></span>`;
    }

    return `
      <div class="zone-row${isWeak ? ' zone-weak' : ''}">
        <span class="zone-lbl">${labelHtml}</span>
        <div class="zone-track">
          <div class="zone-fill" style="width:${displayPct}%;background:${barColor}"></div>
          ${markerHtml}
        </div>
        ${numHtml}
        ${deltaHtml}
      </div>`;
  }

  // ── 7-day SVG line chart (score / coverage) ──────────────────────────────────

  _lineChart(byDay, color) {
    const DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d   = new Date(now - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      const vals = (byDay && byDay[key]) || [];
      const avg  = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      days.push({ label: DE[d.getDay()], avg, isToday: key === today });
    }

    const CHART_H = 62, BAR_W = 28, GAP = 10, LABEL_Y = CHART_H + 16;
    const W  = days.length * (BAR_W + GAP) - GAP;
    const cx = i => i * (BAR_W + GAP) + BAR_W / 2;
    const cy = v => CHART_H - (v / 100 * CHART_H);
    const uid = `chart-${Math.random().toString(36).slice(2, 8)}`;

    // Quality zones + subtle grid.
    const grids = [50, 75, 90].map(v => {
      const y = cy(v).toFixed(1);
      return `<line x1="0" y1="${y}" x2="${W}" y2="${y}"
        stroke="rgba(128,128,128,0.16)" stroke-width="1" stroke-dasharray="3,3"/>
        <text x="${W + 2}" y="${(parseFloat(y) + 3).toFixed(1)}" font-size="7"
          fill="rgba(128,128,128,0.42)">${v}</text>`;
    }).join('');

    const points = days.map((d, i) => d.avg === null ? null : [cx(i), cy(d.avg), d.avg]);
    const valid = points.filter(Boolean);
    let pathD = '';
    valid.forEach((p, idx) => {
      if (idx === 0) pathD += `M ${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      else {
        const prev = valid[idx - 1];
        const mx = (prev[0] + p[0]) / 2;
        pathD += ` C ${mx.toFixed(1)} ${prev[1].toFixed(1)}, ${mx.toFixed(1)} ${p[1].toFixed(1)}, ${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      }
    });
    const areaD = valid.length
      ? `${pathD} L ${valid[valid.length - 1][0].toFixed(1)} ${CHART_H} L ${valid[0][0].toFixed(1)} ${CHART_H} Z`
      : '';

    const avgVals = valid.map(p => p[2]);
    const weekAvg = avgVals.length ? avgVals.reduce((a, b) => a + b, 0) / avgVals.length : null;
    const avgLine = weekAvg !== null ? `<line x1="0" y1="${cy(weekAvg).toFixed(1)}" x2="${W}" y2="${cy(weekAvg).toFixed(1)}"
      stroke="${color}" stroke-width="1" stroke-dasharray="5,4" opacity="0.32"/>` : '';

    const defs = `<defs>
      <linearGradient id="${uid}-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient>
      <filter id="${uid}-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>`;

    const dots = days.map((d, i) => {
      if (d.avg === null) return '';
      const x = cx(i).toFixed(1), y = cy(d.avg).toFixed(1);
      const r = d.isToday ? 4.6 : 3.2;
      return `
        ${d.isToday ? `<circle cx="${x}" cy="${y}" r="8" fill="${color}" opacity="0.14" filter="url(#${uid}-glow)"/>` : ''}
        <circle cx="${x}" cy="${y}" r="${r}" fill="var(--ha-card-background, #1c1c1e)" stroke="${color}" stroke-width="2.2"/>
        <text x="${x}" y="${(cy(d.avg) - r - 4).toFixed(1)}" text-anchor="middle"
          font-size="9" font-weight="700" fill="${color}">${Math.round(d.avg)}</text>`;
    }).join('');

    // Day labels
    const labels = days.map((d, i) => {
      const x = cx(i).toFixed(1);
      return `
        <text x="${x}" y="${LABEL_Y}" text-anchor="middle" font-size="10"
          fill="${d.isToday ? 'var(--primary-text-color)' : 'var(--secondary-text-color)'}"
          font-weight="${d.isToday ? '700' : '400'}">${d.label}</text>
        ${d.isToday ? `<circle cx="${x}" cy="${LABEL_Y + 5}" r="2" fill="var(--primary-text-color)" opacity="0.6"/>` : ''}`;
    }).join('');

    return `<svg viewBox="-18 -16 278 100" width="100%"
      preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">
      ${defs}${grids}${avgLine}
      ${areaD ? `<path d="${areaD}" fill="url(#${uid}-area)"/>` : ''}
      ${pathD ? `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2.8"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.92" filter="url(#${uid}-glow)"/>` : ''}
      ${dots}${labels}
    </svg>`;
  }

  // ── 7-day duration chart – stacked sessions ─────────────────────────────────
  //
  // Each day shows one stacked bar per brushing session (oldest at bottom, newest
  // on top). Each segment is coloured by its own duration quality:
  //   green  ≥ 2:00   orange ≥ 1:00   red < 1:00
  // A thin white gap separates segments so they are visually distinct.
  // The m:ss label is drawn inside the segment when it is tall enough (≥ 13 px),
  // otherwise a single total label appears above the whole bar.

  _durationChart(byDay) {
    const DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d      = new Date(now - i * 86_400_000);
      const key    = d.toISOString().slice(0, 10);
      const vals   = (byDay && byDay[key]) || [];
      // Sensor unit: minutes → convert each session to seconds
      const sessions = vals.map(v => Math.round(v * 60)).filter(s => s > 0);
      const totalSec  = sessions.reduce((a, b) => a + b, 0);
      days.push({ label: DE[d.getDay()], sessions, totalSec, isToday: key === today });
    }

    // Y-axis ceiling: max daily total, at least 150 s, rounded to next full minute
    const maxTotal = Math.max(...days.map(d => d.totalSec), 150);
    const ceilSec  = Math.ceil(maxTotal / 60) * 60;

    const CHART_H = 62, BAR_W = 28, GAP = 10, LABEL_Y = CHART_H + 16, SEG_GAP = 2;
    const W  = days.length * (BAR_W + GAP) - GAP;
    const cx = i => i * (BAR_W + GAP) + BAR_W / 2;
    const cy = v => CHART_H - (v / ceilSec * CHART_H);
    const uid = `dur-${Math.random().toString(36).slice(2, 8)}`;
    const dCol = s => s >= 120 ? `url(#${uid}-good)` : s >= 60 ? `url(#${uid}-mid)` : `url(#${uid}-bad)`;
    const dTextCol = s => s >= 120 ? '#4CAF50' : s >= 60 ? '#FFC107' : '#EF5350';
    const defs = `<defs>
      <linearGradient id="${uid}-good" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#66D36E"/><stop offset="100%" stop-color="#2E9E45"/></linearGradient>
      <linearGradient id="${uid}-mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFC107"/><stop offset="100%" stop-color="#FF9800"/></linearGradient>
      <linearGradient id="${uid}-bad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FF6B6B"/><stop offset="100%" stop-color="#EF5350"/></linearGradient>
      <filter id="${uid}-shadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="2" stdDeviation="1.8" flood-color="#000" flood-opacity="0.22"/></filter>
    </defs>`;
    // Grid lines at 1:00, 2:00, 3:00 (only those within range)
    const gridSecs = [60, 120, 180, 240].filter(s => s <= ceilSec);
    const grids = gridSecs.map(s => {
      const y   = cy(s).toFixed(1);
      const lbl = `${Math.floor(s / 60)}:00`;
      return `
        <line x1="0" y1="${y}" x2="${W}" y2="${y}"
          stroke="rgba(128,128,128,0.18)" stroke-width="1" stroke-dasharray="4,3"/>
        <text x="-3" y="${(parseFloat(y) + 3).toFixed(1)}" font-size="7.5"
          fill="rgba(128,128,128,0.4)" text-anchor="end">${lbl}</text>`;
    }).join('');

    const bars = days.map((d, i) => {
      const x = i * (BAR_W + GAP);
      const dayLabel = `
        <text x="${cx(i).toFixed(1)}" y="${LABEL_Y}" text-anchor="middle" font-size="10"
          fill="${d.isToday ? 'var(--primary-text-color)' : 'var(--secondary-text-color)'}"
          font-weight="${d.isToday ? '700' : '400'}">${d.label}</text>
        ${d.isToday ? `<circle cx="${cx(i).toFixed(1)}" cy="${LABEL_Y + 5}" r="2" fill="var(--primary-text-color)" opacity="0.6"/>` : ''}`;

      if (d.sessions.length === 0) {
        return `<g>
          <rect x="${x}" y="${CHART_H - 2}" width="${BAR_W}" height="2" rx="1"
            fill="rgba(128,128,128,0.2)"/>
          ${dayLabel}
        </g>`;
      }

      // Stack segments bottom→top (sessions[0] at bottom, last on top)
      let segments = '', cursor = CHART_H;
      let topY = CHART_H;  // track topmost pixel for the above-bar label
      d.sessions.forEach((sec, si) => {
        const segH = Math.max(4, Math.round(sec / ceilSec * CHART_H));
        const gapAbove = si > 0 ? SEG_GAP : 0;  // white gap between segments
        const segY  = cursor - segH - gapAbove;
        const color = dCol(sec);
        const isTop = si === d.sessions.length - 1;
        const isBot = si === 0;

        // Rounded corners: only top corners on top segment, only bottom corners on bottom
        const rx = 4;
        // Use a path for per-corner rounding, or just use rect with rx for simplicity
        // (rect rx rounds all corners — acceptable since gap creates visual separation)
        segments += `<rect x="${x}" y="${segY.toFixed(1)}" width="${BAR_W}"
          height="${segH}" rx="${isTop ? rx : isBot ? rx : 0}"
          fill="${color}" opacity="${d.isToday ? '1' : '0.86'}" filter="url(#${uid}-shadow)"
          ${d.isToday && isTop ? 'stroke="rgba(255,255,255,0.35)" stroke-width="1"' : ''}/>`;

        // Label inside segment if tall enough, otherwise skip (total label handles it)
        if (segH >= 13) {
          const midY = (segY + segH / 2 + 3.5).toFixed(1);
          segments += `<text x="${cx(i).toFixed(1)}" y="${midY}" text-anchor="middle"
            font-size="8.5" font-weight="700"
            fill="rgba(255,255,255,0.92)">${OcleanCard._fmtSec(sec)}</text>`;
        }

        cursor = segY - gapAbove;
        if (isTop) topY = segY;
      });

      // Above-bar label: total if >1 session and any segment was too small for its own label
      const anySmall = d.sessions.some(s => Math.round(s / ceilSec * CHART_H) < 13);
      let topLabel = '';
      if (d.sessions.length > 1) {
        // Always show session count badge when stacked
        const badgeColor = dTextCol(d.sessions[d.sessions.length - 1]);
        topLabel = `<text x="${cx(i).toFixed(1)}" y="${(topY - 5).toFixed(1)}" text-anchor="middle"
          font-size="8.5" font-weight="700" fill="${badgeColor}">${d.sessions.length}×</text>`;
      } else if (d.sessions.length === 1) {
        // Single session: show m:ss above bar
        const color = dTextCol(d.sessions[0]);
        const segH  = Math.round(d.sessions[0] / ceilSec * CHART_H);
        if (segH < 13) {
          topLabel = `<text x="${cx(i).toFixed(1)}" y="${(topY - 5).toFixed(1)}" text-anchor="middle"
            font-size="8.5" font-weight="700" fill="${color}">${OcleanCard._fmtSec(d.sessions[0])}</text>`;
        }
      }

      return `<g>${segments}${topLabel}${dayLabel}</g>`;
    }).join('');

    return `<svg viewBox="-18 -16 278 100" width="100%"
      preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">
      ${defs}${grids}${bars}
    </svg>`;
  }

  // ── 7-day SVG bar chart + tabs ────────────────────────────────────────────────

  _weekChart() {
    const tab   = this._activeTab;
    const DE    = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const now   = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const hasData = !!(this._historyData || this._scoreHistory || this._covHistory || this._durationHistory);

    // ── Badge: today's summary for the active tab ─────────────────────────────
    let badge = '<span class="loading">Lade…</span>';
    if (hasData) {
      if (tab === 0) {
        const n = (this._historyData && this._historyData[today]) || 0;
        badge = n > 0
          ? `<span style="color:#5C7AFF;font-weight:600">${n}× heute</span>`
          : `<span style="color:var(--secondary-text-color)">heute noch nicht</span>`;
      } else if (tab === 3) {
        // Duration tab — sensor in minutes, convert to seconds for display
        const vals = (this._durationHistory && this._durationHistory[today]) || [];
        const avgMin = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        badge = avgMin !== null
          ? `<span style="color:#FF9800;font-weight:600">Ø ${OcleanCard._fmtSec(Math.round(avgMin * 60))} heute</span>`
          : `<span style="color:var(--secondary-text-color)">heute noch nicht</span>`;
      } else {
        const src = tab === 1 ? this._scoreHistory : this._covHistory;
        const vals = (src && src[today]) || [];
        const avg  = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
        const unit = tab === 2 ? '%' : '';
        badge = avg !== null
          ? `<span style="color:#5C7AFF;font-weight:600">Ø ${avg}${unit} heute</span>`
          : `<span style="color:var(--secondary-text-color)">heute noch nicht</span>`;
      }
    }

    // ── Chart body ────────────────────────────────────────────────────────────
    let chartHtml = '';
    if (tab === 0) {
      // Brushing count bar chart
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d   = new Date(now - i * 86_400_000);
        const key = d.toISOString().slice(0, 10);
        days.push({ key, label: DE[d.getDay()], count: (this._historyData && this._historyData[key]) || 0, isToday: key === today });
      }
      const maxCount = Math.max(...days.map(d => d.count), 2);
      const BAR_W = 28, GAP = 10, CHART_H = 62, LABEL_Y = CHART_H + 16;
      const W    = days.length * (BAR_W + GAP) - GAP;
      const uid = `brush-${Math.random().toString(36).slice(2, 8)}`;
      const defs = `<defs>
        <linearGradient id="${uid}-good" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#66D36E"/><stop offset="100%" stop-color="#2E9E45"/></linearGradient>
        <linearGradient id="${uid}-one" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFC107"/><stop offset="100%" stop-color="#FF9800"/></linearGradient>
        <filter id="${uid}-shadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.25"/></filter>
      </defs>`;
      const targetY = CHART_H - (2 / maxCount * CHART_H);
      const target = `<line x1="0" y1="${targetY.toFixed(1)}" x2="${W}" y2="${targetY.toFixed(1)}" stroke="#4CAF50" stroke-width="1" stroke-dasharray="5,4" opacity="0.38"/>
        <text x="${W + 2}" y="${(targetY + 3).toFixed(1)}" font-size="7" fill="rgba(76,175,80,.65)">2×</text>`;
      const bars = days.map((d, i) => {
        const barH = d.count > 0 ? Math.max(6, Math.round(d.count / maxCount * CHART_H)) : 3;
        const x = i * (BAR_W + GAP), y = CHART_H - barH;
        const fill = d.count >= 2 ? `url(#${uid}-good)` : d.count === 1 ? `url(#${uid}-one)` : 'rgba(128,128,128,0.18)';
        return `<g>
          <rect x="${x}" y="${y}" width="${BAR_W}" height="${barH}" rx="7" fill="${fill}" filter="url(#${uid}-shadow)"
            ${d.isToday ? 'stroke="rgba(255,255,255,0.55)" stroke-width="1.4"' : ''}/>
          ${d.count > 0 ? `<text x="${x + BAR_W / 2}" y="${Math.max(9, y - 5)}" text-anchor="middle"
            font-size="10" font-weight="800" fill="${d.count >= 2 ? '#4CAF50' : '#FFC107'}">${d.count}</text>` : ''}
          <text x="${x + BAR_W / 2}" y="${LABEL_Y}" text-anchor="middle" font-size="10"
            fill="${d.isToday ? 'var(--primary-text-color)' : 'var(--secondary-text-color)'}"
            font-weight="${d.isToday ? '800' : '500'}">${d.label}</text>
          ${d.isToday ? `<circle cx="${x + BAR_W / 2}" cy="${LABEL_Y + 5}" r="2" fill="var(--primary-text-color)" opacity="0.65"/>` : ''}
        </g>`;
      }).join('');
      chartHtml = `<svg viewBox="-18 -16 278 100" width="100%"
        preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">${defs}${target}${bars}</svg>`;
    } else if (tab === 3) {
      chartHtml = this._durationChart(this._durationHistory);
    } else {
      chartHtml = this._lineChart(
        tab === 1 ? this._scoreHistory : this._covHistory,
        tab === 1 ? '#5C7AFF' : '#4CAF50',
      );
    }

    // ── Tab bar ───────────────────────────────────────────────────────────────
    const tabLabels = this._config && this._config.duration
      ? ['Putzen', 'Score', 'Abdeckung', 'Dauer']
      : ['Putzen', 'Score', 'Abdeckung'];
    const tabs = tabLabels.map((lbl, i) =>
      `<button class="tab${tab === i ? ' tab-active' : ''}" data-tab="${i}">${lbl}</button>`
    ).join('');

    return `
      <div class="section-hdr">
        <span class="section-lbl">7-Tage Statistik</span>
        ${badge}
      </div>
      <div class="tabs">${tabs}</div>
      ${chartHtml}`;
  }

  // ── Dental arch SVG (Abdeckung / coverage view) ──────────────────────────────

  // mode='pressure': green=light, orange=medium, red=high (matches image.py)
  // mode='coverage': value is already normalised 0-100; green≥75%, yellow≥50%, orange≥25%, red>0%
  _archSvg(zones, mode = 'coverage', powerZones = null) {
    if (!zones) return '';
    // Compact wall-display arch, but with the original clean oval shape.
    const W = 300, H = 300, MID_Y = 150;
    const UPPER = {cx: 150, cy: 146, rx: 68, ry: 112, s: 185, e: 355};
    const LOWER = {cx: 150, cy: 154, rx: 68, ry: 112, s: 5,   e: 175};
    const N = 16, R = 10;
    const rad = d => d * Math.PI / 180;

    const pts = (jaw) => Array.from({length: N}, (_, i) => {
      const t = rad(jaw.s) + (rad(jaw.e) - rad(jaw.s)) * i / (N - 1);
      return [jaw.cx + jaw.rx * Math.cos(t), jaw.cy + jaw.ry * Math.sin(t)];
    });

    const sects = (jaw) => {
      const h = N / 2;
      const s = [...Array(h).fill('left'), ...Array(N - h).fill('right')];
      return jaw === 'lower' ? [...s].reverse() : s;
    };

    const semi = (tx, ty, r, cx, cy, outer) => {
      const a = Math.atan2(ty - cy, tx - cx), p = a + Math.PI / 2;
      const [ax, ay] = [tx + r * Math.cos(p), ty + r * Math.sin(p)];
      const [bx, by] = [tx - r * Math.cos(p), ty - r * Math.sin(p)];
      return `M ${ax.toFixed(1)} ${ay.toFixed(1)} A ${r} ${r} 0 0 ${outer ? 0 : 1} ${bx.toFixed(1)} ${by.toFixed(1)} Z`;
    };

    const maxVal = Math.max(...Object.values(zones).filter(v => v > 0), 0);
    const scale  = maxVal > 100 ? 255 : 100;

    // pressure: low=green, high=red (0308-extended, 0-255 raw ADC)
    // coverage: quality/intensity scale, same colour bands as the zone bars.
    const col = mode === 'pressure'
      ? v => { if (!v || v <= 0) return null; const r = v / scale; return r <= 80/255 ? '#4CAF50' : r <= 160/255 ? '#FF9800' : '#F44336'; }
      : v => { if (!v || v <= 0) return null; return this._valueColor(v); };
    const powerLevel = v => v >= 3 ? 'r' : v >= 2 ? 'o' : v >= 1 ? 'y' : null;
    const powerTint = lvl => lvl === 'r' ? '#F44336' : lvl === 'o' ? '#FF9800' : lvl === 'y' ? '#FFC107' : null;
    const hatchId = `oclean-hatch-${Math.random().toString(36).slice(2, 8)}`;

    const el = [];
    if (powerZones) {
      el.push(`<defs>
        <pattern id="${hatchId}-y" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#FFC107" stroke-width="2.4" opacity="1"/>
        </pattern>
        <pattern id="${hatchId}-o" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#FF9800" stroke-width="2.7" opacity="1"/>
        </pattern>
        <pattern id="${hatchId}-r" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke="#F44336" stroke-width="2.9" opacity="1"/>
        </pattern>
      </defs>`);
    }
    for (const [jaw, def] of [['upper', UPPER], ['lower', LOWER]]) {
      const pos = pts(def), map = sects(jaw);
      for (let i = 0; i < N; i++) {
        const [tx, ty] = pos[i], sec = map[i];
        const cO = col(zones[`${jaw}_${sec}_out`] || 0);
        const cI = col(zones[`${jaw}_${sec}_in`]  || 0);
        el.push(`<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="${R}" fill="#444" stroke="#555" stroke-width="0.5"/>`);
        const dO = semi(tx, ty, R, def.cx, def.cy, true);
        const dI = semi(tx, ty, R, def.cx, def.cy, false);
        if (cO) el.push(`<path d="${dO}" fill="${cO}" opacity="0.9"/>`);
        if (cI) el.push(`<path d="${dI}" fill="${cI}" opacity="0.9"/>`);
        const pO = powerZones ? powerLevel(powerZones[`${jaw}_${sec}_out`] || 0) : null;
        const pI = powerZones ? powerLevel(powerZones[`${jaw}_${sec}_in`] || 0) : null;
        if (pO) {
          el.push(`<path class="power-tint" d="${dO}" fill="${powerTint(pO)}" opacity="0.30"/>`);
          el.push(`<path class="power-hatch" d="${dO}" fill="url(#${hatchId}-${pO})" opacity="1"/>`);
        }
        if (pI) {
          el.push(`<path class="power-tint" d="${dI}" fill="${powerTint(pI)}" opacity="0.30"/>`);
          el.push(`<path class="power-hatch" d="${dI}" fill="url(#${hatchId}-${pI})" opacity="1"/>`);
        }
      }
    }
    el.push(`<line x1="20" y1="${MID_Y}" x2="${W-20}" y2="${MID_Y}" stroke="#555" stroke-width="1" stroke-dasharray="4,4"/>`);
    el.push(`<text x="12"     y="${MID_Y+5}" font-size="13" fill="#888" text-anchor="middle">L</text>`);
    el.push(`<text x="${W-12}" y="${MID_Y+5}" font-size="13" fill="#888" text-anchor="middle">R</text>`);

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;border-radius:inherit">${el.join('')}</svg>`;
  }

  // ── Images section with Druck / Abdeckung toggle ──────────────────────────────

  _imagesSection() {
    const c = this._config;
    if (!c.current_zones && !c.weak_zone) return '';

    const cur  = c.current_zones ? this._currentZones(c.current_zones) : null;
    const hist = c.weak_zone ? this._zoneData(c.weak_zone) : null;
    const power = c.power_zones ? this._powerZones(c.power_zones) : null;

    const active = this._imageTab === 1 ? 1 : 0;
    const selected = active === 0
      ? { label: 'Letzte Sitzung', zones: cur, powerOverlay: power, sub: 'Aktuelle Reinigungsintensität mit Druck-Overlay' }
      : { label: 'Verlauf-Ø', zones: hist ? hist.zones : null, powerOverlay: null, sub: `Durchschnitt aus ${hist ? hist.sessions : 0} Sitzungen` };
    const normZones = this._normalizeZones(selected.zones);
    const tabs = ['Letzte Sitzung', 'Verlauf-Ø'].map((lbl, i) =>
      `<button class="tab${active === i ? ' tab-active' : ''}" data-image-tab="${i}">${lbl}</button>`
    ).join('');

    return `
      <div class="section-hdr" style="margin-bottom:8px">
        <span class="section-lbl">Zonenanalyse</span>
      </div>
      <div class="tabs image-tabs">${tabs}</div>
      <div class="svg-legend">
        <div><b>Gefüllt</b> = Reinigungsintensität <span class="z-red">■</span> schwach <span class="z-yellow">■</span> mittel <span class="z-green">■</span> gut</div>
        ${active === 0 && power ? '<div><b>Schraffur</b> = Druckhinweis <span class="p-ring-y">▧</span> leicht <span class="p-ring-o">▧</span> erhöht <span class="p-ring-r">▧</span> stark</div>' : ''}
      </div>
      <div class="images single-image">
        <div class="img-box">
          <div class="img-lbl">${selected.label}<span>${selected.sub}</span></div>
          ${normZones ? this._archSvg(normZones, 'coverage', selected.powerOverlay) : '<div class="img-empty">Keine Daten</div>'}
        </div>
      </div>`;
  }

  // ── Smart analysis / coaching ────────────────────────────────────────────────

  _zoneInsights(zones) {
    const norm = this._normalizeZones(zones);
    if (!norm) return null;
    const entries = Object.entries(norm).filter(([, v]) => typeof v === 'number');
    if (!entries.length) return null;

    entries.sort((a, b) => a[1] - b[1]);
    const weak = entries[0], best = entries[entries.length - 1];
    const vals = entries.map(([, v]) => v);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const min = vals[0], max = vals[vals.length - 1] || 1;
    const variance = vals.reduce((a, v) => a + Math.pow(v - avg, 2), 0) / vals.length;
    const spreadPenalty = Math.min(55, Math.sqrt(variance) * 0.9);
    const weakPenalty = Math.max(0, 70 - min) * 0.35;
    const balance = Math.max(0, Math.min(100, Math.round(100 - spreadPenalty - weakPenalty)));

    const groupAvg = (pred) => {
      const arr = entries.filter(([k]) => pred(k)).map(([, v]) => v);
      return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    };

    return {
      weakKey: weak[0], weakVal: Math.round(weak[1]),
      bestKey: best[0], bestVal: Math.round(best[1]),
      avg: Math.round(avg), balance,
      groups: {
        oben: groupAvg(k => k.startsWith('upper_')),
        unten: groupAvg(k => k.startsWith('lower_')),
        links: groupAvg(k => k.includes('_left_')),
        rechts: groupAvg(k => k.includes('_right_')),
        innen: groupAvg(k => k.endsWith('_in')),
        aussen: groupAvg(k => k.endsWith('_out')),
      },
      allGreen: min >= 75,
    };
  }

  _pressureProfile() {
    const s = this._state(this._config && this._config.overpressure);
    const a = s && s.attributes;
    if (!a) return '';
    const vals = [a.level_1, a.level_2, a.level_3, a.level_4_heavy, a.level_5_very_heavy]
      .map(v => typeof v === 'number' ? v : parseFloat(v))
      .map(v => isNaN(v) ? 0 : v);
    const total = vals.reduce((x, y) => x + y, 0);
    if (!total) return '';

    const seg = (v, cls, title) => {
      const pct = Math.round(v / total * 100);
      return pct > 0 ? `<div class="press-seg ${cls}" style="width:${pct}%" title="${title}: ${pct}%"></div>` : '';
    };
    const gentle = vals[0] + vals[1];
    const normal = vals[2];
    const heavy = vals[3] + vals[4];
    return `<div class="pressure-profile">
      <div class="mini-title">Druckprofil</div>
      <div class="press-track">
        ${seg(gentle, 'p-gentle', 'Sanft')}${seg(normal, 'p-normal', 'Normal')}${seg(heavy, 'p-heavy', 'Zu stark')}
      </div>
      <div class="press-labels"><span>Sanft ${Math.round(gentle / total * 100)}%</span><span>Normal ${Math.round(normal / total * 100)}%</span><span>Stark ${Math.round(heavy / total * 100)}%</span></div>
    </div>`;
  }

  _pressureZoneInsights() {
    const power = this._config && this._config.power_zones ? this._powerZones(this._config.power_zones) : null;
    if (!power) return null;
    const entries = Object.entries(power)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (!entries.length) return null;
    const high = entries.filter(([, v]) => v >= 2);
    return {
      entries,
      high,
      text: high.length
        ? `Erhöhter Druck wurde vor allem ${high.slice(0, 2).map(([k]) => this._zoneLabel(k)).join(' und ')} erkannt.`
        : `Leichte Druckspitzen bei ${entries.slice(0, 2).map(([k]) => this._zoneLabel(k)).join(' und ')}.`,
    };
  }

  _streakInfo() {
    if (!this._historyData) return '';
    let streak = 0;
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      const key = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      if ((this._historyData[key] || 0) > 0) streak++;
      else break;
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const todayCount = this._historyData[today] || 0;
    return `<div class="habit-row">
      <span>${streak} Tage Streak</span>
      <span>Heute ${todayCount}/2</span>
    </div>`;
  }

  _coachSection() {
    const c = this._config;
    const curZones = c.current_zones ? this._currentZones(c.current_zones) : null;
    const zoneData = curZones || (c.weak_zone ? (this._zoneData(c.weak_zone) || {}).zones : null);
    const z = this._zoneInsights(zoneData);
    const score = this._num(c.score);
    const coverage = this._num(c.coverage);
    const over = this._num(c.overpressure);
    const durationMin = this._num(c.duration);
    const duration = durationMin !== null ? Math.round(durationMin * 60) : null;
    const pressureZones = this._pressureZoneInsights();

    if (!z && score === null && coverage === null && over === null && duration === null && !pressureZones) return '';

    const badges = [];
    if (coverage !== null && coverage >= 100) badges.push(['Abdeckung vollständig', 'good']);
    else if (coverage !== null && coverage >= 75) badges.push(['Abdeckung gut', 'good']);
    else if (coverage !== null) badges.push(['Abdeckung ausbaufähig', 'warn']);
    if (duration !== null) badges.push(duration >= 120 ? ['Dauer gut', 'good'] : ['Dauer kurz', 'bad']);
    if (over !== null) badges.push(over >= 60 ? ['Druck zu hoch', 'bad'] : over >= 30 ? ['Druck erhöht', 'warn'] : ['Druck stabil', 'good']);
    if (pressureZones && pressureZones.high.length) badges.push(['Druckzonen erkannt', 'warn']);
    if (z && z.allGreen) badges.push(['Gleichmäßig', 'good']);

    let verdict = 'Analyse bereit';
    let assessment = 'Es liegen noch nicht genug Daten für eine belastbare Einschätzung vor.';
    let tip = 'Sammle noch ein paar Sitzungen, damit Trends und Empfehlungen stabiler werden.';
    if (score !== null && score >= 90 && coverage !== null && coverage >= 100 && (!over || over < 60)) {
      verdict = 'Starke Sitzung';
      assessment = z && !z.allGreen
        ? 'Die Abdeckung ist vollständig. Die Intensität ist jedoch noch nicht ganz gleichmäßig verteilt.'
        : 'Sehr gute Abdeckung mit gleichmäßiger Intensität.';
      tip = z && !z.allGreen ? `Morgen-Fokus: ${this._zoneLabel(z.weakKey)} etwas länger putzen.` : 'Behalte Technik und Druck bei.';
    } else if (over !== null && over >= 60) {
      verdict = 'Druck reduzieren';
      assessment = 'Die Abdeckung ist gut, aber der Anteil hoher Druckstufen ist deutlich erhöht.';
      tip = 'Führe die Bürste langsamer und mit weniger Anpressdruck. Lass den Bürstenkopf arbeiten.';
    } else if (z) {
      verdict = z.balance >= 80 ? 'Gute Balance' : 'Ungleichmäßige Intensität';
      assessment = z.balance >= 80
        ? 'Die Zonen sind insgesamt ausgewogen geputzt.'
        : 'Einige Bereiche wurden deutlich intensiver gereinigt als andere.';
      tip = `Morgen-Fokus: 10 Sekunden extra bei ${this._zoneLabel(z.weakKey)}.`;
    }

    if (pressureZones) {
      assessment += ` ${pressureZones.text}`;
      if (pressureZones.high.length) tip += ` Druck-Fokus: bei ${this._zoneLabel(pressureZones.high[0][0])} lockerer führen.`;
    }

    const verdictClass = over !== null && over >= 60 ? 'bad' : (z && z.balance < 70) || (coverage !== null && coverage < 75) ? 'warn' : 'good';
    const balanceHtml = z ? `<div class="assistant-hero">
      <div class="balance-orb" style="--balance:${z.balance};--balance-color:${this._valueColor(z.balance)}">
        <span>${z.balance}</span><small>%</small>
      </div>
      <div class="assistant-hero-text">
        <div class="mini-title">Dental Balance Score</div>
        <div class="assistant-verdict ${verdictClass}">${verdict}</div>
        <div class="balance-explain">Gleichmäßigkeit der gereinigten Zonen</div>
      </div>
    </div>` : `<div class="assistant-hero compact">
      <div class="assistant-hero-text"><div class="mini-title">Status</div><div class="assistant-verdict ${verdictClass}">${verdict}</div></div>
    </div>`;

    const pressureZoneHtml = pressureZones ? `<div class="pressure-zone-card">
      <div class="mini-title">Druckzonen</div>
      <div class="assistant-text">${pressureZones.text}</div>
    </div>` : '';

    return `<details class="coach-card">
      <summary class="coach-summary">
        <span class="assistant-title"><span class="assistant-icon">✦</span> Dental Assistant</span>
      </summary>
      <div class="coach-body">
        ${balanceHtml}
        <div class="badge-row">${badges.map(([txt, cls]) => `<span class="coach-badge ${cls}">${txt}</span>`).join('')}</div>
        <div class="assistant-grid">
          <div class="assistant-panel">
            <div class="mini-title">Einschätzung</div>
            <div class="assistant-text">${assessment}</div>
          </div>
          <div class="assistant-panel action">
            <div class="mini-title">Nächster Fokus</div>
            <div class="assistant-text">${tip}</div>
          </div>
        </div>
        ${pressureZoneHtml}
        ${this._pressureProfile()}
        ${this._streakInfo()}
      </div>
    </details>`;
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  _render() {
    if (!this._hass || !this._config) return;
    const c = this._config;

    const score        = this._num(c.score);
    const coverage     = this._num(c.coverage);
    const pressure     = this._num(c.pressure);
    const overpressure = this._num(c.overpressure);
    const battery      = this._num(c.battery);
    const durationMin  = this._num(c.duration);              // sensor unit: minutes
    const duration     = durationMin !== null ? Math.round(durationMin * 60) : null; // → seconds
    const lastTs       = this._ts(c.last_brush);
    const brushDays    = this._num(c.brush_head_days);
    const brushUsage   = this._num(c.brush_head_usage);
    const brushWear    = this._num(c.brush_head_wear);
    const lastPoll     = this._ts(c.last_poll);
    const weakZone     = this._str(c.weak_zone);
    const zoneData     = this._zoneData(c.weak_zone);
    const curZones     = c.current_zones ? this._currentZones(c.current_zones) : null;

    // ── Stats ──────────────────────────────────────────────────────────────────
    const statDefs = [
      { lbl: 'Score',     val: score       !== null ? score                : '–', unit: '',  color: this._scoreColor(score),    entity: c.score },
      { lbl: 'Abdeckung', val: coverage    !== null ? coverage             : '–', unit: '%', color: 'var(--primary-text-color)', entity: c.coverage },
      { lbl: 'Ø Druck',   val: pressure    !== null ? Math.round(pressure) : '–', unit: '',  color: 'var(--primary-text-color)', entity: c.pressure },
      { lbl: 'Überdruck', val: overpressure !== null ? overpressure        : '–', unit: '%', color: this._overColor(overpressure), entity: c.overpressure },
    ];
    // Insert Dauer KPI as 2nd entry (after Score) when configured
    if (c.duration) {
      statDefs.splice(1, 0, {
        lbl: 'Dauer',
        val: duration !== null ? OcleanCard._fmtSec(duration) : '–',
        unit: '',
        color: this._durationColor(duration),
        entity: c.duration,
        isTime: true,
      });
    }

    const numStats = statDefs.length; // 4 or 5
    const statsHtml = statDefs.map(s => `
      <div class="stat" ${s.entity ? `data-entity="${s.entity}"` : ''}>
        <div class="stat-val${s.isTime ? ' stat-val-time' : ''}" style="color:${s.color}">${s.val}<span class="stat-unit">${s.unit}</span></div>
        <div class="stat-lbl">${s.lbl}</div>
      </div>`).join('');

    // ── Device & maintenance ──────────────────────────────────────────────────
    const brushHeadHtml = (battery !== null || lastPoll !== null || brushDays !== null || brushUsage !== null || brushWear !== null) ? (() => {
      const wearPct = brushWear !== null ? Math.min(100, Math.max(0, brushWear)) : null;
      const headCondition = wearPct !== null ? Math.max(0, 100 - wearPct) : null; // inverted: 100% = new/good
      const headColor = headCondition === null ? '#4CAF50'
        : headCondition < 30 ? '#F44336'
        : headCondition < 60 ? '#FF9800'
        : '#4CAF50';
      const battScore = battery !== null ? Math.min(100, Math.max(0, battery)) : null;
      const pollAge = lastPoll ? Math.max(0, Math.floor(Date.now() / 1000 - lastPoll)) : null;
      const pollScore = pollAge === null ? null : pollAge < 6 * 3600 ? 100 : pollAge < 24 * 3600 ? 75 : 35;
      const healthParts = [battScore, headCondition, pollScore].filter(v => v !== null);
      const deviceHealth = healthParts.length ? Math.round(healthParts.reduce((a, b) => a + b, 0) / healthParts.length) : null;
      const healthColor = deviceHealth === null ? '#4CAF50'
        : deviceHealth < 45 ? '#F44336'
        : deviceHealth < 70 ? '#FF9800'
        : '#4CAF50';
      const recommendation = headCondition !== null && headCondition < 30
        ? 'Bürstenkopf wechseln empfohlen.'
        : headCondition !== null && headCondition < 60
          ? 'Bürstenkopf demnächst einplanen.'
          : 'Gerät und Bürstenkopf sind in gutem Zustand.';
      const row = (label, value, sub = '') => `<div class="maint-row"><span>${label}</span><b>${value}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
      return `<details class="maintenance-card">
        <summary class="maintenance-summary">
          <span class="assistant-title"><span class="maintenance-icon">⚙</span> Gerät & Wartung</span>
          <span class="maintenance-quick">${battery !== null ? `Akku ${battery}%` : ''}${battery !== null && headCondition !== null ? ' · ' : ''}${headCondition !== null ? `Kopf ${headCondition}%` : ''}</span>
        </summary>
        <div class="maintenance-body">
          <div class="maintenance-hero">
            ${deviceHealth !== null ? `<div class="health-orb" style="--health:${deviceHealth};--health-color:${healthColor}"><span>${deviceHealth}</span><small>%</small></div>` : ''}
            <div class="maintenance-hero-text">
              <div class="mini-title">Device Health</div>
              <div class="maintenance-verdict" style="color:${healthColor}">${deviceHealth !== null ? `${deviceHealth}%` : 'Bereit'}</div>
              <div class="balance-explain">Akku, Kopfzustand und Aktualität</div>
            </div>
          </div>
          ${headCondition !== null ? `<div class="head-condition">
            <div class="maint-bar-head"><span>Kopfzustand</span><b style="color:${headColor}">${headCondition}%</b></div>
            <div class="brush-bar-track"><div class="brush-bar-fill" style="width:${headCondition}%;background:${headColor}"></div></div>
            <div class="balance-explain">Verschleiß: ${wearPct}%</div>
          </div>` : ''}
          <div class="maintenance-rows">
            ${battery !== null ? row('Akku', `${battery}%`) : ''}
            ${brushDays !== null ? row('Kopfalter', `${brushDays} Tage`) : ''}
            ${brushUsage !== null ? row('Putzvorgänge', `${brushUsage}`) : ''}
            ${lastPoll !== null ? row('Letzte Abfrage', this._relTime(lastPoll) || '–') : ''}
          </div>
          <div class="maintenance-tip">${recommendation}</div>
        </div>
      </details>`;
    })() : '';

    const zonesHtml = this._zonesSection();

    // ── Full card HTML ─────────────────────────────────────────────────────────
    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
          border-radius: var(--ha-card-border-radius, 14px);
          box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,.25));
          padding: 16px;
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
          color: var(--primary-text-color);
        }

        /* Header */
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
        .title { font-size: 15px; font-weight: 600; letter-spacing: .2px; }
        .header-right { display: flex; align-items: center; gap: 8px; }
        .battery { display: flex; align-items: center; gap: 3px; font-size: 12px; color: var(--secondary-text-color); }
        .battery ha-icon { --mdc-icon-size: 16px; }
        .refresh-btn {
          background: none; border: none; cursor: pointer; padding: 4px;
          color: var(--secondary-text-color); border-radius: 6px;
          display: flex; align-items: center;
          transition: background .15s, color .15s;
          --mdc-icon-size: 18px;
        }
        .refresh-btn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .refresh-btn:active { opacity: .6; }
        .subtitle { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 14px; }

        /* Stats – adaptive columns (4 or 5) */
        .stats { display: grid; grid-template-columns: repeat(${numStats}, 1fr); gap: 6px; margin-bottom: 14px; }
        .stat { background: var(--secondary-background-color); border-radius: 10px; padding: 10px 4px; text-align: center; }
        .stat[data-entity] { cursor: pointer; transition: filter .15s, transform .1s; }
        .stat[data-entity]:hover { filter: brightness(1.15); }
        .stat[data-entity]:active { transform: scale(.96); }
        .stat-val { font-size: 20px; font-weight: 700; line-height: 1.1; }
        .stat-val-time { font-size: 17px; }   /* m:ss is wider → slightly smaller */
        .stat-unit { font-size: 12px; font-weight: 400; }
        .stat-lbl { font-size: 9px; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .6px; margin-top: 4px; }

        /* Smart assistant */
        .coach-card { background: linear-gradient(135deg, rgba(92,122,255,.22), rgba(76,175,80,.13)); border: 1px solid rgba(128,128,128,.28); border-radius: 12px; margin: -2px 0 14px; overflow: hidden; box-shadow: inset 0 1px 0 rgba(255,255,255,.04); }
        .coach-summary { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 12px; cursor: pointer; list-style: none; font-size: 14px; font-weight: 800; }
        .coach-summary::-webkit-details-marker { display: none; }
        .coach-summary::after { content: '›'; color: var(--secondary-text-color); font-size: 18px; transform: rotate(90deg); transition: transform .15s ease; }
        .coach-card[open] .coach-summary::after { transform: rotate(-90deg); }
        .assistant-title { display: flex; align-items: center; gap: 7px; }
        .assistant-icon { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: rgba(92,122,255,.32); color: #8EA2FF; font-size: 14px; }
        .coach-score { margin-left: auto; font-size: 11px; color: var(--secondary-text-color); font-weight: 600; white-space: nowrap; }
        .coach-body { display: flex; flex-direction: column; gap: 8px; padding: 0 11px 11px; }
        .badge-row { display: flex; gap: 5px; flex-wrap: wrap; margin: 0; }
        .coach-badge { font-size: 11px; font-weight: 800; border-radius: 999px; padding: 4px 8px; background: rgba(128,128,128,.22); border: 1px solid rgba(255,255,255,.06); }
        .coach-badge.good { color: #7BE083; background: rgba(76,175,80,.24); border-color: rgba(76,175,80,.34); }
        .coach-badge.warn { color: #FFD54F; background: rgba(255,193,7,.24); border-color: rgba(255,193,7,.34); }
        .coach-badge.bad { color: #FF796F; background: rgba(244,67,54,.24); border-color: rgba(244,67,54,.34); }
        .assistant-hero { display: flex; align-items: center; gap: 12px; background: rgba(0,0,0,.24); border: 1px solid rgba(255,255,255,.10); border-radius: 12px; padding: 11px; margin: 0; }
        .assistant-hero.compact { padding: 9px 10px; }
        .balance-orb { width: 58px; height: 58px; flex-shrink: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: conic-gradient(var(--balance-color) calc(var(--balance) * 1%), rgba(128,128,128,.18) 0); position: relative; box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
        .balance-orb::after { content: ''; position: absolute; inset: 6px; border-radius: 50%; background: var(--ha-card-background, var(--card-background-color, #1c1c1e)); }
        .balance-orb span, .balance-orb small { position: relative; z-index: 1; font-weight: 800; color: var(--primary-text-color); }
        .balance-orb span { font-size: 19px; letter-spacing: -.5px; } .balance-orb small { font-size: 10px; margin-left: 1px; opacity: .75; }
        .assistant-hero-text { min-width: 0; flex: 1; }
        .assistant-verdict { font-size: 16px; font-weight: 900; line-height: 1.15; margin-top: 2px; }
        .assistant-verdict.good { color: #7BE083; } .assistant-verdict.warn { color: #FFD54F; } .assistant-verdict.bad { color: #FF796F; }
        .balance-explain { font-size: 11.5px; color: var(--secondary-text-color); margin-top: 3px; }
        .assistant-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
        .assistant-panel, .pressure-zone-card { background: rgba(128,128,128,.17); border: 1px solid rgba(255,255,255,.10); border-radius: 10px; padding: 10px; }
        .assistant-panel.action { background: rgba(92,122,255,.18); border-color: rgba(92,122,255,.32); box-shadow: inset 3px 0 0 rgba(92,122,255,.7); }
        .pressure-zone-card { background: rgba(255,152,0,.16); border-color: rgba(255,152,0,.30); }
        .assistant-text { font-size: 13px; line-height: 1.48; color: var(--primary-text-color); }
        .habit-row { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5px; color: var(--secondary-text-color); margin: 0; }
        .mini-title { font-size: 10px; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .55px; margin-bottom: 5px; font-weight: 800; }
        .pressure-profile { margin: 0; }
        .press-track { display: flex; height: 8px; overflow: hidden; border-radius: 5px; background: rgba(128,128,128,.16); }
        .press-seg { height: 100%; min-width: 2px; }
        .p-gentle { background: #4CAF50; } .p-normal { background: #FFC107; } .p-heavy { background: #F44336; }
        .press-labels { display: flex; justify-content: space-between; font-size: 9px; color: var(--secondary-text-color); margin-top: 3px; }

        /* Images */
        .images { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
        .images.single-image { grid-template-columns: 1fr; }
        .image-tabs { margin-bottom: 8px; }
        .img-box { background: var(--secondary-background-color); border-radius: 10px; overflow: hidden; text-align: center; display: flex; flex-direction: column; }
        .img-box img { width: 100%; display: block; }
        .img-lbl { font-size: 10px; color: var(--primary-text-color); padding: 7px 0 4px; text-transform: uppercase; letter-spacing: .7px; font-weight: 800; }
        .img-lbl span { display: block; margin-top: 2px; font-size: 9px; color: var(--secondary-text-color); text-transform: none; letter-spacing: .2px; font-weight: 500; }
        .svg-legend { font-size: 9.5px; line-height: 1.45; color: var(--secondary-text-color); margin: -3px 0 8px; }
        .svg-legend b { color: var(--primary-text-color); font-weight: 700; }
        .z-red { color: #F44336; margin-left: 4px; } .z-yellow { color: #FFC107; margin-left: 6px; } .z-green { color: #4CAF50; margin-left: 6px; }
        .p-ring-y { color: #FFC107; margin-left: 4px; } .p-ring-o { color: #FF9800; margin-left: 6px; } .p-ring-r { color: #F44336; margin-left: 6px; }
        .img-empty { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 80px; font-size: 11px; color: var(--secondary-text-color); }

        /* Dividers / section headers */
        .divider { border: none; border-top: 1px solid var(--divider-color, rgba(128,128,128,.2)); margin: 12px 0; }
        .section-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .section-lbl { font-size: 10px; font-weight: 600; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .8px; }
        .badge { font-size: 10px; color: var(--secondary-text-color); background: var(--secondary-background-color); border-radius: 10px; padding: 2px 9px; }
        .loading { font-size: 11px; color: var(--secondary-text-color); }

        /* Zone legend line */
        .zone-legend-line { font-size: 10px; color: var(--secondary-text-color); margin-bottom: 8px; }
        .zleg-bar  { color: var(--primary-text-color); font-weight: 700; }
        .zleg-mark { opacity: .55; }

        /* Device & maintenance */
        .maintenance-card { background: var(--secondary-background-color); border: 1px solid rgba(128,128,128,.16); border-radius: 12px; overflow: hidden; }
        .maintenance-summary { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 11px 12px; cursor: pointer; list-style: none; font-size: 12.5px; font-weight: 700; }
        .maintenance-summary::-webkit-details-marker { display: none; }
        .maintenance-summary::after { content: '›'; color: var(--secondary-text-color); font-size: 18px; transform: rotate(90deg); transition: transform .15s ease; }
        .maintenance-card[open] .maintenance-summary::after { transform: rotate(-90deg); }
        .maintenance-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: rgba(128,128,128,.16); color: var(--secondary-text-color); font-size: 12px; }
        .maintenance-quick { margin-left: auto; font-size: 10.5px; color: var(--secondary-text-color); font-weight: 600; white-space: nowrap; }
        .maintenance-body { display: flex; flex-direction: column; gap: 8px; padding: 0 11px 11px; }
        .maintenance-hero { display: flex; align-items: center; gap: 12px; background: rgba(0,0,0,.12); border-radius: 10px; padding: 10px; }
        .health-orb { width: 52px; height: 52px; flex-shrink: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: conic-gradient(var(--health-color) calc(var(--health) * 1%), rgba(128,128,128,.18) 0); position: relative; }
        .health-orb::after { content: ''; position: absolute; inset: 6px; border-radius: 50%; background: var(--ha-card-background, var(--card-background-color, #1c1c1e)); }
        .health-orb span, .health-orb small { position: relative; z-index: 1; font-weight: 800; color: var(--primary-text-color); }
        .health-orb span { font-size: 17px; } .health-orb small { font-size: 9px; opacity: .75; }
        .maintenance-verdict { font-size: 15px; font-weight: 800; line-height: 1.1; }
        .head-condition, .maintenance-rows, .maintenance-tip { background: rgba(128,128,128,.10); border-radius: 10px; padding: 9px; }
        .maint-bar-head { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 700; margin-bottom: 6px; }
        .brush-bar-track { height: 7px; background: rgba(128,128,128,.16); border-radius: 4px; overflow: hidden; }
        .brush-bar-fill { height: 100%; border-radius: 4px; transition: width .5s; }
        .maintenance-rows { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
        .maint-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .maint-row span { font-size: 9px; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .45px; }
        .maint-row b { font-size: 12px; color: var(--primary-text-color); }
        .maint-row em { font-style: normal; font-size: 9px; color: var(--secondary-text-color); }
        .maintenance-tip { font-size: 11.5px; line-height: 1.35; color: var(--primary-text-color); }
        .dot { margin: 0 4px; opacity: .5; }

        /* Footer */
        .footer { font-size: 10px; color: var(--secondary-text-color); text-align: right; margin-top: 10px; opacity: .7; }
        .debug { font-size: 9px; margin-top: 10px; background: rgba(0,0,0,.3); border-radius: 6px; padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; color: #aaa; }

        /* Zone bars */
        .zones-card { background: var(--secondary-background-color); border: 1px solid rgba(128,128,128,.16); border-radius: 12px; overflow: hidden; }
        .zones-summary { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 11px 12px; cursor: pointer; list-style: none; font-size: 12.5px; font-weight: 700; }
        .zones-summary::-webkit-details-marker { display: none; }
        .zones-summary::after { content: '›'; color: var(--secondary-text-color); font-size: 18px; transform: rotate(90deg); transition: transform .15s ease; }
        .zones-card[open] .zones-summary::after { transform: rotate(-90deg); }
        .zones-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: rgba(76,175,80,.18); color: #7BE083; font-size: 14px; }
        .zones-quick { margin-left: auto; font-size: 10.5px; color: var(--secondary-text-color); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .zones-body { padding: 0 11px 11px; }
        .zone-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .zone-row.zone-weak .zone-lbl { color: #F44336; font-weight: 700; }
        .zone-lbl { width: 128px; font-size: 11px; flex-shrink: 0; white-space: nowrap; }
        .zone-track { position: relative; flex: 1; height: 7px; background: rgba(128,128,128,.15); border-radius: 4px; }
        .zone-fill { position: absolute; top: 0; left: 0; height: 100%; border-radius: 4px; transition: width .5s ease; max-width: 100%; }
        .zone-avg-mark {
          position: absolute; top: -4px; height: 15px; width: 2px;
          background: rgba(200,200,200,.75); border-radius: 1px;
          transform: translateX(-50%); z-index: 2;
        }
        .zone-num { width: 22px; text-align: right; font-size: 11px; color: var(--primary-text-color); flex-shrink: 0; font-weight: 600; }
        .zone-delta { width: 28px; text-align: right; font-size: 10px; font-weight: 600; flex-shrink: 0; }

        /* Chart tabs */
        .tabs { display: flex; gap: 4px; margin-bottom: 10px; }
        .tab { flex: 1; padding: 5px 6px; font-size: 10px; font-weight: 600; text-transform: uppercase;
          letter-spacing: .4px; background: var(--secondary-background-color); border: none;
          border-radius: 6px; cursor: pointer; color: var(--secondary-text-color);
          transition: background .15s, color .15s; }
        .tab.tab-active { background: #5C7AFF; color: #fff; }
        .tab.tab-active[data-tab="3"] { background: #FF9800; }  /* Duration tab: orange accent */
        .tab:hover:not(.tab-active) { color: var(--primary-text-color); }

        ${c.animations !== false ? `
        /* Motion polish */
        @media (prefers-reduced-motion: no-preference) {
          .card { animation: cardIn .35s cubic-bezier(.2,.8,.2,1) both; }
          .stat { animation: tileIn .38s cubic-bezier(.2,.8,.2,1) both; }
          .stat:nth-child(2) { animation-delay: .03s; } .stat:nth-child(3) { animation-delay: .06s; }
          .stat:nth-child(4) { animation-delay: .09s; } .stat:nth-child(5) { animation-delay: .12s; }
          .assistant-icon { animation: assistantPulse 2.4s ease-in-out infinite; }
          .coach-card[open] .coach-body, .maintenance-card[open] .maintenance-body, .zones-card[open] .zones-body { animation: assistantOpen .22s ease-out both; }
          .balance-orb, .health-orb { animation: balanceGlow 3.2s ease-in-out infinite; }
          .zone-fill, .brush-bar-fill { transform-origin: left center; animation: fillGrow .7s cubic-bezier(.2,.8,.2,1) both; }
          .images svg path { animation: zoneReveal .55s ease-out both; }
          .images svg path.power-tint, .images svg path.power-hatch { animation: none; }
          .week-chart-section svg rect { transform-box: fill-box; transform-origin: bottom; animation: barGrow .55s cubic-bezier(.2,.8,.2,1) both; }
          .week-chart-section svg circle { transform-box: fill-box; transform-origin: center; animation: dotPop .42s cubic-bezier(.2,1.4,.3,1) both; }
          .week-chart-section svg path[stroke] { stroke-dasharray: 520; stroke-dashoffset: 520; animation: drawPath .9s ease-out forwards; }
        }
        @keyframes cardIn { from { opacity: 0; transform: translateY(8px) scale(.99); } to { opacity: 1; transform: none; } }
        @keyframes tileIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes assistantOpen { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
        @keyframes assistantPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(92,122,255,.25); } 50% { box-shadow: 0 0 0 5px rgba(92,122,255,0); } }
        @keyframes balanceGlow { 0%,100% { filter: drop-shadow(0 0 0 rgba(92,122,255,0)); } 50% { filter: drop-shadow(0 0 7px rgba(92,122,255,.28)); } }
        @keyframes fillGrow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
        @keyframes zoneReveal { from { opacity: 0; transform: scale(.96); transform-origin: center; } to { opacity: .95; transform: scale(1); } }
        @keyframes barGrow { from { transform: scaleY(0); opacity: .2; } to { transform: scaleY(1); opacity: 1; } }
        @keyframes dotPop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        @keyframes drawPath { to { stroke-dashoffset: 0; } }
        ` : ''}
      </style>

      <div class="card">
        <div class="header">
          <div class="title">🦷 ${c.title || 'Oclean'}</div>
          <div class="header-right">
            ${battery !== null ? (() => {
              const icon = battery > 90 ? 'mdi:battery'
                : battery > 70 ? 'mdi:battery-80'
                : battery > 50 ? 'mdi:battery-60'
                : battery > 30 ? 'mdi:battery-40'
                : battery > 15 ? 'mdi:battery-20'
                : 'mdi:battery-alert';
              const col = battery <= 15 ? '#F44336' : battery <= 30 ? '#FF9800' : '#4CAF50';
              return `<div class="battery" style="color:${col}"><ha-icon icon="${icon}"></ha-icon>${battery}%</div>`;
            })() : ''}
            ${c.refresh_button ? `<button class="refresh-btn" title="Jetzt aktualisieren"><ha-icon icon="mdi:refresh"></ha-icon></button>` : ''}
          </div>
        </div>
        ${this._relTime(lastTs) ? `<div class="subtitle">Zuletzt geputzt: ${this._relTime(lastTs)}</div>` : ''}

        <div class="stats">${statsHtml}</div>
        ${this._coachSection()}
        <div class="images-section">${this._imagesSection()}</div>

        <hr class="divider"/>
        <div class="week-chart-section">${this._weekChart()}</div>

        ${zonesHtml ? `<hr class="divider"/><div class="zones-section">${zonesHtml}</div>` : ''}
        ${brushHeadHtml ? `<hr class="divider"/>${brushHeadHtml}` : ''}
        ${lastPoll !== null ? `<div class="footer">Letzte Abfrage: ${this._relTime(lastPoll)}</div>` : ''}
        ${c.debug && this._debugHistory ? `<pre class="debug">${JSON.stringify(this._debugHistory, null, 2)}</pre>` : ''}
      </div>
    `;

    // Attach refresh button listener after innerHTML is set
    if (c.refresh_button) {
      const btn = this.shadowRoot.querySelector('.refresh-btn');
      if (btn) btn.addEventListener('click', () => this._pressRefresh());
    }

    // Stat boxes → open HA entity dialog on click
    this.shadowRoot.querySelectorAll('.stat[data-entity]').forEach(el => {
      el.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('hass-more-info', {
          bubbles: true,
          composed: true,
          detail: { entityId: el.dataset.entity },
        }));
      });
    });

    this._wireTabListeners();
    this._wireImageTabListeners();
    this._wireZoneTabListeners();
  }

  // Update only the chart section on tab click — avoids full re-render and page-scroll.
  _wireTabListeners() {
    const section = this.shadowRoot.querySelector('.week-chart-section');
    if (!section) return;
    section.querySelectorAll('.tab[data-tab]').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        this._activeTab = parseInt(tab.dataset.tab, 10);
        section.innerHTML = this._weekChart();
        this._wireTabListeners();
      });
    });
  }

  _wireImageTabListeners() {
    const section = this.shadowRoot.querySelector('.images-section');
    if (!section) return;
    section.querySelectorAll('.tab[data-image-tab]').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        this._imageTab = parseInt(tab.dataset.imageTab, 10);
        section.innerHTML = this._imagesSection();
        this._wireImageTabListeners();
      });
    });
  }

  // ── Zone bars section ─────────────────────────────────────────────────────────

  _zonesSection() {
    const c        = this._config;
    if (!this._hass || !c) return '';
    const weakZone = this._str(c.weak_zone);
    const zoneData = this._zoneData(c.weak_zone);
    if (!zoneData) return '';

    const curZones = c.current_zones ? this._currentZones(c.current_zones) : null;

    // Legend: bar = last session, marker = historical avg (always visible when curZones present)
    let legend = '';
    if (curZones) {
      legend = `<div class="zone-legend-line">
        <span class="zleg-bar">█</span> Letzte Sitzung
        &nbsp;·&nbsp; ${zoneData.sessions} Sitzungen
      </div>`;
    } else {
      legend = `<div class="zone-legend-line">
        Balken = Ø aus <b>${zoneData.sessions} Sitzungen</b>
        <span style="opacity:.6"> (keine aktuellen Daten)</span>
      </div>`;
    }

    // Normalise raw gestureArray values (0-35 scale) to 0-100 for colour bands.
    const normAvg = this._normalizeZones(zoneData.zones);
    const normCur = this._normalizeZones(curZones);

    const rows = Object.entries(normAvg).map(([key, avg]) => {
      const cur = normCur
        ? (normCur[key] !== undefined ? normCur[key] : null)
        : null;
      return this._zoneRow(key, avg, cur, key === weakZone);
    }).join('');

    const weakLabel = weakZone ? this._zoneLabel(weakZone) : '–';
    return `
      <details class="zones-card">
        <summary class="zones-summary">
          <span class="assistant-title"><span class="zones-icon">◌</span> Zonen</span>
          <span class="zones-quick">${zoneData.sessions} Sitzungen · Fokus ${weakLabel}</span>
        </summary>
        <div class="zones-body">
          ${legend}
          ${rows}
        </div>
      </details>`;
  }

  _wireZoneTabListeners() {
    const section = this.shadowRoot.querySelector('.zones-section');
    if (!section) return;
    section.querySelectorAll('.tab[data-zone-tab]').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        this._zoneTab = parseInt(tab.dataset.zoneTab, 10);
        section.innerHTML = this._zonesSection();
        this._wireZoneTabListeners();
      });
    });
  }

  getCardSize() { return 9; }

  static getStubConfig() {
    return {
      title: 'Oclean', battery: '', last_brush: '', last_poll: '',
      score: '', coverage: '', pressure: '', overpressure: '',
      duration: '',
      weak_zone: '', current_zones: '',
      brush_head_days: '', brush_head_usage: '', brush_head_wear: '',
      refresh_button: '', brush_image: '', heatmap_image: '', power_zones: '',
      animations: true,
    };
  }
}

customElements.define('oclean-card', OcleanCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'oclean-card',
  name: 'Oclean Card',
  description: 'Übersichtskarte für Oclean BLE Zahnbürste',
  preview: false,
});
