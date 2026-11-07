import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { campaignResult, readFinalObject, variantKey } from "@/lib/campaign-result";
import { approvedManifest, buildHandoff, fetchPreview, packageFile, zooWorkClient } from "@/lib/handoff";
import { audit, createReviewBackend, publishedPreviews, readAudit, reviewStore, savedReviews, saveReview, type VerifiedPreview } from "@/lib/review-store";
import { type CampaignCopy, type CampaignVersion, type Job, type Placement, type ProgressAsset, type StepStatus, type Submission, needsEditorialReview, photoFile, placements, steps, supportedFile } from "@/lib/workflow";

const localJobs = globalThis as typeof globalThis & { campaignJobs?: Map<string, Job>; campaignPackages?: Set<string> };
const jobs: Map<string, Job> = (localJobs.campaignJobs ??= new Map());
const packages: Set<string> = (localJobs.campaignPackages ??= new Set());
const states = new Set<StepStatus>(["pending", "running", "completed", "blocked", "skipped"]);
const pendingSteps: Job["steps"] = { ingest: "pending", classify: "pending", parse: "pending", match: "pending", act: "pending", log: "pending" };
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
type Store = ReturnType<typeof reviewStore>;
type Staged = { name: string; path: string; sha256: string; role: "source_photo" | "document" };
type Revision = { id: string; path: string; original: Job; targets: CampaignVersion[]; copy?: CampaignCopy };
const sourceFolder = () => join(process.cwd(), ".review-data", "sources");
const sourcePath = (id: string) => join(sourceFolder(), id);
const sourceTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

type Reservation = { key: string; draftOnly: boolean };
function trackAsset(job: Job, name: string, input: Record<string, unknown>, result: { status: string; fingerprint?: string; artifact_id?: string }, reserved: Map<string, Reservation>) {
  if (name === "campaign_record_artifact" && result.artifact_id && typeof input.fingerprint === "string") {
    const reservation = reserved.get(input.fingerprint);
    const asset = reservation && job.progressAssets?.[reservation.key];
    if (asset) {
      asset.artifactId = result.artifact_id;
      asset.artifactDraftOnly = reservation.draftOnly;
    }
    return;
  }
  let data = input;
  const routing = name === "campaign_audit" && (input.event === "asset_route" || input.event === "asset_route_corrected");
  if (routing && typeof input.details === "string") {
    try { data = JSON.parse(input.details); } catch { return; }
  } else if (name !== "campaign_reserve_asset" || input.format !== "png") {
    return;
  }
  if (!data || typeof data.market !== "string" || !data.market.trim() || data.market.length > 40 ||
      typeof data.version !== "string" || !data.version.trim() || data.version.length > 40 ||
      typeof data.placement !== "string" || !Object.hasOwn(placements, data.placement)) return;
  const placement = data.placement as Placement;
  const key = variantKey(data.market, data.version, placement);
  const asset: ProgressAsset = job.progressAssets?.[key] ?? {
    market: data.market.trim().toUpperCase(), version: data.version.trim().toUpperCase(), placement, size: placements[placement].size,
  };
  if (routing) {
    if (data.route !== "TRAVELS" && data.route !== "ADAPT" && data.route !== "HOLD") return;
    asset.route = data.route;
    asset.draftOnly = data.route === "HOLD" && data.draft_only === true;
    asset.reason = typeof data.reason === "string" ? data.reason.slice(0, 1000) : undefined;
    asset.ruleNote = typeof data.rule_note === "string" ? data.rule_note.slice(0, 1000) : undefined;
  } else {
    const draftOnly = asset.draftOnly === true;
    if (result.fingerprint) reserved.set(result.fingerprint, { key, draftOnly });
    asset.size = `${data.width}x${data.height}`;
    if (result.artifact_id) {
      asset.artifactId = result.artifact_id;
      asset.artifactDraftOnly = draftOnly;
    }
    if (result.status === "skip") asset.unchanged = true;
  }
  (job.progressAssets ??= {})[key] = asset;
}

function fail(job: Job, error: string) {
  job.status = "failed";
  job.activeStep = null;
  job.error = error;
  job.activity = "Review interrupted";
  for (const { id } of steps) {
    if (job.steps[id] === "running") job.steps[id] = "blocked";
  }
}

