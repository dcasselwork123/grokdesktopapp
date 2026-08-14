"use strict";

const assert = require("assert");
const {
  COOKIE_NAME,
  tokensEqual,
  cookieHeader,
  parseCookies,
  presentedToken,
} = require("./authToken");

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

test("COOKIE_NAME stays grok_desktop_token", () => {
  assert.strictEqual(COOKIE_NAME, "grok_desktop_token");
});

test("tokensEqual same strings", () => {
  assert.strictEqual(tokensEqual("abc", "abc"), true);
});

test("tokensEqual different equal-length strings", () => {
  assert.strictEqual(tokensEqual("abc", "xyz"), false);
});

test("tokensEqual different lengths", () => {
  assert.strictEqual(tokensEqual("short", "longer-value"), false);
});

test("tokensEqual empty presented", () => {
  assert.strictEqual(tokensEqual("", "x"), false);
});

test("tokensEqual null presented", () => {
  assert.strictEqual(tokensEqual(null, "x"), false);
});

test("cookieHeader includes HttpOnly and SameSite=Strict", () => {
  const header = cookieHeader("tok");
  assert.ok(header.includes("HttpOnly"));
  assert.ok(header.includes("SameSite=Strict"));
});

test("cookieHeader does not include SameSite=Lax", () => {
  assert.ok(!cookieHeader("tok").includes("SameSite=Lax"));
});

test("cookieHeader does not include Secure", () => {
  assert.ok(!cookieHeader("tok").includes("Secure"));
});

test("presentedToken query wins over header and cookie", () => {
  const req = {
    headers: {
      cookie: `${COOKIE_NAME}=from-cookie`,
      authorization: "Bearer from-auth",
      "x-grok-token": "from-header",
    },
  };
  const url = new URL("http://127.0.0.1/?token=q");
  assert.strictEqual(presentedToken(req, url), "q");
});

test("presentedToken header fallback", () => {
  const req = {
    headers: {
      cookie: `${COOKIE_NAME}=from-cookie`,
      authorization: "Bearer from-auth",
      "x-grok-token": "from-header",
    },
  };
  const url = new URL("http://127.0.0.1/");
  assert.strictEqual(presentedToken(req, url), "from-header");
});

test("presentedToken Authorization Bearer fallback", () => {
  const req = {
    headers: {
      cookie: `${COOKIE_NAME}=from-cookie`,
      authorization: "Bearer from-auth",
    },
  };
  const url = new URL("http://127.0.0.1/");
  assert.strictEqual(presentedToken(req, url), "from-auth");
});

test("presentedToken cookie fallback", () => {
  const req = {
    headers: {
      cookie: `${COOKIE_NAME}=from-cookie`,
    },
  };
  const url = new URL("http://127.0.0.1/");
  assert.strictEqual(presentedToken(req, url), "from-cookie");
});

test("parseCookies decodes URI-encoded values", () => {
  const req = { headers: { cookie: `${COOKIE_NAME}=hello%20world` } };
  assert.strictEqual(parseCookies(req)[COOKIE_NAME], "hello world");
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
