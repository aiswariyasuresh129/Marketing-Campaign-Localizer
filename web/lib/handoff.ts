import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createZooworkClient } from "@zoowork-ai/sdk";
import { safeSlug } from "./campaign-result";
import { needsEditorialReview, type CampaignReview, type Job } from "./workflow";

export const zooWorkClient = (apiKey: string) =>
  createZooworkClient({ apiKey, baseUrl: "https://clawapi.ecap.gsmo.ai/service/v1" });

export function packageFile(id: string) {
  return join(process.cwd(), ".review-data", "packages", `${id}.zip`);
}

export async function fetchPreview(apiKey: string, agentId: string, artifactId: string, size: string) {
  const client = zooWorkClient(apiKey);
  const artifact = await client.getArtifact(agentId, artifactId);
  if (artifact.status !== "ready" || (artifact.size ?? 0) > 25 * 1024 * 1024) throw new Error("The verified PNG is unavailable.");
  const { url } = await client.downloadArtifact(agentId, artifactId);
  if (!url || new URL(url).protocol !== "https:") throw new Error("No secure preview download is available.");
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error("ZooWork could not return the verified PNG.");
  const bytes = Buffer.from(await response.arrayBuffer());
  const [width, height] = size.split("x").map(Number);
  if (bytes.length < 24 || bytes.length > 25 * 1024 * 1024 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
    throw new Error("A preview is not a PNG at the planned size.");
  }
  return bytes;
}

export function approvedManifest(job: Job): CampaignReview {
  if (!job.campaign) throw new Error("This review does not have a campaign manifest.");
  const versions = job.campaign.versions.map((version) => {
    const approved = version.approval === "approved";
    if (approved && (needsEditorialReview(version) || !job.previews?.[version.id])) {
      throw new Error("An approved version has no eligible verified preview.");
    }
    return { ...version, in_package: approved };
  });
  const included = versions.filter(({ in_package }) => in_package);
  if (!included.length) throw new Error("Approve at least one eligible version before creating a ZIP.");
  const title = job.campaign.campaign.replace(/\s+(?:S\/S|F\/W|A\/W|Spring\/Summer|Fall\/Winter|Autumn\/Winter)\s+\d{4}$/i, "");
  const archiveName = title.split(/\s+[–—-]\s+/).map(safeSlug).join("_");
  return {
    ...job.campaign,
    versions,
    summary: `Packaged ${included.length} approved ${included.length === 1 ? "version" : "versions"}; ${versions.length - included.length} remained outside the handoff.`,
    package: {
      zip_file: `${archiveName}_${job.id}.zip`,
      approved_count: included.length,
      held_or_rejected: versions.filter((version) => needsEditorialReview(version) || version.approval === "rejected").map(({ id }) => id),
      contents: [...included.map(({ zip_path }) => zip_path), "manifest.json"],
    },
  };
}

export async function buildHandoff(job: Job, apiKey: string, agentId: string, manifest: CampaignReview) {
  const temporary = await mkdtemp(join(tmpdir(), "campaign-handoff-"));
  const contents = join(temporary, "contents");
  const archive = join(temporary, "handoff.zip");
  try {
    await mkdir(contents);
    for (const version of manifest.versions.filter(({ in_package }) => in_package)) {
      const output = join(contents, version.zip_path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, await fetchPreview(apiKey, agentId, job.previews![version.id], version.size));
    }
    await writeFile(join(contents, "manifest.json"), JSON.stringify(manifest, null, 2));
    await promisify(execFile)(process.env.ZOOWORK_PWSH || "pwsh", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      join(process.cwd(), "scripts", "New-CampaignArchive.ps1"), "-Source", contents, "-Destination", archive,
    ], { windowsHide: true, timeout: 60000 });
    const destination = packageFile(job.id);
    await mkdir(dirname(destination), { recursive: true });
    // The download becomes available only after the database commits the final manifest.
    await copyFile(archive, destination);
  } finally {
    const resolved = await realpath(temporary);
    if (dirname(resolved) === await realpath(tmpdir())) await rm(resolved, { recursive: true, force: true });
  }
}
