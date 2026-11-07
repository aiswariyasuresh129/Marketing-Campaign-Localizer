import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ZooworkError, type ZooworkClient } from "@zoowork-ai/sdk";
import { variantKey } from "./campaign-result";
import type { Job } from "./workflow";

type SqlValue = string | number | null;
type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: SqlValue[]): unknown[];
    get(...args: SqlValue[]): unknown;
    run(...args: SqlValue[]): { changes: number | bigint };
  };
};
type Asset = { fingerprint: string; job_id: string; session_id: string; output_path: string; artifact_id: string | null };
type Context = {
  jobId: string;
  agentId: string;
  sessionId: string;
  sources: { path: string; sha256: string; role: "source_photo" | "document" }[];
  revisionId?: string;
  launchDate?: string;
  markets?: string[];
  isDraft?: (key: string) => boolean;
};
export type VerifiedPreview = { artifactId: string; size: string; draftOnly?: boolean };
type ArtifactClient = Pick<ZooworkClient, "getArtifact" | "listArtifacts" | "getSession">;

let store: Database | undefined;

export function reviewStore() {
  if (store) return store;
  const sqlite = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => Database } | undefined;
  if (!sqlite) throw new Error("The local review database requires Node.js with SQLite support.");
  const folder = join(process.cwd(), ".review-data");
  mkdirSync(folder, { recursive: true });
  const db = new sqlite.DatabaseSync(join(folder, "reviews.sqlite"));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS assets (
      fingerprint TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      output_path TEXT NOT NULL,
      artifact_id TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      job_id TEXT NOT NULL,
      session_id TEXT,
      event_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      details TEXT NOT NULL,
      UNIQUE(job_id, event_key)
    );
    CREATE TABLE IF NOT EXISTS review_jobs (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      snapshot TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
  `);
  store = db;
  return db;
}

export function audit(db: Database, jobId: string, sessionId: string | undefined, key: string, kind: string, details: unknown) {
  db.prepare("INSERT INTO audit_events(job_id, session_id, event_key, kind, details) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, event_key) DO NOTHING")
    .run(jobId, sessionId ?? null, key, kind, JSON.stringify(details));
}

export function readAudit(jobId: string) {
  const records = reviewStore().prepare(
    "SELECT timestamp, job_id, session_id, kind, details FROM audit_events WHERE job_id = ? ORDER BY id",
  ).all(jobId) as { timestamp: string; job_id: string; session_id: string | null; kind: string; details: string }[];
  return records.map((record) => ({ ...record, details: JSON.parse(record.details) as unknown }));
}

export function saveReview(db: Database, submissionId: string, agentId: string, job: Job) {
  db.prepare("INSERT INTO review_jobs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot")
    .run(job.id, submissionId, agentId, JSON.stringify(job));
}

export function savedReviews(db: Database, id: string) {
  const rows = db.prepare("SELECT submission_id, agent_id, snapshot FROM review_jobs WHERE submission_id = ? OR id = ? ORDER BY rowid")
    .all(id, id) as { submission_id: string; agent_id: string; snapshot: string }[];
  return rows.map((row) => ({ submissionId: row.submission_id, agentId: row.agent_id, job: JSON.parse(row.snapshot) as Job }));
}

export function publishedPreviews(db: Database, jobId: string, sessionId: string) {
  const rows = db.prepare(`
    SELECT json_extract(reserved.details, '$.variant.market') AS market,
           json_extract(reserved.details, '$.variant.version') AS version,
           json_extract(reserved.details, '$.variant.width') AS width,
           json_extract(reserved.details, '$.variant.height') AS height,
           json_extract(reserved.details, '$.variant.placement') AS placement,
           json_extract(reserved.details, '$.variant.draftOnly') AS draftOnly,
           json_extract(published.details, '$.artifactId') AS artifactId
    FROM audit_events AS published
    JOIN audit_events AS reserved
      ON reserved.job_id = published.job_id AND reserved.session_id = published.session_id
      AND reserved.kind = 'asset_reserved'
      AND json_extract(reserved.details, '$.fingerprint') = json_extract(published.details, '$.fingerprint')
    WHERE published.job_id = ? AND published.session_id = ? AND published.kind = 'asset_published'
      AND json_extract(reserved.details, '$.variant.format') = 'png'
    ORDER BY published.id
  `).all(jobId, sessionId) as { market: string; version: string; width: number; height: number; placement: string; artifactId: string; draftOnly: number | null }[];
  return new Map(rows.flatMap(({ market, version, width, height, placement, artifactId, draftOnly }) => {
    const preview = { artifactId, size: `${width}x${height}`, draftOnly: Boolean(draftOnly) };
    return [[variantKey(market, version), preview], [variantKey(market, version, placement), preview]] as const;
  }));
}

function requiredText(value: unknown, name: string, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}.`);
  return value.trim();
}

