CREATE TABLE IF NOT EXISTS download_counts (
    day TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('windows', 'linux')),
    request_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day, platform)
);
