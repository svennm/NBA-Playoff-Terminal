// Shared navigation — injected into all pages
// Replaces inline nav-links with clean dropdown menus
(function() {
  const NAV = {
    nba: { label: 'NBA', color: '#ffb300', links: [
      { href: '/terminal.html', text: 'Scores' },
      { href: '/matchup.html', text: 'Matchup' },
      { href: '/bracket.html', text: 'Bracket' },
      { href: '/playoffs.html', text: 'Playoffs' },
    ]},
    ucl: { label: 'UCL', color: '#1a73e8', links: [
      { href: '/soccer.html', text: 'Scores' },
      { href: '/matchup.html?sport=soccer', text: 'Matchup' },
    ]},
    prem: { label: 'PREM', color: '#6C2DC7', links: [
      { href: '/prem.html', text: 'Scores' },
      { href: '/matchup.html?sport=prem', text: 'Matchup' },
    ]},
    europa: { label: 'UEL', color: '#f57c00', links: [
      { href: '/europa.html', text: 'Scores' },
      { href: '/matchup.html?sport=europa', text: 'Matchup' },
    ]},
    tools: { label: 'TOOLS', color: '#4a5568', links: [
      { href: '/slips.html', text: 'Slips' },
      { href: '/analysis.html', text: 'Analysis' },
      { href: '/principles.html', text: 'Principles' },
      { href: '/guide.html', text: 'Guide' },
    ]}
  };

  function createNav() {
    // Find existing nav-links container (NOT header-right — terminal uses that for status elements)
    const existing = document.querySelector('.nav-links');
    if (!existing) return;

    // Determine current page for active highlighting
    const path = window.location.pathname;
    const search = window.location.search;

    // Build new nav HTML
    let html = '<a href="/" class="nav-link home-link">Home</a>';

    for (const [key, group] of Object.entries(NAV)) {
      const isActive = group.links.some(l => {
        if (l.href.includes('?')) return path + search === l.href;
        return path === l.href;
      });

      html += `
        <div class="nav-dropdown ${isActive ? 'active-group' : ''}">
          <button class="nav-drop-btn" style="color:${group.color};" onclick="this.parentElement.classList.toggle('open')">${group.label}</button>
          <div class="nav-drop-menu">
            ${group.links.map(l => {
              const active = (l.href.includes('?') ? path + search === l.href : path === l.href) ? ' active-link' : '';
              return `<a href="${l.href}" class="nav-drop-item${active}">${l.text}</a>`;
            }).join('')}
          </div>
        </div>`;
    }

    existing.innerHTML = html;
    existing.classList.add('hxm-nav');

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nav-dropdown')) {
        document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
      }
    });
  }

  // Add styles
  function addStyles() {
    if (document.getElementById('hxm-nav-styles')) return;
    const s = document.createElement('style');
    s.id = 'hxm-nav-styles';
    s.textContent = `
      .hxm-nav { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
      .nav-link, .nav-drop-btn {
        color: var(--dim); text-decoration: none; font-size: 10px;
        font-family: 'Orbitron', sans-serif; letter-spacing: 1px;
        text-transform: uppercase; padding: 5px 10px;
        border: 1px solid var(--border); border-radius: 3px;
        transition: all .15s; cursor: pointer; background: none;
      }
      .nav-link:hover, .nav-drop-btn:hover { border-color: var(--border-glow); background: rgba(255,255,255,0.03); }
      .home-link:hover { color: var(--gold); border-color: var(--gold); }

      .nav-dropdown { position: relative; }
      .nav-dropdown.active-group > .nav-drop-btn { border-color: var(--border-glow); background: rgba(255,255,255,0.03); }
      .nav-drop-menu {
        display: none; position: absolute; top: 100%; left: 0;
        background: var(--bg); border: 1px solid var(--border-glow);
        border-radius: 4px; padding: 4px; min-width: 120px;
        z-index: 200; margin-top: 2px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      }
      .nav-dropdown.open > .nav-drop-menu { display: block; }
      .nav-drop-item {
        display: block; padding: 6px 10px; color: var(--dim);
        text-decoration: none; font-size: 10px; font-family: 'JetBrains Mono', monospace;
        border-radius: 3px; transition: all .1s; white-space: nowrap;
      }
      .nav-drop-item:hover { color: var(--text); background: rgba(255,255,255,0.05); }
      .nav-drop-item.active-link { color: var(--cyan); font-weight: 600; }

      /* Mobile: flatten into full-width menu */
      @media (max-width: 768px) {
        .hxm-nav.open { display: flex !important; }
        .hxm-nav { display: none; position: absolute; top: 100%; left: 0; right: 0;
          background: var(--bg); border-bottom: 2px solid var(--border-glow);
          padding: 10px 16px; flex-direction: column; gap: 6px; z-index: 99;
          box-shadow: 0 8px 24px rgba(0,0,0,0.6); }
        .nav-link, .nav-drop-btn { width: 100%; text-align: center; }
        .nav-dropdown { width: 100%; }
        .nav-drop-menu { position: static; box-shadow: none; border: none;
          background: rgba(255,255,255,0.02); margin-top: 2px; }
        .nav-dropdown.open > .nav-drop-menu { display: block; }
        .nav-drop-item { text-align: center; padding: 8px 10px; }
      }
    `;
    document.head.appendChild(s);
  }

  // Init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { addStyles(); createNav(); });
  } else {
    addStyles();
    createNav();
  }
})();