function dimension(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("Use positive integer output dimensions.");
  return value;
}

export function createReviewBackend(db: Database, client: ArtifactClient, context: Context) {
  const { jobId, agentId, sessionId, sources } = context;
  const verifiedIds = new Set<string>();
  const verifiedAssets = new Map<string, VerifiedPreview>();
  const variants = new Map<string, { key: string; size: string; draftOnly: boolean }>();
  const find = (key: string) => db.prepare("SELECT * FROM assets WHERE fingerprint = ?").get(key) as Asset | undefined;
  const log = (key: string, kind: string, details: unknown) => audit(db, jobId, sessionId, key, kind, details);

  function complete(row: Asset, artifactId: string) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const write = db.prepare("UPDATE assets SET artifact_id = ? WHERE fingerprint = ? AND job_id = ? AND artifact_id IS NULL")
        .run(artifactId, row.fingerprint, row.job_id);
      if (write.changes) {
        audit(db, row.job_id, row.session_id, `published:${row.fingerprint}`, "asset_published", {
          fingerprint: row.fingerprint, artifactId, outputPath: row.output_path,
        });
      }
      db.exec("COMMIT");
      return Boolean(write.changes) || find(row.fingerprint)?.artifact_id === artifactId;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function reserve(input: Record<string, unknown>) {
    const path = requiredText(input.source_path, "source path", 400);
    const selected = sources.find((source) => source.path === path && source.role === "source_photo" && /\.(png|jpe?g|gif|webp|pdf)$/i.test(path));
    if (!selected) throw new Error("Select an image from this review's verified manifest.");
    const sourcePage = input.source_page == null ? null : dimension(input.source_page);
    if (/\.pdf$/i.test(path) && !sourcePage) throw new Error("Provide the source page for imagery embedded in a PDF.");
    const format = requiredText(input.format, "output format").toLowerCase().replace(/^jpeg$/, "jpg");
    if (!["png", "jpg", "webp", "pdf"].includes(format)) throw new Error("Use PNG, JPEG, WebP, or PDF output.");
    const variant = {
      market: requiredText(input.market, "market").toLowerCase(),
      version: requiredText(input.version, "version").toLowerCase(),
      placement: requiredText(input.placement, "placement").toLowerCase(),
      width: dimension(input.width),
      height: dimension(input.height),
      format,
      calendarRevision: requiredText(input.calendar_revision, "calendar revision"),
      marketRevision: requiredText(input.market_notes_revision, "market notes revision"),
    };
    const key = variantKey(variant.market, variant.version, variant.placement);
    const draftOnly = context.isDraft?.(key) === true;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      agentId, recipe: variant.placement === "website_banner" ? "campaign-banner-backdrop-v1" : "campaign-placement-v3",
      revision: context.revisionId, hashes: sources.map(({ sha256 }) => sha256).sort(), image: selected.sha256, sourcePage, variant,
      launchDate: context.launchDate || undefined,
      requestedMarkets: context.markets?.length ? [...new Set(context.markets.map((market) => market.toLowerCase()))].sort() : undefined,
      draftJob: draftOnly ? jobId : undefined,
    })).digest("hex");
    const identity = { key, size: `${variant.width}x${variant.height}`, draftOnly };
    if (format === "png") variants.set(fingerprint, identity);
    const outputPath = `/workspace/jobs/${jobId}/outputs/${fingerprint}.${format}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      const row = find(fingerprint);
      if (!row) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const write = db.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, NULL) ON CONFLICT DO NOTHING")
            .run(fingerprint, jobId, sessionId, outputPath);
          if (write.changes) log(`reserved:${fingerprint}`, "asset_reserved", { fingerprint, variant: { ...variant, draftOnly }, image: selected.sha256, outputPath });
          db.exec("COMMIT");
          if (write.changes) return { status: "reserved", fingerprint, output_path: outputPath };
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        continue;
      }
      if (row.artifact_id) {
        const artifact = await client.getArtifact(agentId, row.artifact_id).catch((error: unknown) => {
          if (error instanceof ZooworkError && error.status === 404) return null;
          throw error;
        });
        if (artifact?.status === "ready") {
          log(`reused:${fingerprint}`, "duplicate_skipped", { fingerprint, artifactId: row.artifact_id });
          verifiedIds.add(row.artifact_id);
          if (format === "png") verifiedAssets.set(identity.key, { artifactId: row.artifact_id, size: identity.size, draftOnly });
          return { status: "skip", fingerprint, artifact_id: row.artifact_id };
        }
        if (artifact?.status === "pending") return { status: "in_progress", fingerprint };
        db.prepare("DELETE FROM assets WHERE fingerprint = ? AND artifact_id = ?").run(fingerprint, row.artifact_id);
        continue;
      }
      if (row.job_id === jobId) return { status: "reserved", fingerprint, output_path: row.output_path };
      const prior = await client.getSession(agentId, row.session_id);
      if (!["succeeded", "failed", "aborted", "canceled", "cancelled"].includes(prior.run_status ?? "")) {
        return { status: "in_progress", fingerprint };
      }
      // Reconcile completed runs before releasing a reservation after a worker crash.
      const page = await client.listArtifacts(agentId, { sessionId: row.session_id, sourcePath: row.output_path, limit: 100 });
      const ready = page.artifacts.find((artifact) => artifact.status === "ready" && artifact.source_path === row.output_path);
      if (ready) {
        complete(row, ready.artifact_id);
        continue;
      }
      if (page.has_more || page.artifacts.some((artifact) => artifact.status === "pending")) return { status: "in_progress", fingerprint };
      db.prepare("DELETE FROM assets WHERE fingerprint = ? AND job_id = ? AND artifact_id IS NULL").run(fingerprint, row.job_id);
    }
    return { status: "in_progress", fingerprint };
  }

  return {
    verifiedIds,
    verifiedAssets,
    async execute(name: string, callId: string, rawInput: unknown) {
      if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) throw new Error("Expected structured tool input.");
      const input = rawInput as Record<string, unknown>;
      switch (name) {
        case "campaign_reserve_asset": {
          const result = await reserve(input);
          log(`tool:${callId}`, "match_result", result);
          return result;
        }
        case "campaign_record_artifact": {
          const fingerprint = requiredText(input.fingerprint, "fingerprint");
          const artifactId = requiredText(input.artifact_id, "artifact ID");
          const row = find(fingerprint);
          if (!row || row.job_id !== jobId || row.session_id !== sessionId || (row.artifact_id && row.artifact_id !== artifactId)) {
            throw new Error("This artifact does not belong to an active reservation for this review.");
          }
          const artifact = await client.getArtifact(agentId, artifactId);
          if (artifact.source_path !== row.output_path || artifact.session_id !== sessionId) {
            throw new Error("The artifact does not match the reserved output path and session.");
          }
          if (artifact.status === "pending") return { status: "pending" };
          if (artifact.status !== "ready" || !complete(row, artifactId)) throw new Error("The artifact is not ready or its reservation changed.");
          verifiedIds.add(artifactId);
          const identity = variants.get(fingerprint);
          if (identity) verifiedAssets.set(identity.key, { artifactId, size: identity.size, draftOnly: identity.draftOnly });
          return { status: "recorded", artifact_id: artifactId };
        }
        case "campaign_audit": {
          const step = requiredText(input.step, "workflow step");
          if (!["ingest", "classify", "parse", "match", "act", "log"].includes(step)) throw new Error("Unknown workflow step.");
          const event = requiredText(input.event, "audit event");
          const details = requiredText(input.details, "audit details", 12000);
          const asset = input.asset == null ? null : requiredText(input.asset, "asset reference", 400);
          log(`tool:${callId}`, "agent_decision", { step, event, asset, details });
          return { status: "recorded" };
        }
        default:
          throw new Error("This review cannot execute the requested tool.");
      }
    },
  };
}
