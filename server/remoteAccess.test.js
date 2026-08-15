"use strict";

const assert = require("assert");
const path = require("path");
const {
  normalizeRemoteAddress,
  isLoopbackAddress,
  isTailscaleCgNat,
  isPrivateLanAddress,
  isAllowedPeer,
  getListenPlan,
  buildRemoteInfo,
  parseTailscaleStatus,
  normalizeTailscaleDnsName,
  certNeedsRefresh,
  toPublicRemoteInfo,
  toLoopbackRemoteInfo,
  normalizeStoredCwd,
  folderInSeenList,
} = require("./remoteAccess");

let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("ok -", name);
  } catch (err) {
    failed += 1;
    console.error("not ok -", name);
    console.error(err);
  }
}

test("isTailscaleCgNat is 100.64.0.0/10 only", () => {
  assert.strictEqual(isTailscaleCgNat("100.64.0.1"), true);
  assert.strictEqual(isTailscaleCgNat("100.63.255.255"), false);
  assert.strictEqual(isTailscaleCgNat("192.168.1.10"), false);
  assert.strictEqual(isTailscaleCgNat("100.128.0.1"), false);
  assert.strictEqual(isTailscaleCgNat("100.1.2.3"), false);
  assert.strictEqual(isTailscaleCgNat("100.127.255.255"), true);
  assert.strictEqual(isTailscaleCgNat("100.64.0.0"), true);
});

test("isAllowedPeer matrix: loopback / CGNAT / LAN / public × allowLan", () => {
  const cases = [
    ["127.0.0.1", false, true],
    ["127.0.0.1", true, true],
    ["::1", false, true],
    ["::ffff:127.0.0.1", false, true],
    ["100.64.0.1", false, true],
    ["100.64.0.1", true, true],
    ["192.168.1.10", false, false],
    ["192.168.1.10", true, true],
    ["10.1.2.3", false, false],
    ["10.1.2.3", true, true],
    ["172.16.0.1", false, false],
    ["172.16.0.1", true, true],
    ["8.8.8.8", false, false],
    ["8.8.8.8", true, false],
    ["1.2.3.4", true, false],
    ["", false, false],
    ["", true, false],
    [null, true, false],
    [undefined, false, false],
    ["100.63.255.255", true, false],
    ["100.128.0.1", false, false],
  ];
  for (const [addr, allowLan, expected] of cases) {
    assert.strictEqual(
      isAllowedPeer(addr, { allowLan }),
      expected,
      `${addr} allowLan=${allowLan}`
    );
  }
});

test("normalizeRemoteAddress strips IPv4-mapped prefix and handles empty", () => {
  assert.strictEqual(normalizeRemoteAddress("::ffff:192.168.1.5"), "192.168.1.5");
  assert.strictEqual(normalizeRemoteAddress(null), "");
  assert.strictEqual(normalizeRemoteAddress(undefined), "");
});

