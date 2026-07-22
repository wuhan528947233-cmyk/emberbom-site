export const DOWNLOAD_TARGETS = Object.freeze({
  windows: "/downloads/emberbom_v0.1.0-rc.9_windows_amd64.zip",
  linux: "/downloads/emberbom_v0.1.0-rc.9_linux_amd64.tar.gz",
});

export const DOWNLOAD_UPSERT_SQL = `
INSERT INTO download_counts (day, platform, request_count, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(day, platform) DO UPDATE SET
  request_count = download_counts.request_count + 1,
  updated_at = excluded.updated_at
`;

async function incrementDownload(database, platform, now) {
  if (!database || typeof database.prepare !== "function") {
    return;
  }

  try {
    const timestamp = now.toISOString();
    await database
      .prepare(DOWNLOAD_UPSERT_SQL)
      .bind(timestamp.slice(0, 10), platform, 1, timestamp)
      .run();
  } catch {
    // Metrics are best-effort and must never block a download.
  }
}

export function onRequest(context) {
  const platform = String(context.params?.platform || "").toLowerCase();
  const target = DOWNLOAD_TARGETS[platform];
  if (!target) {
    return new Response("Not found", { status: 404 });
  }

  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  if (method === "GET") {
    const now = context.now instanceof Date ? context.now : new Date();
    const write = incrementDownload(context.env?.DOWNLOAD_METRICS_DB, platform, now);
    if (typeof context.waitUntil === "function") {
      context.waitUntil(write);
    }
  }

  return Response.redirect(new URL(target, context.request.url), 302);
}
