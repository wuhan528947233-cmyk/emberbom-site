# Anonymous download metrics operations

EmberBOM records only daily aggregate download requests for Windows and Linux. The Cloudflare Pages Function uses the `DOWNLOAD_METRICS_DB` D1 binding and writes no per-request rows.

Preview and Production must use separate databases:

- Preview: `emberbom-download-metrics-preview`
- Production: `emberbom-download-metrics`

Never bind the Preview database to Production. The initial schema is in `migrations/0001_download_metrics.sql`.

## Read-only query

```sql
SELECT day, platform, request_count, updated_at
FROM download_counts
ORDER BY day DESC, platform;
```

The result is a count of download requests, not a count of unique users. Repeated clicks, repeated downloads, and some automated requests may be counted more than once. A count does not prove that an archive finished downloading or that EmberBOM was run. Anonymous download requests do not count as Gate B qualified users.

If D1 is unavailable or a write fails, the download redirect still succeeds and the missed request is not reconstructed later.