test("isLoopbackAddress covers IPv4-mapped and ::1", () => {
  assert.strictEqual(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.strictEqual(isLoopbackAddress("::1"), true);
  assert.strictEqual(isLoopbackAddress("127.0.0.1"), true);
  assert.strictEqual(isLoopbackAddress("127.4.5.6"), true);
  assert.strictEqual(isLoopbackAddress("192.168.0.1"), false);
});

test("isPrivateLanAddress is RFC1918 / link-local, not CGNAT or loopback", () => {
  assert.strictEqual(isPrivateLanAddress("192.168.1.10"), true);
  assert.strictEqual(isPrivateLanAddress("10.0.0.1"), true);
  assert.strictEqual(isPrivateLanAddress("172.16.0.1"), true);
  assert.strictEqual(isPrivateLanAddress("169.254.1.1"), true);
  assert.strictEqual(isPrivateLanAddress("100.64.0.1"), false);
  assert.strictEqual(isPrivateLanAddress("127.0.0.1"), false);
  assert.strictEqual(isPrivateLanAddress("8.8.8.8"), false);
});

test("buildRemoteInfo without Tailscale and allowLan false does not use LAN", () => {
  const info = buildRemoteInfo({
    port: 3847,
    token: "abc",
    host: "127.0.0.1",
    allowLan: false,
    tailscaleIp: null,
  });
  assert.strictEqual(info.phoneUrl, null);
  assert.strictEqual(info.canCopyPhoneUrl, false);
  assert.strictEqual(info.tailscaleIp, null);
  assert.strictEqual(info.allowLan, false);
  assert.ok(!String(info.phoneUrl || "").includes("192.168"));
  assert.ok(!/0\.0\.0\.0/.test(info.bindNote));
  assert.ok(!/set host/i.test(info.bindNote));
  assert.ok(/tailscale/i.test(info.bindNote));
  assert.strictEqual(info.localUrl, "http://127.0.0.1:3847/?token=abc");
});

test("buildRemoteInfo with allowLan can use a LAN IPv4", () => {
  const info = buildRemoteInfo({
    port: 3847,
    token: "abc",
    host: "0.0.0.0",
    allowLan: true,
    tailscaleIp: null,
    lanIpv4: "192.168.1.20",
  });
  assert.strictEqual(info.phoneUrl, "http://192.168.1.20:3847/?token=abc");
  assert.strictEqual(info.canCopyPhoneUrl, true);
  assert.strictEqual(info.tailscaleIp, null);
  assert.strictEqual(info.allowLan, true);
  assert.ok(/wifi|wi-fi|cafe|public/i.test(info.bindNote));
  assert.ok(!/set host to 0\.0\.0\.0/i.test(info.bindNote));
});

test("normalizeTailscaleDnsName strips trailing dots", () => {
  assert.strictEqual(
    normalizeTailscaleDnsName("desktop-r8mr0nj.tail014cfa.ts.net."),
    "desktop-r8mr0nj.tail014cfa.ts.net"
  );
  assert.strictEqual(normalizeTailscaleDnsName("  "), null);
});

test("parseTailscaleStatus reads MagicDNS and cert domains", () => {
  const parsed = parseTailscaleStatus({
    CertDomains: ["desktop-r8mr0nj.tail014cfa.ts.net"],
    Self: {
      DNSName: "desktop-r8mr0nj.tail014cfa.ts.net.",
      TailscaleIPs: ["100.127.87.75", "fd7a:115c:a1e0::1"],
    },
  });
  assert.strictEqual(parsed.dnsName, "desktop-r8mr0nj.tail014cfa.ts.net");
  assert.strictEqual(parsed.ip, "100.127.87.75");
  assert.strictEqual(parsed.httpsEligible, true);
});

test("parseTailscaleStatus is not HTTPS-eligible without cert domains", () => {
  const parsed = parseTailscaleStatus({
    Self: { DNSName: "box.tail014cfa.ts.net.", TailscaleIPs: ["100.64.1.2"] },
  });
  assert.strictEqual(parsed.httpsEligible, false);
});

test("certNeedsRefresh treats invalid PEM as expired", () => {
  assert.strictEqual(certNeedsRefresh("not-a-cert"), true);
});

test("buildRemoteInfo uses https MagicDNS when a cert is live", () => {
  const info = buildRemoteInfo({
    port: 3847,
    token: "tok",
    host: "127.0.0.1",
    allowLan: false,
    tailscaleIp: "100.64.1.9",
    tailscaleDns: "desktop-r8mr0nj.tail014cfa.ts.net",
    httpsPhone: true,
  });
  assert.strictEqual(
    info.phoneUrl,
    "https://desktop-r8mr0nj.tail014cfa.ts.net:3847/?token=tok"
  );
  assert.strictEqual(info.httpsPhone, true);
  assert.ok(/https/i.test(info.bindNote));
});

test("buildRemoteInfo prefers Tailscale over LAN when both exist", () => {
  const info = buildRemoteInfo({
    port: 3847,
    token: "tok",
    host: "127.0.0.1",
    allowLan: false,
    tailscaleIp: "100.64.1.9",
    lanIpv4: "192.168.1.20",
  });
  assert.strictEqual(info.phoneUrl, "http://100.64.1.9:3847/?token=tok");
  assert.strictEqual(info.canCopyPhoneUrl, true);
  assert.strictEqual(info.tailscaleIp, "100.64.1.9");
});

test("getListenPlan leftover host 0.0.0.0 is not allInterfaces", () => {
  const leftover = getListenPlan({
    allowLan: false,
    tailscaleIp: "100.64.1.2",
    host: "0.0.0.0",
  });
  assert.strictEqual(leftover.allInterfaces, false);
  assert.strictEqual(leftover.tailscale, "100.64.1.2");
  assert.strictEqual(leftover.loopback, "127.0.0.1");

  const viaEnv = getListenPlan({ allowLan: false, envHost: "0.0.0.0" });
  assert.strictEqual(viaEnv.allInterfaces, true);
  assert.strictEqual(viaEnv.tailscale, null);
});

test("getListenPlan allowLan listens on all interfaces and skips Tailscale socket", () => {
  const plan = getListenPlan({ allowLan: true, tailscaleIp: "100.64.1.2" });
  assert.strictEqual(plan.allInterfaces, true);
  assert.strictEqual(plan.tailscale, null);
  assert.strictEqual(plan.loopback, "127.0.0.1");
});

test("getListenPlan without allowLan keeps a Tailscale IPv4", () => {
  const plan = getListenPlan({ allowLan: false, tailscaleIp: "100.64.1.2" });
  assert.strictEqual(plan.tailscale, "100.64.1.2");
  assert.strictEqual(plan.allInterfaces, false);
  assert.strictEqual(plan.loopback, "127.0.0.1");
});

const sampleRemote = {
  token: "secret",
  phoneUrl: "http://100.1.2.3:3847/?token=secret",
  host: "127.0.0.1",
  port: 3847,
  tailscaleIp: "100.1.2.3",
  allowLan: false,
  bindNote: "Reachable over Tailscale while this app is open.",
  canCopyPhoneUrl: true,
  localUrl: "http://127.0.0.1:3847/?token=secret",
  phoneApps: {
    required: "Nothing extra — use Safari (or Chrome) on your iPhone.",
  },
};

test("toPublicRemoteInfo strips token and tokenized URLs", () => {
  const pub = toPublicRemoteInfo(sampleRemote);
  assert.strictEqual("token" in pub, false);
  assert.strictEqual(pub.phoneUrl, null);
  assert.strictEqual(pub.hasToken, true);
  assert.strictEqual(pub.canCopyPhoneUrl, false);
  assert.strictEqual("localUrl" in pub, false);
  assert.strictEqual(pub.host, "127.0.0.1");
  assert.strictEqual(pub.port, 3847);
  assert.strictEqual(pub.tailscaleIp, "100.1.2.3");
  assert.strictEqual(pub.allowLan, false);
  assert.strictEqual(pub.bindNote, sampleRemote.bindNote);
  assert.deepStrictEqual(pub.phoneApps, sampleRemote.phoneApps);
  assert.ok(!JSON.stringify(pub).includes("secret"));
});

test("toLoopbackRemoteInfo keeps token and phoneUrl", () => {
  const loop = toLoopbackRemoteInfo(sampleRemote);
  assert.strictEqual(loop.token, "secret");
  assert.strictEqual(loop.phoneUrl, "http://100.1.2.3:3847/?token=secret");
  assert.strictEqual(loop.canCopyPhoneUrl, true);
  assert.strictEqual(loop.localUrl, "http://127.0.0.1:3847/?token=secret");
  assert.strictEqual(loop.hasToken, true);
  assert.strictEqual(loop.host, "127.0.0.1");
});

test("toPublicRemoteInfo keeps localUrl when it has no token query", () => {
  const pub = toPublicRemoteInfo({
    host: "127.0.0.1",
    port: 3847,
    token: "secret",
    localUrl: "http://127.0.0.1:3847",
  });
  assert.strictEqual(pub.localUrl, "http://127.0.0.1:3847");
  assert.ok(!JSON.stringify(pub).includes("secret"));
});

test("normalizeStoredCwd resolves paths and clears empty", () => {
  assert.strictEqual(normalizeStoredCwd(null), null);
  assert.strictEqual(normalizeStoredCwd(undefined), null);
  assert.strictEqual(normalizeStoredCwd(""), null);
  assert.strictEqual(normalizeStoredCwd("   "), null);
  const abs = normalizeStoredCwd("my-folder");
  assert.ok(path.isAbsolute(abs));
  assert.strictEqual(abs, path.resolve("my-folder"));
  assert.strictEqual(normalizeStoredCwd("C:\\Dev\\GrokDesktop"), path.resolve("C:\\Dev\\GrokDesktop"));
});

test("folderInSeenList matches slash/case variants on win32", () => {
  const list = ["C:\\Dev\\GrokDesktop"];
  assert.strictEqual(folderInSeenList("C:\\Dev\\GrokDesktop", list), true);
  assert.strictEqual(folderInSeenList("C:/Dev/GrokDesktop", list), true);
  if (process.platform === "win32") {
    assert.strictEqual(folderInSeenList("c:/dev/grokdesktop", list), true);
    assert.strictEqual(folderInSeenList("c:\\dev\\grokdesktop\\", list), true);
  }
});

test("folderInSeenList rejects a different path", () => {
  const list = ["C:\\Dev\\GrokDesktop"];
  assert.strictEqual(folderInSeenList("C:\\Dev\\OtherProject", list), false);
  assert.strictEqual(folderInSeenList("D:\\Dev\\GrokDesktop", list), false);
  assert.strictEqual(folderInSeenList("", list), false);
  assert.strictEqual(folderInSeenList("C:\\Dev\\GrokDesktop", []), false);
  assert.strictEqual(folderInSeenList("C:\\Dev\\GrokDesktop", null), false);
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
