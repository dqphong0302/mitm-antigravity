function guiStyles() {
  return `
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --surface: #ffffff;
      --surface-soft: #eef2f7;
      --text: #17202a;
      --muted: #637083;
      --border: #d8dee8;
      --accent: #0f766e;
      --accent-strong: #0b5f59;
      --accent-soft: #d9f2ef;
      --accent-border: #8bcac2;
      --danger: #b42318;
      --danger-soft: #fce8e6;
      --danger-border: #e5a7a0;
      --ok: #167d3b;
      --ok-soft: #dcf4e5;
      --ok-border: #9dd7ae;
      --warn: #a15c00;
      --warn-soft: #fff1d6;
      --warn-border: #ebc16f;
      --placeholder: #98a3b3;
      --shadow: 0 14px 32px rgba(20, 31, 43, 0.08);
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #161719;
      --surface: #202225;
      --surface-soft: #2a2d31;
      --text: #f2f4f7;
      --muted: #a2abb8;
      --border: #3a3f46;
      --accent: #2dd4bf;
      --accent-strong: #5eead4;
      --accent-soft: rgba(45, 212, 191, 0.12);
      --accent-border: rgba(45, 212, 191, 0.35);
      --danger: #fb7185;
      --danger-soft: rgba(251, 113, 133, 0.12);
      --danger-border: rgba(251, 113, 133, 0.35);
      --ok: #4ade80;
      --ok-soft: rgba(74, 222, 128, 0.12);
      --ok-border: rgba(74, 222, 128, 0.35);
      --warn: #fbbf24;
      --warn-soft: rgba(251, 191, 36, 0.12);
      --warn-border: rgba(251, 191, 36, 0.35);
      --placeholder: #7e8998;
      --shadow: 0 18px 38px rgba(0, 0, 0, 0.28);
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      letter-spacing: 0;
    }
    button, input, select { font: inherit; }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 38px;
      padding: 8px 14px;
      border: 1px solid var(--accent);
      border-radius: 8px;
      background: var(--accent);
      color: #fff;
      font-weight: 650;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button.secondary { color: var(--text); background: var(--surface); border-color: var(--border); }
    button.secondary:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); }
    button.danger { color: var(--danger); background: var(--surface); border-color: var(--danger-border); }
    button.danger:hover:not(:disabled) { background: var(--danger-soft); }
    input, select {
      width: 100%;
      min-height: 38px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      outline: none;
    }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    input::placeholder { color: var(--placeholder); }
    label { display: flex; flex-direction: column; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 650; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      padding: 9px 10px;
      text-align: left;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      text-transform: uppercase;
    }
    td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:last-child td { border-bottom: 0; }
    .app-shell { min-height: 100vh; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: grid;
      grid-template-columns: minmax(260px, 1fr) auto;
      gap: 18px;
      align-items: center;
      padding: 12px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(12px);
    }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: var(--surface-soft);
      color: var(--accent-strong);
      border: 1px solid var(--accent-border);
      font-size: 16px;
      font-weight: 750;
      letter-spacing: -0.04em;
    }
    .brand h1 { margin: 0; font-size: 18px; line-height: 1.15; }
    .brand p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
    .top-actions { display: flex; align-items: end; gap: 10px; }
    .top-actions label { min-width: 126px; }
    .path-line {
      grid-column: 1 / -1;
      min-width: 0;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .layout { width: min(1180px, calc(100vw - 28px)); margin: 14px auto 36px; }
    .tabs {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 16px;
    }
    .tab-btn {
      min-height: 40px;
      font-size: 13px;
      padding: 6px 4px;
      color: var(--muted);
      background: var(--surface);
      border-color: var(--border);
    }
    .tab-btn.active { color: #fff; background: var(--accent); border-color: var(--accent); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .panel + .panel { margin-top: 14px; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .panel-title { margin: 0; font-size: 15px; font-weight: 750; }
    .panel-subtitle { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .dashboard-grid { display: grid; grid-template-columns: minmax(250px, .72fr) minmax(0, 1.28fr); gap: 12px; align-items: start; }
    .command-stack { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
    .command-stack.single { grid-template-columns: 1fr; }
    #proxyToggleBtn { min-height: 48px; font-size: 15px; letter-spacing: .08em; }
    #proxyToggleBtn.ready { box-shadow: 0 10px 22px rgba(15, 118, 110, 0.18); }
    .system-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .guide-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .guide-card {
      position: relative;
      min-height: 188px;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: linear-gradient(145deg, var(--surface), var(--surface-soft));
      overflow: hidden;
    }
    .guide-card::after {
      content: "";
      position: absolute;
      inset: auto -24px -42px auto;
      width: 116px;
      height: 116px;
      border-radius: 50%;
      background: var(--accent-soft);
    }
    .guide-card.cleanup { border-color: var(--danger-border); }
    .guide-card.cleanup::after { background: var(--danger-soft); }
    .step-badge {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      margin-bottom: 16px;
      border-radius: 50%;
      color: #fff;
      background: var(--accent);
      font-weight: 800;
    }
    .guide-card.cleanup .step-badge { background: var(--danger); }
    .guide-card h3 { position: relative; margin: 0 0 8px; font-size: 15px; }
    .guide-card p { position: relative; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 9px; }
    .metric {
      min-height: 74px;
      padding: 11px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .metric-label { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 8px; }
    .metric-value { color: var(--muted); font-family: var(--mono); font-size: 13px; line-height: 1.35; word-break: break-word; }
    .metric-value.ok { color: var(--ok); }
    .metric-value.err { color: var(--danger); }
    .metric-value.warn { color: var(--warn); }
    .metric-value.neutral { color: var(--muted); }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .full { grid-column: 1 / -1; }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .input-wrap { position: relative; }
    .input-wrap input { padding-right: 72px; }
    .input-wrap button {
      position: absolute;
      right: 5px;
      top: 5px;
      min-height: 28px;
      padding: 3px 9px;
      font-size: 12px;
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 0;
      color: var(--text);
      font-size: 13px;
      font-weight: 550;
    }
    input[type="checkbox"] { width: 16px; min-height: 16px; accent-color: var(--accent); }
    .status {
      display: none;
      align-items: center;
      gap: 8px;
      min-height: 38px;
      margin-top: 12px;
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface-soft);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .status.loading { display: flex; color: var(--muted); }
    .status.ok { display: flex; color: var(--ok); background: var(--ok-soft); border-color: var(--ok-border); }
    .status.err { display: flex; color: var(--danger); background: var(--danger-soft); border-color: var(--danger-border); }
    .status.warn { display: flex; color: var(--warn); background: var(--warn-soft); border-color: var(--warn-border); }
    .alias-cell { width: 28%; color: var(--accent-strong); font-family: var(--mono); font-size: 12px; }
    .arrow-cell { width: 34px; color: var(--muted); text-align: center; }
    .model-cell { min-width: 280px; }
    .reasoning-cell { width: 170px; }
    .mapping-state { width: 108px; }
    .tag {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      padding: 3px 8px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 750;
    }
    .tag.ok { color: var(--ok); background: var(--ok-soft); }
    .tag.warn { color: var(--warn); background: var(--warn-soft); }
    .tag.danger { color: var(--danger); background: var(--danger-soft); }
    .tag.neutral { color: var(--muted); background: var(--surface-soft); }
    .doctor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-top: 12px; }
    .doctor-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 64px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-soft);
    }
    .doctor-card-title { color: var(--text); font-size: 13px; font-weight: 700; }
    .recommendation-box {
      margin-top: 14px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-soft);
    }
    .recommendation-box ul { margin: 8px 0 0 18px; padding: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .recommendation-box li + li { margin-top: 4px; }
    .log-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .log-toolbar label { min-width: 150px; }
    .log-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .log-block { min-width: 0; }
    .log-title { color: var(--muted); font-size: 11px; font-weight: 750; text-transform: uppercase; margin-bottom: 6px; }
    .log-path { min-height: 28px; color: var(--accent-strong); font-family: var(--mono); font-size: 11px; word-break: break-all; margin-bottom: 8px; }
    .log-output {
      width: 100%;
      min-height: 180px;
      max-height: 320px;
      overflow: auto;
      margin: 0;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-soft);
      color: var(--text);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .log-output.empty { color: var(--muted); }
    .path-grid { display: grid; gap: 10px; }
    .path-item {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-soft);
    }
    .path-label { color: var(--muted); font-size: 12px; font-weight: 700; }
    .path-value { font-family: var(--mono); font-size: 12px; word-break: break-all; }
    @media (max-width: 1080px) {
      .topbar { grid-template-columns: 1fr; gap: 10px; }
      .top-actions { justify-content: stretch; }
      .top-actions label { flex: 1; min-width: 0; }
      .dashboard-grid { grid-template-columns: 1fr; }
      .metric-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    }
    @media (max-width: 860px) {
      .topbar { grid-template-columns: 1fr; }
      .top-actions { justify-content: stretch; }
      .top-actions label { flex: 1; min-width: 0; }
      .tabs { grid-template-columns: 1fr 1fr; }
      .dashboard-grid, .form-grid, .log-grid, .guide-grid { grid-template-columns: 1fr; }
      .command-stack { grid-template-columns: 1fr; }
      .layout { width: min(100vw - 20px, 1240px); margin-top: 10px; }
      .path-item { grid-template-columns: 1fr; gap: 4px; }
      table { min-width: 680px; }
      .table-scroll { overflow-x: auto; }
    }
  `;
}

module.exports = {
  guiStyles,
};
