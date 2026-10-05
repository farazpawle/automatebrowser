/**
 * The release job's Chrome Web Store step (plan 16): skip a version the store
 * already has, otherwise upload the zip and submit it for review — and stop with
 * the store's own words on any failure, because a release that silently did not
 * reach the store looks exactly like one that did.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { publishToStore } from "../scripts/publish-chrome-store.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = JSON.stringify({
  client_email: "robot@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const base = {
  key,
  publisher: "pub1",
  item: "item1",
  zip: Buffer.from("PK-zip"),
  sleep: async () => {},
};

type Reply = { status?: number; body: unknown };

/** A fetch stand-in: answers by URL substring, records every call. */
function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = async (url: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (!hit) throw new Error("unexpected call " + url);
    const r = routes[hit]!;
    const reply = Array.isArray(r) ? (r.length > 1 ? r.shift()! : r[0]!) : r;
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    };
  };
  // Only the members the script reads are implemented, so it stands in for fetch by cast.
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const token = { "oauth2.googleapis.com/token": { body: { access_token: "tok" } } };
const status = (published?: string, submitted?: string) => ({
  ":fetchStatus": {
    body: {
      ...(published && {
        publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: published }] },
      }),
      ...(submitted && {
        submittedItemRevisionStatus: { distributionChannels: [{ crxVersion: submitted }] },
      }),
    },
  },
});

describe("publishToStore", () => {
  it("skips, uploading nothing, when the store already has this version", async () => {
    for (const [pub, sub] of [
      ["1.0.0", undefined],
      [undefined, "1.0.0"],
    ] as const) {
      const f = fakeFetch({ ...token, ...status(pub, sub) });
      const out = await publishToStore({ ...base, version: "1.0.0", fetch: f.fetch });
      assert.equal(out, "skipped");
      assert.ok(!f.calls.some((c) => c.url.includes(":upload") || c.url.includes(":publish")));
    }
  });

  it("uploads the zip, then submits it for review, when the version is new", async () => {
    const f = fakeFetch({
      ...token,
      ...status("1.0.0"),
      "/upload/v2/": { body: { uploadState: "SUCCEEDED", crxVersion: "1.0.1" } },
      ":publish": { body: { state: "PENDING_REVIEW" } },
    });
    const out = await publishToStore({ ...base, version: "1.0.1", fetch: f.fetch });
    assert.equal(out, "submitted");
    const up = f.calls.find((c) =>
      c.url.includes("/upload/v2/publishers/pub1/items/item1:upload"),
    )!;
    assert.equal(up.method, "POST");
    assert.equal(String(up.body), "PK-zip", "the zip bytes are the request body");
    assert.ok(f.calls.some((c) => c.url.endsWith("/v2/publishers/pub1/items/item1:publish")));
  });

  it("waits while the store is still processing the upload", async () => {
    const f = fakeFetch({
      ...token,
      ":fetchStatus": [
        { body: {} },
        { body: { lastAsyncUploadState: "UPLOAD_IN_PROGRESS" } },
        { body: { lastAsyncUploadState: "SUCCEEDED" } },
      ],
      "/upload/v2/": { body: { uploadState: "UPLOAD_IN_PROGRESS" } },
      ":publish": { body: { state: "PENDING_REVIEW" } },
    });
    assert.equal(await publishToStore({ ...base, version: "1.0.1", fetch: f.fetch }), "submitted");
  });

  it("stops with the store's own message when the upload is refused", async () => {
    const f = fakeFetch({
      ...token,
      ...status("1.0.0"),
      "/upload/v2/": { status: 400, body: { error: { message: "version must be greater" } } },
    });
    await assert.rejects(
      publishToStore({ ...base, version: "1.0.1", fetch: f.fetch }),
      /upload failed \(HTTP 400\).*version must be greater/,
    );
    assert.ok(!f.calls.some((c) => c.url.includes(":publish")), "nothing is submitted");
  });

  it("stops when the upload finishes as FAILED", async () => {
    const f = fakeFetch({
      ...token,
      ...status(),
      "/upload/v2/": { body: { uploadState: "FAILED" } },
    });
    await assert.rejects(publishToStore({ ...base, version: "1.0.1", fetch: f.fetch }), /FAILED/);
  });

  it("names the missing GitHub secret instead of failing obscurely", async () => {
    const f = fakeFetch({});
    await assert.rejects(
      publishToStore({ ...base, key: "", version: "1.0.1", fetch: f.fetch }),
      /CWS_SERVICE_ACCOUNT_KEY/,
    );
  });
});
