// Upload the built extension to the Chrome Web Store and submit it for review (plan 16).
//
// Run by the release workflow, never by hand in normal use:
//   CWS_SERVICE_ACCOUNT_KEY=<service-account JSON> CWS_PUBLISHER_ID=… CWS_ITEM_ID=… \
//     node scripts/publish-chrome-store.mjs Chrome-extension/.output/<name>-chrome.zip
//
// The item must already exist: the API updates a listing, it cannot create one.
// A version the store already has (published or under review) is skipped rather
// than uploaded, because the store refuses a version that is not higher — so a
// server-only release, or a re-run, passes quietly instead of failing.
//
// Authenticates as a Google Cloud service account linked in the store dashboard,
// signing the token request with node:crypto, so this needs no dependency.
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

async function accessToken(keyJson, fetch) {
  let key;
  try {
    key = JSON.parse(keyJson);
  } catch {
    throw new Error(
      "CWS_SERVICE_ACCOUNT_KEY is missing or is not the service account's JSON key file.",
    );
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64({
      iss: key.client_email,
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 600,
    });
  const jwt =
    unsigned +
    "." +
    sign("RSA-SHA256", Buffer.from(unsigned), key.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt,
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(
      `Google refused the service account login: ${body.error_description || body.error}`,
    );
  }
  return body.access_token;
}

/** Read a JSON reply, turning an HTTP error into one that carries the store's message. */
async function expectOk(res, what) {
  if (res.ok) return res.json();
  let detail = await res.text();
  try {
    detail = JSON.parse(detail).error?.message || detail;
  } catch {
    /* not JSON — keep the raw text */
  }
  throw new Error(`${what} failed (HTTP ${res.status}): ${detail}`);
}

const versionsOf = (rev) => (rev?.distributionChannels ?? []).map((c) => c.crxVersion);

/**
 * Returns "skipped" when the store already has `version`, otherwise "submitted"
 * once the upload succeeded and the item went in for review. Throws on anything else.
 */
export async function publishToStore({
  key,
  publisher,
  item,
  zip,
  version,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
}) {
  const token = await accessToken(key, fetch);
  const auth = { authorization: `Bearer ${token}` };
  const name = `publishers/${publisher}/items/${item}`;
  const status = () =>
    fetch(`${API}/v2/${name}:fetchStatus`, { headers: auth }).then((r) =>
      expectOk(r, "fetchStatus"),
    );

  const before = await status();
  const inStore = [
    ...versionsOf(before.publishedItemRevisionStatus),
    ...versionsOf(before.submittedItemRevisionStatus),
  ];
  if (inStore.includes(version)) {
    log(`Chrome Web Store already has ${version}; nothing to upload.`);
    return "skipped";
  }

  const up = await expectOk(
    await fetch(`${API}/upload/v2/${name}:upload`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/zip" },
      body: zip,
    }),
    "upload",
  );
  let state = String(up.uploadState ?? "");
  // ponytail: fixed 5 s poll, 2 minutes total. Uploads have finished well inside that so far.
  for (let i = 0; /IN_PROGRESS/.test(state) && i < 24; i++) {
    await sleep(5000);
    state = String((await status()).lastAsyncUploadState ?? "");
  }
  if (/IN_PROGRESS/.test(state)) throw new Error("upload still processing after 2 minutes");
  if (/FAIL|NOT_FOUND/.test(state))
    throw new Error(`upload ended as ${state}; see the store dashboard`);
  log(`Uploaded ${version} (${state}).`);

  const pub = await expectOk(
    await fetch(`${API}/v2/${name}:publish`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    }),
    "publish",
  );
  for (const w of pub.warningInfo?.warnings ?? [])
    log(`store warning: ${w.reason}: ${w.description}`);
  log(`Submitted ${version} for review (${pub.state}).`);
  return "submitted";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const zipPath = process.argv[2];
  const root = new URL("..", import.meta.url);
  const { version } = JSON.parse(
    readFileSync(new URL("Chrome-extension/package.json", root), "utf8"),
  );
  publishToStore({
    key: process.env.CWS_SERVICE_ACCOUNT_KEY ?? "",
    publisher: process.env.CWS_PUBLISHER_ID,
    item: process.env.CWS_ITEM_ID,
    zip: readFileSync(zipPath),
    version,
    log: (m) => console.log(m),
  }).catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