function verifiedArtifact(version: CampaignVersion, match?: VerifiedPreview) {
  if (match?.size === version.size && !!match.draftOnly === needsEditorialReview(version)) return match.artifactId;
}

function applyCampaignResult(job: Job, report: string, verifiedAssets?: Map<string, VerifiedPreview>, requirePlacements = false) {
  const campaign = campaignResult(readFinalObject(report), job.id, job.photo!, requirePlacements);
  const previews = Object.fromEntries(campaign.versions.flatMap((version) => {
    const artifactId = verifiedArtifact(version, verifiedAssets?.get(variantKey(version.market, version.version, version.placement)));
    return artifactId ? [[version.id, artifactId]] : [];
  }));
  job.campaign = campaign;
  job.previews = previews;
  job.review = {
    summary: campaign.summary,
    blockers: campaign.versions.filter(({ id }) => !previews[id]).map((version) =>
      `${version.id}: ${needsEditorialReview(version) ? version.route_reason : "No verified preview was returned."}`),
    approvals: campaign.versions.filter((version) => previews[version.id] && !needsEditorialReview(version)).map(({ id }) => id),
    artifacts: Object.values(previews),
  };
  for (const { id } of steps) if (job.steps[id] === "running") job.steps[id] = "pending";
  job.status = "finished";
  job.activeStep = null;
  job.activity = "Review returned";
  delete job.error;
  delete job.report;
}

function applyRevision(job: Job, report: string, revision: Revision, assets: Map<string, VerifiedPreview> | undefined) {
  const result = campaignResult(readFinalObject(report), job.id, job.photo!);
  if (result.versions.length !== revision.targets.length) throw new Error("ZooWork returned a different set of placements.");
  const previews = { ...revision.original.previews };
  const replacements = new Map<string, CampaignVersion>();
  for (const target of revision.targets) {
    const updated = result.versions.find(({ id }) => id === target.id);
    if (!updated || updated.size !== target.size) throw new Error(`ZooWork changed the placement or size of ${target.id}.`);
    if (revision.copy && (updated.headline !== revision.copy.headline || updated.body !== revision.copy.body ||
      updated.cta !== revision.copy.cta || JSON.stringify(updated.detail_callouts) !== JSON.stringify(revision.copy.detail_callouts))) {
      throw new Error(`ZooWork did not preserve the edited copy for ${target.id}.`);
    }
    const placement = target.placement ?? Object.entries(placements).find(([, format]) => format.size === target.size)?.[0];
    const artifactId = verifiedArtifact(updated, assets?.get(variantKey(target.market, target.version, placement)));
    if (artifactId) previews[target.id] = artifactId;
    else if (needsEditorialReview(updated)) delete previews[target.id];
    else throw new Error(`No verified revised preview was returned for ${target.id}.`);
    replacements.set(target.id, { ...updated, file_name: target.file_name, zip_path: target.zip_path });
  }
  const campaign = { ...revision.original.campaign!, summary: result.summary,
    versions: revision.original.campaign!.versions.map((version) => replacements.get(version.id) ?? version) };
  job.campaign = campaign;
  job.previews = previews;
  job.progressAssets = { ...revision.original.progressAssets, ...job.progressAssets };
  job.review = {
    summary: result.summary,
    blockers: campaign.versions.filter(({ id }) => !previews[id]).map((version) =>
      `${version.id}: ${needsEditorialReview(version) ? version.route_reason : "No verified preview was returned."}`),
    approvals: campaign.versions.filter((version) => previews[version.id] && version.approval === "pending" && !needsEditorialReview(version)).map(({ id }) => id),
    artifacts: Object.values(previews),
  };
  job.status = "finished";
  job.activeStep = null;
  job.activity = "Revision returned";
  job.steps = { ...revision.original.steps };
}

