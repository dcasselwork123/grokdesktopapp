"use strict";

/**
 * Standalone server mode — same UI as the desktop app.
 *
 *   node server/index.js
 *
 * Defaults (also used by Electron):
 *   loopback   127.0.0.1  (local UI)
 *   Tailscale  extra listen when an IP is available
 *   token      auto-generated in ~/.grok-desktop/config.json
 *
 * Escape hatch (LAN / all-interfaces):
 *   GROK_DESKTOP_ALLOW_LAN=1
 *   or GROK_DESKTOP_HOST=0.0.0.0
 */

const path = require("path");
const { createServer } = require("./httpApi");
const { resolveAccessSettings } = require("./remoteAccess");

process.on("uncaughtException", (err) => {
  console.error(
    "[Grok Desktop server] uncaughtException:",
    err && err.stack ? err.stack : err
  );
});
process.on("unhandledRejection", (reason) => {
  console.error("[Grok Desktop server] unhandledRejection:", reason);
});

const access = resolveAccessSettings();
const staticDir = path.join(__dirname, "..", "renderer");
const allowLan = !!access.allowLan;

createServer({
  port: access.port,
  staticDir,
  token: access.token,
  allowLan,
  host: access.host, // back-compat; new createServer ignores stored 0.0.0.0 unless allowLan
})
  .then((api) => {
    const { url, remote } = api;
    console.log(`Grok Desktop server`);
    console.log(`  Local:  ${url}`);
    if (remote?.phoneUrl) {
      console.log(`  Phone:  ${remote.phoneUrl}`);
    } else if (!allowLan) {
      console.log(`  Phone:  (Tailscale is down / required for remote access)`);
    }
    if (remote?.bindNote) {
      console.log(`  ${remote.bindNote}`);
    }
    if (typeof api.rebind === "function") {
      const timer = setInterval(() => {
        api
          .rebind()
          .then((next) => {
            if (next) api.remote = next;
          })
          .catch((err) => {
            console.warn(
              "[Grok Desktop server] rebind failed:",
              err && err.message ? err.message : err
            );
          });
      }, 20_000);
      if (typeof timer.unref === "function") timer.unref();
    }
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
