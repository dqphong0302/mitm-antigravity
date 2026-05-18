function createGuiRoutes(handlers) {
    return [
        ["GET", "/api/bootstrap", handlers.handleBootstrap],
        ["GET", "/api/logs", handlers.handleLogs],
        ["PUT", "/api/config", handlers.handleSaveConfig],
        ["GET", "/api/config/export", handlers.handleExportConfig],
        ["POST", "/api/config/import", handlers.handleImportConfig],
        ["POST", "/api/check-key", handlers.handleCheckKey],
        ["POST", "/api/start-proxy", handlers.handleStartProxy],
        ["POST", "/api/start-proxy-only", handlers.handleStartProxyOnly],
        ["POST", "/api/stop-proxy", handlers.handleStopProxy],
        ["POST", "/api/stop-and-cleanup", handlers.handleStopAndCleanup],
        ["POST", "/api/reload-proxy", handlers.handleReloadProxy],
        ["POST", "/api/force-kill-port", handlers.handleForceKillPort],
        ["POST", "/api/apply-dns", handlers.handleApplyDns],
        ["POST", "/api/apply-app-trust", handlers.handleApplyAppTrust],
        ["POST", "/api/remove-dns", handlers.handleRemoveDns],
        ["POST", "/api/uninstall-cert", handlers.handleUninstallCert],
        ["GET", "/api/doctor", handlers.handleDoctor],
        ["GET", "/api/autostart", handlers.handleAutoStartStatus],
        ["POST", "/api/autostart/enable", handlers.handleEnableAutoStart],
        ["POST", "/api/autostart/disable", handlers.handleDisableAutoStart],
        ["GET", "/api/status", handlers.handleStatus],
        ["GET", "/api/events", handlers.handleEvents],
        ["POST", "/api/logs/clear", handlers.handleClearLogs],
    ].map(([method, pathname, handler]) => ({ method, pathname, handler }));
}

function findGuiRoute(routes, method, pathname) {
    return routes.find((route) => route.method === method && route.pathname === pathname) || null;
}

module.exports = {
    createGuiRoutes,
    findGuiRoute,
};
