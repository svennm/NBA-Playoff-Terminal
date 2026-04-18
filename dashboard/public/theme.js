// Theme + display settings — persists in localStorage, applies on every page
(function() {
  const THEMES = {
    default: { name: 'Default', vars: {} },
    bright: {
      name: 'Bright',
      vars: {
        '--bg': '#050a10', '--panel': '#0c1220', '--border': '#2a3a5a',
        '--border-glow': '#1a6a9f', '--cyan': '#00ffff', '--green': '#00ff99',
        '--amber': '#ffd000', '--red': '#ff4444', '--magenta': '#ff44ff',
        '--text': '#e8eef5', '--dim': '#7a8aa8', '--blue': '#44aaff', '--purple': '#bb77ff',
      }
    },
    neon: {
      name: 'Neon',
      vars: {
        '--bg': '#000008', '--panel': '#080818', '--border': '#1a1a4a',
        '--border-glow': '#3333aa', '--cyan': '#00ffff', '--green': '#39ff14',
        '--amber': '#ffee00', '--red': '#ff2222', '--magenta': '#ff00ff',
        '--text': '#f0f0ff', '--dim': '#8888cc', '--blue': '#4488ff', '--purple': '#cc55ff',
      }
    },
    gold: {
      name: 'Gold',
      vars: {
        '--bg': '#080604', '--panel': '#12100a', '--border': '#3a2a1a',
        '--border-glow': '#6a4a1f', '--cyan': '#f5d442', '--green': '#44dd88',
        '--amber': '#ffcc00', '--red': '#ff5533', '--magenta': '#ff66aa',
        '--text': '#e8dcc8', '--dim': '#8a7a5a', '--blue': '#55aadd', '--purple': '#cc88dd',
      }
    },
    light: {
      name: 'Light',
      vars: {
        '--bg': '#f0f2f5', '--panel': '#ffffff', '--border': '#d0d5dd',
        '--border-glow': '#a0a8b8', '--cyan': '#0088cc', '--green': '#00aa55',
        '--amber': '#cc8800', '--red': '#cc2222', '--magenta': '#aa22aa',
        '--text': '#1a1a2e', '--dim': '#6a7080', '--blue': '#2266bb', '--purple': '#7744aa',
      }
    }
  };

  function applyTheme(name) {
    const theme = THEMES[name] || THEMES.default;
    const root = document.documentElement;
    for (const key of Object.keys(THEMES.bright.vars)) root.style.removeProperty(key);
    for (const [key, val] of Object.entries(theme.vars)) root.style.setProperty(key, val);
    localStorage.setItem('hxm_theme', name);
    // After theme applies, re-apply dim brightness override (user setting takes priority)
    applyDimBrightness();
    // Update button states
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.style.borderColor = b.dataset.theme === name ? 'var(--cyan)' : 'var(--border)';
      b.style.opacity = b.dataset.theme === name ? '1' : '0.5';
    });
  }

  // Dim text brightness — overrides --dim from theme
  function applyDimBrightness() {
    const val = parseInt(localStorage.getItem('hxm_dimBrightness') || '0');
    if (val > 0) {
      const hex = Math.round(val * 2.55).toString(16).padStart(2, '0');
      document.documentElement.style.setProperty('--dim', `#${hex}${hex}${hex}`);
    }
  }

  // Font size
  function applyFontSize() {
    const size = localStorage.getItem('hxm_fontSize');
    if (size) {
      document.documentElement.style.setProperty('--user-font-size', size + 'px');
      document.body.style.fontSize = size + 'px';
    }
  }

  // Scanlines
  function applyScanlines() {
    if (localStorage.getItem('hxm_scanlines') === 'off') {
      document.body.classList.add('no-scanlines');
    }
  }

  // Create theme toggle widget (small dots, bottom-left)
  function createToggle() {
    const btn = document.createElement('div');
    btn.id = 'theme-toggle';
    btn.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:9998;display:flex;gap:3px;';
    const colors = { default:'#00e5ff', bright:'#00ffff', neon:'#39ff14', gold:'#f5d442', light:'#0088cc' };
    btn.innerHTML = Object.entries(THEMES).map(([key, t]) =>
      `<div class="theme-btn" data-theme="${key}" onclick="window._setTheme('${key}')" style="width:18px;height:18px;border-radius:50%;background:${colors[key]};border:2px solid var(--border);cursor:pointer;opacity:0.5;transition:all .2s;" title="${t.name}"></div>`
    ).join('');
    document.body.appendChild(btn);
  }

  // Add no-scanlines style
  function addStyles() {
    const s = document.createElement('style');
    s.textContent = '.no-scanlines::after{display:none!important;}';
    document.head.appendChild(s);
  }

  window._setTheme = applyTheme;

  // Apply all saved settings on load
  const saved = localStorage.getItem('hxm_theme') || 'default';
  if (saved !== 'default') applyTheme(saved);
  applyDimBrightness();
  applyFontSize();
  addStyles();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { createToggle(); applyTheme(saved); applyScanlines(); });
  } else {
    createToggle();
    applyTheme(saved);
    applyScanlines();
  }
})();