function snapshot(db: Store, id: string) {
  const entries = savedReviews(db, id);
  return entries.map((entry) => {
    const live = jobs.get(entry.job.id);
    const job = live ?? entry.job;
    if (job.status === "failed" && job.sessionId && job.photo && job.report &&
        (job.error === "The agent did not return the campaign manifest." || job.error?.startsWith("Invalid review decision for "))) {
      const recovered: Job = { ...job, steps: { ...job.steps } };
      const previews = publishedPreviews(db, job.id, job.sessionId);
      try {
        // Older URL redaction swallowed the closing quote of the optional preview_url.
        const report = job.report.replace(/("preview_url":\s*"\[link omitted\])(?=\r?\n)/g, '$1"');
        applyCampaignResult(recovered, report, previews);
      } catch {
        return { ...entry, job };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        saveReview(db, entry.submissionId, entry.agentId, recovered);
        audit(db, job.id, job.sessionId, "manifest-recovered", "review_recovered", { artifacts: recovered.review?.artifacts });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (live) jobs.set(job.id, recovered);
      return { ...entry, job: recovered };
    }
    if (!live && job.status === "running") fail(job, "The local server restarted before this review returned.");
    return { ...entry, job };
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  if (!validId(id)) return Response.json({ error: "This review is no longer available." }, { status: 404 });
  if (params.get("audit") === "1") {
    try {
      const events = readAudit(id);
      if (!events.length) return Response.json({ error: "No audit events were found for this review." }, { status: 404 });
      return Response.json({ jobId: id, events }, {
        headers: { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="campaign-audit-${id}.json"` },
      });
    } catch {
      return Response.json({ error: "The local audit log could not be read." }, { status: 503 });
    }
  }
  try {
    const entries = snapshot(reviewStore(), id);
    if (!entries.length) return Response.json({ error: "This review is no longer available in the local server." }, { status: 404 });
    const entry = entries[0];
    const preview = params.get("preview");
    if (preview || params.get("zip") === "1" || params.get("source") === "1") {
      if (entries.length !== 1 || entry.job.id !== id) return Response.json({ error: "No file available." }, { status: 404 });
      if (params.get("source") === "1") {
        const contentType = sourceTypes[extname(entry.job.photo ?? "").toLowerCase()];
        if (!entry.job.sourceAvailable || !contentType) return Response.json({ error: "Source preview unavailable." }, { status: 404 });
        return new Response(new Uint8Array(await readFile(sourcePath(id))), {
          headers: { "Content-Type": contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
        });
      }
      if (preview) {
        const live = entry.job.status === "running" && preview.startsWith("live:")
          ? entry.job.progressAssets?.[preview.slice(5)] : undefined;
        const artifactId = live?.artifactId ?? entry.job.previews?.[preview];
        const size = live?.size ?? entry.job.campaign?.versions.find(({ id }) => id === preview)?.size;
        const apiKey = process.env.ZOOWORK_API_KEY?.trim();
        if (!artifactId || !size || !apiKey || (live && (live.route === "HOLD" ? !live.draftOnly || !live.artifactDraftOnly : live.artifactDraftOnly))) {
          return Response.json({ error: "Preview unavailable." }, { status: 404 });
        }
        const bytes = await fetchPreview(apiKey, entry.agentId, artifactId, size);
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
      }
      const filename = entry.job.campaign?.package.zip_file;
      if (!filename) return Response.json({ error: "No approved ZIP available." }, { status: 404 });
      return new Response(new Uint8Array(await readFile(packageFile(id))), {
        headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" },
      });
    }
    const submission: Submission = {
      id, jobs: entries.map(({ job }) => job), status: entries.some(({ job }) => job.status === "running") ? "running" : "finished",
    };
    return Response.json(submission, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The saved review or file could not be read." }, { status: 503 });
  }
}

function originError(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const url = new URL(request.url);
  const host = request.headers.get("host");
  // Next.js can build request.url from the bind address rather than the browser's Host.
  const browserOrigin = host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
    ? `${url.protocol}//${host.toLowerCase()}`
    : url.origin;
  if (fetchSite === "cross-site" || fetchSite === "same-site" || (origin && origin !== browserOrigin)) {
    return Response.json({ error: "Open the local address printed in your terminal, then submit your files from that page." }, { status: 403 });
  }
}

export async function PATCH(request: Request) {
  const denied = originError(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  if (!validId(body?.id) || !["pending", "approved", "rejected"].includes(body?.decision)) {
    return Response.json({ error: "Choose a valid version and approval decision." }, { status: 400 });
  }
  try {
    const db = reviewStore();
    const entry = snapshot(db, body.id).find(({ job }) => job.id === body.id);
    const version = entry?.job.campaign?.versions.find(({ id }) => id === body.versionId);
    if (!entry || !version || entry.job.status !== "finished") return Response.json({ error: "Version not found in a completed review." }, { status: 404 });
    const { job, submissionId, agentId } = entry;
    if (packages.has(job.id) || job.campaign?.package.zip_file) return Response.json({ error: "Approvals are locked for this package." }, { status: 409 });
    if (body.decision === "approved" && (needsEditorialReview(version) || !job.previews?.[version.id])) {
      return Response.json({ error: "This version needs an eligible verified preview before approval." }, { status: 409 });
    }
    const updated = { ...job, campaign: { ...job.campaign!, versions: job.campaign!.versions.map((item) =>
      item.id === version.id ? { ...item, approval: body.decision } : item,
    ) } };
    db.exec("BEGIN IMMEDIATE");
    try {
      saveReview(db, submissionId, agentId, updated);
      audit(db, job.id, job.sessionId, randomUUID(), "art_director_decision", {
        version: version.id, decision: body.decision, artifactId: job.previews?.[version.id] ?? null,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    jobs.set(job.id, updated);
    return Response.json(updated);
  } catch {
    return Response.json({ error: "The approval could not be saved." }, { status: 500 });
  }
}

async function packageReview(id: string) {
  if (packages.has(id)) return Response.json({ error: "This ZIP is already being prepared." }, { status: 409 });
  packages.add(id);
  try {
    const db = reviewStore();
    const entry = snapshot(db, id).find(({ job }) => job.id === id);
    if (!entry || !entry.job.campaign || entry.job.status !== "finished") return Response.json({ error: "Completed review not found." }, { status: 404 });
    const { job, agentId, submissionId } = entry;
    if (job.campaign?.package.zip_file) return Response.json(job);
    const apiKey = process.env.ZOOWORK_API_KEY?.trim();
    if (!apiKey) return Response.json({ error: "Start the server with a ZooWork API key before packaging." }, { status: 503 });
    const final = approvedManifest(job);
    await buildHandoff(job, apiKey, agentId, final);
    const updated = { ...job, campaign: final };
    db.exec("BEGIN IMMEDIATE");
    try {
      saveReview(db, submissionId, agentId, updated);
      audit(db, id, job.sessionId, "handoff", "approved_package_created", final.package);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    jobs.set(id, updated);
    return Response.json(updated);
  } catch {
    return Response.json({ error: "The approved ZIP could not be created. Check that at least one version is approved and its preview is available." }, { status: 409 });
  } finally {
    packages.delete(id);
  }
}

function editedCopy(value: unknown): CampaignCopy | undefined {
  if (!value || typeof value !== "object") return;
  const { headline, body, cta, detail_callouts } = value as Record<string, unknown>;
  if (typeof headline !== "string" || typeof body !== "string" || typeof cta !== "string" ||
    [headline, body, cta].some((field) => field.length > 2000) ||
    !Array.isArray(detail_callouts) || detail_callouts.length > 20 ||
    detail_callouts.some((item) => typeof item !== "string" || item.length > 500)) return;
  return { headline: headline.trim(), body: body.trim(), cta: cta.trim(),
    detail_callouts: detail_callouts.map((item: string) => item.trim()).filter(Boolean) };
}

async function reviseReview(request: Request) {
  const body = await request.json().catch(() => null);
  const copy = editedCopy(body?.copy);
  const feedback = typeof body?.feedback === "string" ? body.feedback.trim() : "";
  if (!validId(body?.id) || typeof body.versionId !== "string" || (body.copy !== undefined && !copy) ||
      (!copy && !feedback) || feedback.length > 3000 || !["one", "all"].includes(body.scope)) {
    return Response.json({ error: "Provide valid copy edits or revision feedback." }, { status: 400 });
  }
  const apiKey = process.env.ZOOWORK_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "Start the server with a ZooWork API key before requesting a revision." }, { status: 503 });
  const db = reviewStore();
  const entry = snapshot(db, body.id).find(({ job }) => job.id === body.id);
  const original = entry?.job;
  const selected = original?.campaign?.versions.find(({ id }) => id === body.versionId);
  if (!entry || !original || !selected) return Response.json({ error: "Version not found." }, { status: 404 });
  if (original.status !== "finished" || original.campaign!.package.zip_file || packages.has(original.id)) {
    return Response.json({ error: "Wait for the active review or package to finish before editing." }, { status: 409 });
  }
  const targets = body.scope === "all" ? original.campaign!.versions.filter(({ market, version }) =>
    market === selected.market && version === selected.version) : [selected];
  const events = readAudit(original.id);
  const uploaded = events.find(({ kind }) => kind === "uploads_verified")?.details as Staged[] | undefined;
  const staged = events.find(({ kind }) => kind === "inputs_staged")?.details as Staged[] | undefined;
  if (!uploaded?.length || !staged || !uploaded.some(({ role }) => role === "source_photo")) {
    return Response.json({ error: "The verified source files for this review are unavailable." }, { status: 409 });
  }
  const sources = uploaded.map((source, index) => ({ ...source, name: staged[index]?.name ?? basename(source.path) }));
  const revisionId = randomUUID();
  const job: Job = { ...original, steps: { ...pendingSteps }, activeStep: null, status: "running", activity: "Preparing revision", revisionError: undefined, progressAssets: undefined };
  jobs.set(job.id, job);
  let directory: string | undefined;
  let manifest: string | undefined;
  let revisionPath: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "campaign-revision-"));
    manifest = join(directory, "sources.json");
    revisionPath = join(directory, "revision.json");
    await writeFile(manifest, JSON.stringify(sources));
    await writeFile(revisionPath, JSON.stringify({ id: revisionId, copy, feedback,
      targets: targets.map((target) => ({ ...target, render_placement: target.placement ??
        Object.entries(placements).find(([, format]) => format.size === target.size)?.[0] ?? "instagram_feed" })),
    }));
    audit(db, job.id, job.sessionId, `revision:${revisionId}`, "revision_requested", { targets: targets.map(({ id }) => id), copy, feedback });
  } catch {
    jobs.set(job.id, original);
    await Promise.allSettled([manifest, revisionPath].flatMap((path) => path ? [unlink(path)] : []));
    if (directory) await rmdir(directory).catch(() => undefined);
    return Response.json({ error: "The server could not stage this revision." }, { status: 500 });
  }
  const revision = { id: revisionId, path: revisionPath, original, targets, copy };
  const sourcesPath = manifest;
  void Promise.resolve()
    .then(() => startReview(db, entry.submissionId, entry.agentId, apiKey, job, sources, sourcesPath, revision))
    .catch(() => {
      jobs.set(job.id, { ...original, revisionError: "The revision worker could not start." });
    })
    .finally(async () => {
      await Promise.allSettled([unlink(manifest), unlink(revisionPath)]);
      await rmdir(directory).catch(() => undefined);
    });
  return Response.json(job, { status: 202 });
}

export async function POST(request: Request) {
  const denied = originError(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  if (params.get("action") === "revise") return reviseReview(request);
  if (params.get("action") === "package") {
    const id = params.get("id");
    return validId(id) ? packageReview(id) : Response.json({ error: "Invalid review ID." }, { status: 400 });
  }
  const apiKey = process.env.ZOOWORK_API_KEY?.trim();
  const agentId = process.env.ZOOWORK_AGENT_ID?.trim();
  if (!apiKey || !agentId || !/^agt_[\w-]+$/.test(agentId)) {
    return Response.json({ error: "Set ZOOWORK_API_KEY and a valid ZOOWORK_AGENT_ID on the local server, then restart it." }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "The upload could not be read. Select the files and try again." }, { status: 400 });
  }
  const files = form.getAll("files").filter((file): file is File => file instanceof File);
  if (!files.length || files.some((file) => !supportedFile(file.name) || !file.size)) {
    return Response.json({ error: "Select non-empty DOCX, PDF, PNG, JPG, GIF, or WebP files." }, { status: 400 });
  }
  const pdfPhotos = new Set(form.getAll("photoPdf").map(Number));
  const isPhoto = (file: File, index: number) => photoFile(file.name) || (/\.pdf$/i.test(file.name) && pdfPhotos.has(index));
  if (!files.some(isPhoto) || files.every(isPhoto)) {
    return Response.json({ error: "Add your campaign documents and at least one photo. Mark any PDF used as a source photo." }, { status: 400 });
  }
  const markets = String(form.get("markets") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const launchDate = String(form.get("launchDate") ?? "");
  if (markets.length > 30 || markets.some((value) => value.length > 60 || /[\u0000-\u001f]/.test(value)) ||
      (launchDate && (!/^\d{4}-\d{2}-\d{2}$/.test(launchDate) ||
        Number.isNaN(Date.parse(launchDate)) || new Date(launchDate).toISOString().slice(0, 10) !== launchDate))) {
    return Response.json({ error: "Enter a valid launch date and up to 30 comma-separated markets." }, { status: 400 });
  }
  const options = { markets: [...new Set(markets)], launchDate };

  let db: Store;
  try {
    db = reviewStore();
  } catch {
    return Response.json({ error: "The local review database could not open. Check that the app uses Node.js with SQLite and that web/.review-data is writable." }, { status: 503 });
  }
  const submissionId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "campaign-localizer-"));
  const staged: Staged[] = files.map((file, index) => {
    const name = file.name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "_");
    return { name, path: join(directory, `${index + 1}${extname(name).toLowerCase()}`), sha256: "",
      role: isPhoto(file, index) ? "source_photo" : "document" };
  });
  const documents = staged.filter(({ role }) => role === "document");
  const queued = staged.filter(({ role }) => role === "source_photo").map((photo) => {
    const id = randomUUID();
    const sources = [...documents, photo];
    const job: Job = {
      id, photo: photo.name, files: sources.map(({ name }) => name), status: "running", activity: "Queued for review",
      options, sourceAvailable: photoFile(photo.name),
      steps: { ...pendingSteps },
    };
    return { job, photo, sources, manifest: join(directory, `${id}.json`) };
  });
  const cleanup = async () => {
    await Promise.allSettled([...queued.map(({ manifest }) => manifest), ...staged.map(({ path }) => path)].map((path) => unlink(path)));
    await rmdir(directory).catch(() => undefined);
  };

  try {
    for (const [index, file] of files.entries()) {
      const bytes = Buffer.from(await file.arrayBuffer());
      staged[index].sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(staged[index].path, bytes);
    }
    await mkdir(sourceFolder(), { recursive: true });
    for (const { job, photo, sources, manifest } of queued) {
      if (job.sourceAvailable) await copyFile(photo.path, sourcePath(job.id));
      await writeFile(manifest, JSON.stringify(sources));
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const { job, sources } of queued) {
        saveReview(db, submissionId, agentId, job);
        audit(db, job.id, undefined, "staged", "inputs_staged", sources.map(({ name, sha256, role }) => ({ name, sha256, role })));
        if (markets.length || launchDate) audit(db, job.id, undefined, "options", "review_options", options);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch {
    await Promise.allSettled(queued.filter(({ job }) => job.sourceAvailable).map(({ job }) => unlink(sourcePath(job.id))));
    await cleanup();
    return Response.json({ error: "The server could not stage the uploaded files." }, { status: 500 });
  }

  for (const { job } of queued) jobs.set(job.id, job);
  void (async () => {
    try {
      for (const { job, sources, manifest } of queued) {
        try {
          await startReview(db, submissionId, agentId, apiKey, job, sources, manifest);
        } catch {
          fail(job, "The review worker could not start.");
          try { saveReview(db, submissionId, agentId, job); } catch { /* Keep the in-memory failure visible. */ }
        }
      }
    } finally {
      await cleanup();
    }
  })();
  return Response.json({ id: submissionId, status: "running", jobs: queued.map(({ job }) => job) } satisfies Submission, { status: 202 });
}

function startReview(db: Store, submissionId: string, agentId: string, apiKey: string, job: Job, staged: Staged[], manifest: string, revision?: Revision) {
  const id = job.id;
  job.activity = "Connecting to ZooWork";
  job.steps.ingest = "running";
  job.activeStep = "ingest";
  const child = spawn(
    process.env.ZOOWORK_PWSH || "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(process.cwd(), "scripts", "Invoke-ZooWorkReview.ps1"), "-ManifestPath", manifest, "-JobId", id,
      ...(revision ? ["-RevisionPath", revision.path] : [])],
    { env: { ...process.env, ZOOWORK_API_KEY: apiKey, ZOOWORK_AGENT_ID: agentId,
      CAMPAIGN_REVIEW_OPTIONS: JSON.stringify(job.options ?? {}) }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  const client = zooWorkClient(apiKey);
  const sources = staged.map(({ path, sha256, role }) => ({ path: revision ? path : `/workspace/jobs/${id}/${basename(path)}`, sha256, role }));
  let backend: ReturnType<typeof createReviewBackend> | undefined;
  let uploadsVerified = false;
  const reserved = new Map<string, Reservation>();
  let workerSession = revision ? undefined : job.sessionId;
  const log = (key: string, kind: string, details: unknown) => audit(db, id, workerSession, revision ? `revision:${revision.id}:${key}` : key, kind, details);
  child.stdin.on("error", () => { /* The worker may exit while a result is in flight. */ });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    if (event.kind === "tool") {
      void (async () => {
        try {
          if (!backend || !uploadsVerified) throw new Error("The review has no verified upload manifest.");
          const value = await backend.execute(event.name, event.callId, event.input);
          trackAsset(job, event.name, event.input, value, reserved);
          child.stdin.write(JSON.stringify({ value }) + "\n");
        } catch (error) {
          const message = error instanceof Error ? error.message : "The review tool failed.";
          child.stdin.write(JSON.stringify({ error: message }) + "\n");
        }
      })();
      return;
    }
    try {
      if (typeof event.sessionId === "string" && !workerSession) {
        workerSession = event.sessionId;
        if (!revision) job.sessionId = event.sessionId;
        backend = createReviewBackend(db, client, { jobId: id, agentId, sessionId: event.sessionId, sources, revisionId: revision?.id,
          launchDate: job.options?.launchDate, markets: job.options?.markets,
          isDraft: (key) => job.progressAssets?.[key]?.draftOnly === true });
        log("session", "session_opened", { model: typeof event.model === "string" ? event.model : undefined });
      }
      if (event.kind === "uploads_verified") {
        uploadsVerified = true;
        log("uploads", "uploads_verified", sources);
      }
      if (typeof event.activity === "string") job.activity = event.activity;
      if (event.kind === "step") {
        const step = steps.find(({ id }) => id === event.step);
        if (step && states.has(event.status)) {
          log(`step:${event.sequence}:${step.id}:${event.status}`, "agent_step", { step: step.id, status: event.status });
          job.steps[step.id] = event.status;
          if (event.status === "running") job.activeStep = step.id;
          else if (job.activeStep === step.id) job.activeStep = null;
        }
      }
      if (event.kind === "result") {
        const report = typeof event.report === "string" ? event.report : "";
        try {
          if (revision) applyRevision(job, report, revision, backend?.verifiedAssets);
          else applyCampaignResult(job, report, backend?.verifiedAssets, true);
        } catch (error) {
          job.report = report.replace(/https?:\/\/[^\s"<>]+/gi, "[link omitted]");
          fail(job, error instanceof Error ? error.message : "ZooWork finished without a valid campaign manifest.");
        }
        if (job.status === "finished") {
          log("result", "review_returned", { steps: job.steps, review: job.review });
          saveReview(db, submissionId, agentId, job);
        }
      }
      if (event.kind === "error") {
        log("worker_error", "worker_error", { message: event.message });
        fail(job, event.message);
      }
    } catch {
      fail(job, "The local audit log could not record the review. Check the database and retry.");
      child.kill();
    }
  });
  child.once("error", () => fail(job, "PowerShell 7 could not start. Check the server’s ZOOWORK_PWSH setting."));
  return new Promise<void>((resolve) => child.once("close", () => {
    if (job.status === "running") fail(job, "The background worker stopped before ZooWork returned a review.");
    try {
      log("closed", "worker_closed", { status: job.status, error: job.error });
      if (revision && job.status === "failed") {
        jobs.set(id, { ...revision.original, revisionError: job.error });
      }
      saveReview(db, submissionId, agentId, jobs.get(id) ?? job);
    } catch {
      fail(job, "The local audit log could not record the worker outcome.");
    }
    resolve();
  }));
}
