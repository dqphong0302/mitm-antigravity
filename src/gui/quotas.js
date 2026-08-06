const fs = require("fs"); // Wait, require("fs") is correct, but let's make sure it is exactly correct.
const path = require("path");
const os = require("os");

const WINDOW_LABELS = {
  short: "Chu kỳ ~5 giờ",
  day: "Chu kỳ theo ngày",
  week: "Chu kỳ theo tuần",
  other: "Chu kỳ khác",
};

function classifyWindow(resetIso, lastUpdated) {
  try {
    const reset = new Date(resetIso);
    if (isNaN(reset.getTime())) return ["other", null];
    const base = lastUpdated ? new Date(lastUpdated * 1000) : new Date();
    const hours = (reset - base) / (3600 * 1000);
    if (hours <= 8) return ["short", hours];
    if (hours <= 48) return ["day", hours];
    return ["week", hours];
  } catch (error) {
    return ["other", null];
  }
}

function loadAccounts(dataDir) {
  let indexOrder = [];
  let currentId = null;
  const labels = {};

  const idxPath = path.join(dataDir, "accounts.json");
  if (fs.existsSync(idxPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
      currentId = idx.current_account_id;
      if (Array.isArray(idx.accounts)) {
        for (const a of idx.accounts) {
          if (a.id) {
            indexOrder.push(a.id);
            if (a.custom_label) {
              labels[a.id] = a.custom_label;
            }
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  const accounts = [];
  const accountsDir = path.join(dataDir, "accounts");
  let scanDir = dataDir;

  if (fs.existsSync(accountsDir) && fs.statSync(accountsDir).isDirectory()) {
    scanDir = accountsDir;
  }

  if (fs.existsSync(scanDir)) {
    const files = fs.readdirSync(scanDir);
    for (const fn of files) {
      if (!fn.endsWith(".json") || fn === "accounts.json" || fn === "gui_config.json" || fn === "device_original.json" || fn === "update_settings.json" || fn === "warmup_history.json") {
        continue;
      }
      const filePath = path.join(scanDir, fn);
      try {
        const obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!obj || typeof obj !== "object" || !obj.email) continue;
        if (!obj.quota && !obj.token) continue;

        const quota = obj.quota || {};
        const lastUpdated = quota.last_updated;
        const modelsIn = quota.models || [];

        const windows = {};
        for (const m of modelsIn) {
          const resetIso = m.reset_time;
          const [key, hours] = resetIso ? classifyWindow(resetIso, lastUpdated) : ["other", null];

          let pct = null;
          if (m.percentage !== undefined && m.percentage !== null) {
            pct = parseFloat(m.percentage);
            if (isNaN(pct)) pct = null;
          }

          const entry = {
            name: m.name,
            display_name: m.display_name || m.name,
            percentage: pct,
            reset_time: resetIso,
            recommended: !!m.recommended,
            supports_thinking: !!m.supports_thinking,
            supports_images: !!m.supports_images,
          };
          if (!windows[key]) windows[key] = [];
          windows[key].push(entry);
        }

        const allPct = [];
        for (const key in windows) {
          for (const m of windows[key]) {
            if (m.percentage !== null) allPct.push(m.percentage);
          }
        }

        const avg = allPct.length > 0 ? parseFloat((allPct.reduce((a, b) => a + b, 0) / allPct.length).toFixed(1)) : null;
        const lowest = allPct.length > 0 ? parseFloat(Math.min(...allPct).toFixed(1)) : null;

        const quotaGroups = (quota.quota_groups || []).map(g => ({
          display_name: g.display_name,
          description: g.description,
          buckets: (g.buckets || []).map(b => ({
            bucket_id: b.bucket_id,
            window: b.window,
            percentage: b.remaining_fraction !== undefined && b.remaining_fraction !== null ? parseFloat((b.remaining_fraction * 100).toFixed(1)) : null,
            reset_time: b.reset_time,
            display_name: b.display_name,
            description: b.description,
          }))
        }));

        accounts.push({
          id: obj.id,
          email: obj.email,
          name: labels[obj.id] || obj.custom_label || obj.name || "",
          subscription_tier: quota.subscription_tier,
          is_forbidden: !!quota.is_forbidden,
          forbidden_reason: quota.forbidden_reason,
          disabled: !!obj.disabled,
          validation_blocked: !!obj.validation_blocked,
          last_updated: lastUpdated,
          windows,
          quota_groups: quotaGroups,
          avg,
          lowest,
          model_count: modelsIn.length,
          is_current: obj.id === currentId,
        });
      } catch (e) {
        // ignore
      }
    }
  }

  const orderMap = {};
  indexOrder.forEach((aid, idx) => {
    orderMap[aid] = idx;
  });

  accounts.sort((a, b) => {
    const oA = orderMap[a.id] !== undefined ? orderMap[a.id] : 10000;
    const oB = orderMap[b.id] !== undefined ? orderMap[b.id] : 10000;
    if (oA !== oB) return oA - oB;
    return (a.email || "").localeCompare(b.email || "");
  });

  const hasWeek = accounts.some(a => 
    ("week" in a.windows) || 
    (a.quota_groups && a.quota_groups.some(g => g.buckets && g.buckets.some(b => b.window === "weekly")))
  );
  return {
    data_dir: dataDir,
    generated_at: new Date().toISOString(),
    accounts,
    has_week: hasWeek,
    window_labels: WINDOW_LABELS,
  };
}

module.exports = {
  loadAccounts,
  classifyWindow,
};
