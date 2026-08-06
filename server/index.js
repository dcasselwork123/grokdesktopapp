"use strict";

/**
 * Standalone server mode — same UI as the desktop app, reachable over Tailscale.
 *
 *   node server/index.js
 *
 * Defaults (also used by Electron):
 *   host  0.0.0.0
 *   token auto-generated in ~/.grok-desktop/config.json
 */

const path = require("path");
const { createServer } = require("./httpApi");
const { resolveAccessSettings } = require("./remoteAccess");

const access = resolveAccessSettings();
const staticDir = path.join(__dirname, "..", "renderer");

createServer({
  port: access.port,
  host: access.host,
  staticDir,
  token: access.token,
})
  .then(({ url, remote }) => {
    console.log(`Grok Desktop server`);
    console.log(`  Local:  ${url}`);
    if (remote?.phoneUrl) console.log(`  Phone:  ${remote.phoneUrl}`);
    if (remote?.tailscaleIp) {
      console.log(`  Tailscale IP: ${remote.tailscaleIp}`);
    } else {
      console.log(`  Tailscale IP: (not detected — is Tailscale running?)`);
    }
    console.log(`  ${remote?.bindNote || ""}`);
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
