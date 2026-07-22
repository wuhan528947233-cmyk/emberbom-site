import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DOWNLOAD_TARGETS,
  DOWNLOAD_UPSERT_SQL,
  onRequest,
} from "../functions/download/[platform].js";

const FIXED_NOW = new Date("2026-07-21T03:04:05.678Z");
const EXPECTED_RELEASES = {
  windows: {
    path: "/downloads/emberbom_v0.1.0-rc.9_windows_amd64.zip",
    file: "emberbom_v0.1.0-rc.9_windows_amd64.zip",
    size: 2252723,
    sha256: "c6a5be2d63a02cbbfd483862db8946c7b91a88d123aad364f7d716a1bb4cab49",
  },
  linux: {
    path: "/downloads/emberbom_v0.1.0-rc.9_linux_amd64.tar.gz",
    file: "emberbom_v0.1.0-rc.9_linux_amd64.tar.gz",
    size: 2143083,
    sha256: "0c9e324eb098865649edbdfd2644170cb4c25ebd234b4b1394a9d841b5ba9c50",
  },
};

class FakeDownloadDatabase {
  constructor({ fail = false } = {}) {
    this.fail = fail;
    this.counts = new Map();
    this.statements = [];
  }

  prepare(sql) {
    this.statements.push(sql);
    return {
      bind: (day, platform, requestCount, updatedAt) => ({
        run: async () => {
          if (this.fail) {
            throw new Error("simulated_d1_failure");
          }
          assert.equal(requestCount, 1);
          const key = `${day}:${platform}`;
          this.counts.set(key, (this.counts.get(key) || 0) + 1);
          this.lastWrite = { day, platform, updatedAt };
          return { success: true };
        },
      }),
    };
  }

  count(platform) {
    return this.counts.get(`2026-07-21:${platform}`) || 0;
  }
}

async function requestDownload({ method = "GET", platform, database } = {}) {
  const pending = [];
  const response = await onRequest({
    request: new Request(`https://preview.example/download/${platform}`, { method }),
    env: database ? { DOWNLOAD_METRICS_DB: database } : {},
    params: { platform },
    waitUntil: (promise) => pending.push(promise),
    now: FIXED_NOW,
  });
  await Promise.all(pending);
  return { response, pending };
}

for (const platform of ["windows", "linux"]) {
  test(`${platform} GET increments only its counter and redirects to the exact release`, async () => {
    const database = new FakeDownloadDatabase();
    const { response } = await requestDownload({ platform, database });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `https://preview.example${EXPECTED_RELEASES[platform].path}`);
    assert.equal(database.count(platform), 1);
    assert.equal(database.lastWrite.day, "2026-07-21");
    assert.equal(database.lastWrite.updatedAt, "2026-07-21T03:04:05.678Z");
    assert.equal(database.statements[0], DOWNLOAD_UPSERT_SQL);
  });
}

test("two GET requests increment the aggregate counter twice", async () => {
  const database = new FakeDownloadDatabase();
  await requestDownload({ platform: "windows", database });
  await requestDownload({ platform: "windows", database });
  assert.equal(database.count("windows"), 2);
});

test("HEAD redirects without incrementing", async () => {
  const database = new FakeDownloadDatabase();
  const { response, pending } = await requestDownload({ method: "HEAD", platform: "linux", database });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `https://preview.example${EXPECTED_RELEASES.linux.path}`);
  assert.equal(database.count("linux"), 0);
  assert.equal(pending.length, 0);
});

test("unsupported platforms return 404", async () => {
  const { response } = await requestDownload({ platform: "macos" });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});

test("unsupported methods return 405 without counting", async () => {
  const database = new FakeDownloadDatabase();
  const { response } = await requestDownload({ method: "POST", platform: "windows", database });
  assert.equal(response.status, 405);
  assert.equal(database.count("windows"), 0);
});

test("a missing D1 binding never blocks the download", async () => {
  const { response } = await requestDownload({ platform: "windows" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `https://preview.example${EXPECTED_RELEASES.windows.path}`);
});

test("a D1 write failure never blocks the download or leaks its error", async () => {
  const database = new FakeDownloadDatabase({ fail: true });
  const { response } = await requestDownload({ platform: "linux", database });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `https://preview.example${EXPECTED_RELEASES.linux.path}`);
  assert.equal(await response.text(), "");
});

test("release targets, archive sizes, and SHA-256 values match the current published assets", () => {
  assert.deepEqual(DOWNLOAD_TARGETS, {
    windows: EXPECTED_RELEASES.windows.path,
    linux: EXPECTED_RELEASES.linux.path,
  });
  for (const release of Object.values(EXPECTED_RELEASES)) {
    const bytes = readFileSync(new URL(`../downloads/${release.file}`, import.meta.url));
    assert.equal(bytes.byteLength, release.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), release.sha256);
  }
});

test("the schema stores daily platform aggregates and the SQL uses an atomic upsert", () => {
  const schema = readFileSync(new URL("../migrations/0001_download_metrics.sql", import.meta.url), "utf8");
  assert.match(schema, /PRIMARY KEY \(day, platform\)/);
  assert.match(schema, /CHECK \(platform IN \('windows', 'linux'\)\)/);
  assert.match(DOWNLOAD_UPSERT_SQL, /ON CONFLICT\(day, platform\) DO UPDATE/);
  assert.match(DOWNLOAD_UPSERT_SQL, /request_count = download_counts\.request_count \+ 1/);
});

test("download buttons use stable counter routes and remain normal keyboard-operable links", () => {
  for (const page of ["index.html", "fulfillment.html"]) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert.match(html, /<a class="button primary full" href="\/download\/windows">Download ZIP<\/a>/);
    assert.match(html, /<a class="button primary full" href="\/download\/linux">Download tar\.gz<\/a>/);
  }
});

test("Pages Function routing includes the stable download entry points", () => {
  const routes = JSON.parse(readFileSync(new URL("../_routes.json", import.meta.url), "utf8"));
  assert.ok(routes.include.includes("/download/*"));
});

test("privacy policy accurately describes aggregate counting and excluded personal data", () => {
  const privacy = readFileSync(new URL("../privacy.html", import.meta.url), "utf8");
  assert.match(privacy, /records aggregate download request counts by date and operating system/);
  assert.match(privacy, /does not store names, email addresses, full IP addresses, cookies, device fingerprints, source code, or project contents for this measurement/);
  assert.match(privacy, /Cloudflare may independently process ordinary network and security metadata under its own terms/);
  assert.doesNotMatch(privacy, /does not use[^.]*analytics/i);
});

test("Function and schema define no visitor identity, tracking, or logging fields", () => {
  const source = readFileSync(new URL("../functions/download/[platform].js", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../migrations/0001_download_metrics.sql", import.meta.url), "utf8");
  const implementation = `${source}\n${schema}`;
  for (const forbidden of [
    /user[-_ ]?agent/i,
    /cookie/i,
    /fingerprint/i,
    /email/i,
    /full[-_ ]?ip/i,
    /ip[-_ ]?address/i,
    /console\./i,
  ]) {
    assert.doesNotMatch(implementation, forbidden);
  }
});
