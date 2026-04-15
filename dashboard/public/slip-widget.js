// Floating slip widget — persists across pages via localStorage
(function() {
  const STORAGE_KEY = 'hxm_slip_legs';

  function getLegs() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  }
  function saveLegs(legs) { localStorage.setItem(STORAGE_KEY, JSON.stringify(legs)); }

  function americanToDecimal(am) { return am > 0 ? (am/100)+1 : (100/Math.abs(am))+1; }
  function americanToImplied(am) { return am < 0 ? Math.abs(am)/(Math.abs(am)+100)*100 : 100/(am+100)*100; }

  // Add a leg from any page
  window.addToSlip = function(legData) {
    const legs = getLegs();
    const key = `${legData.player}-${legData.stat}-${legData.pick}`;
    if (legs.find(l => `${l.player}-${l.stat}-${l.pick}` === key)) return; // already added
    legs.push(legData);
    saveLegs(legs);
    renderWidget();
  };

  window.removeFromSlip = function(idx) {
    const legs = getLegs();
    legs.splice(idx, 1);
    saveLegs(legs);
    renderWidget();
  };

  window.clearSlip = function() {
    saveLegs([]);
    renderWidget();
  };

  window.getSlipLegs = function() { return getLegs(); };

  function renderWidget() {
    let w = document.getElementById('slip-widget');
    const legs = getLegs();

    if (!legs.length) {
      if (w) w.style.display = 'none';
      return;
    }

    if (!w) {
      w = document.createElement('div');
      w.id = 'slip-widget';
      w.style.cssText = 'position:fixed;bottom:12px;right:12px;width:300px;max-height:400px;background:#0a0e14;border:1px solid #0f4f6f;border-radius:8px;z-index:9998;font-family:"JetBrains Mono",monospace;font-size:11px;color:#c8d6e5;box-shadow:0 4px 20px rgba(0,0,0,0.5);overflow:hidden;';
      document.body.appendChild(w);
    }
    w.style.display = '';

    let dec = 1;
    let impl = 1;
    for (const l of legs) {
      dec *= americanToDecimal(l.odds);
      impl *= americanToImplied(l.odds) / 100;
    }
    const american = dec >= 2 ? `+${Math.round((dec-1)*100)}` : `-${Math.round(100/(dec-1))}`;
    const parlayPct = (impl * 100).toFixed(1);

    w.innerHTML = `
      <div style="padding:8px 10px;background:rgba(0,229,255,0.08);border-bottom:1px solid #1a2a3a;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-family:'Orbitron',sans-serif;font-size:9px;font-weight:700;color:#00e5ff;letter-spacing:2px;">MY SLIP (${legs.length})</span>
        <div style="display:flex;gap:6px;">
          <span style="color:#ffb300;font-weight:700;">${american}</span>
          <span style="color:#9b59b6;font-size:9px;">${parlayPct}%</span>
        </div>
      </div>
      <div style="max-height:250px;overflow-y:auto;padding:6px 10px;">
        ${legs.map((l, i) => `
          <div style="display:flex;align-items:center;gap:4px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:10px;">
            <span onclick="removeFromSlip(${i})" style="color:#ff3d3d;cursor:pointer;font-size:12px;">&times;</span>
            <div style="flex:1;overflow:hidden;">
              <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${l.player}</div>
              <div style="color:#4a5568;font-size:9px;">${l.stat} ${l.pick}</div>
            </div>
            <span style="color:#ffb300;font-size:9px;">${l.odds > 0 ? '+' : ''}${l.odds}</span>
          </div>`).join('')}
      </div>
      <div style="padding:6px 10px;border-top:1px solid #1a2a3a;display:flex;gap:6px;">
        <a href="/slips.html" style="flex:1;text-align:center;padding:6px;background:rgba(0,255,136,0.15);color:#00ff88;border:1px solid #00ff88;border-radius:4px;text-decoration:none;font-family:'Orbitron',sans-serif;font-size:9px;letter-spacing:1px;">GO TO SLIPS</a>
        <button onclick="clearSlip()" style="padding:6px 10px;background:none;color:#ff3d3d;border:1px solid #1a2a3a;border-radius:4px;cursor:pointer;font-size:9px;font-family:'JetBrains Mono',monospace;">CLEAR</button>
      </div>`;
  }

  // Render on load
  renderWidget();
})();
