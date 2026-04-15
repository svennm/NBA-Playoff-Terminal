// Theme switcher — persists in localStorage
(function() {
  const THEMES = {
    default: { name: 'Default', vars: {} },
    bright: {
      name: 'Bright',
      vars: {
        '--bg': '#050a10',
        '--panel': '#0c1220',
        '--border': '#2a3a5a',
        '--border-glow': '#1a6a9f',
        '--cyan': '#00ffff',
        '--green': '#00ff99',
        '--amber': '#ffd000',
        '--red': '#ff4444',
        '--magenta': '#ff44ff',
        '--text': '#e8eef5',
        '--dim': '#7a8aa8',
        '--blue': '#44aaff',
        '--purple': '#bb77ff',
      }
    },
    neon: {
      name: 'Neon',
      vars: {
        '--bg': '#000008',
        '--panel': '#080818',
        '--border': '#1a1a4a',
        '--border-glow': '#3333aa',
        '--cyan': '#00ffff',
        '--green': '#39ff14',
        '--amber': '#ffee00',
        '--red': '#ff2222',
        '--magenta': '#ff00ff',
        '--text': '#f0f0ff',
        '--dim': '#8888cc',
        '--blue': '#4488ff',
        '--purple': '#cc55ff',
      }
    },
    gold: {
      name: 'Gold',
      vars: {
        '--bg': '#080604',
        '--panel': '#12100a',
        '--border': '#3a2a1a',
        '--border-glow': '#6a4a1f',
        '--cyan': '#f5d442',
        '--green': '#44dd88',
        '--amber': '#ffcc00',
        '--red': '#ff5533',
        '--magenta': '#ff66aa',
        '--text': '#e8dcc8',
        '--dim': '#8a7a5a',
        '--blue': '#55aadd',
        '--purple': '#cc88dd',
      }
    },
    light: {
      name: 'Light',
      vars: {
        '--bg': '#f0f2f5',
        '--panel': '#ffffff',
        '--border': '#d0d5dd',
        '--border-glow': '#a0a8b8',
        '--cyan': '#0088cc',
        '--green': '#00aa55',
        '--amber': '#cc8800',
        '--red': '#cc2222',
        '--magenta': '#aa22aa',
        '--text': '#1a1a2e',
        '--dim': '#6a7080',
        '--blue': '#2266bb',
        '--purple': '#7744aa',
      }
    }
  };

  function applyTheme(name) {
    const theme = THEMES[name] || THEMES.default;
    const root = document.documentElement;
    // Reset to defaults first
    for (const key of Object.keys(THEMES.bright.vars)) {
      root.style.removeProperty(key);
    }
    // Apply theme vars
    for (const [key, val] of Object.entries(theme.vars)) {
      root.style.setProperty(key, val);
    }
    localStorage.setItem('hxm_theme', name);
    // Update button states
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.style.borderColor = b.dataset.theme === name ? 'var(--cyan)' : 'var(--border)';
      b.style.opacity = b.dataset.theme === name ? '1' : '0.5';
    });
  }

  // Create theme toggle widget
  function createToggle() {
    const btn = document.createElement('div');
    btn.id = 'theme-toggle';
    btn.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:9998;display:flex;gap:3px;';
    btn.innerHTML = Object.entries(THEMES).map(([key, t]) => {
      const colors = key === 'default' ? '#00e5ff' : key === 'bright' ? '#00ffff' : key === 'neon' ? '#39ff14' : key === 'gold' ? '#f5d442' : '#0088cc';
      return `<div class="theme-btn" data-theme="${key}" onclick="window._setTheme('${key}')" style="width:18px;height:18px;border-radius:50%;background:${colors};border:2px solid var(--border);cursor:pointer;opacity:0.5;transition:all .2s;" title="${t.name}"></div>`;
    }).join('');
    document.body.appendChild(btn);
  }

  window._setTheme = applyTheme;

  // Apply saved theme on load
  const saved = localStorage.getItem('hxm_theme') || 'default';
  if (saved !== 'default') applyTheme(saved);

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { createToggle(); applyTheme(saved); });
  } else {
    createToggle();
    applyTheme(saved);
  }
})();
