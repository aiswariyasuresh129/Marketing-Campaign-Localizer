"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { inputTypes, photoFile, steps, supportedFile, type CampaignVersion, type Job, type StepStatus, type Submission } from "@/lib/workflow";
import { AssetImage, Gallery, type ReviewAsset, reviewAssets } from "./review-gallery";

const phases = ["Upload", "Review", "Results"];
const statusLabels: Record<StepStatus, string> = {
  pending: "Waiting", running: "In progress", completed: "Complete", blocked: "Blocked", skipped: "Skipped",
};

function fileSize(bytes: number) {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [pdfPhotos, setPdfPhotos] = useState<File[]>([]);
  const [submission, setSubmission] = useState<Submission>();
  const [photoId, setPhotoId] = useState<string>();
  const [jobId, setJobId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<{ jobId: string; versionId: string; mode: "copy" | "feedback" }>();
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [source, setSource] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusDialog = useRef<HTMLDialogElement>(null);
  const captionInput = useRef<HTMLTextAreaElement>(null);
  const focusOrigin = useRef<DOMRect | undefined>(undefined);
  const keyArt = files.find((file) => photoFile(file.name));
  const job = submission?.jobs.find(({ id }) => id === photoId) ?? submission?.jobs[0];
  const activeJob = submission?.status === "finished" ? undefined : jobId;
  const phase = !job ? 0 : job.status === "running" ? 1 : 2;
  const assets = job ? reviewAssets(job) : [];
  const selectedAsset = assets.find(({ id }) => id === selected);
  const canInspect = !!selectedAsset;

  useEffect(() => {
    if (!keyArt) return;
    const url = URL.createObjectURL(keyArt);
    const frame = requestAnimationFrame(() => setSource(url));
    return () => { cancelAnimationFrame(frame); URL.revokeObjectURL(url); };
  }, [keyArt]);

  useEffect(() => {
    const dialog = focusDialog.current;
    if (canInspect && dialog && !dialog.open) {
      dialog.showModal();
      const origin = focusOrigin.current;
      const image = dialog.querySelector("img");
      if (origin && image && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const target = image.getBoundingClientRect();
        if (target.width && target.height) {
          const scale = Math.min(origin.width / target.width, origin.height / target.height);
          image.animate([
            { transform: `translate(${origin.left - target.left}px, ${origin.top - target.top}px) scale(${scale})` },
            { transform: "none" },
          ], { duration: 450, easing: "cubic-bezier(.2,.7,.2,1)" });
        }
      }
    }
    if (!canInspect && dialog?.open) dialog.close();
  }, [canInspect]);

  useEffect(() => {
    const saved = new URLSearchParams(window.location.search).get("review");
    if (saved && /^[a-f0-9-]{36}$/.test(saved)) {
      const timer = setTimeout(() => setJobId(saved), 0);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    heading.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (!activeJob) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/api/jobs?id=${encodeURIComponent(activeJob!)}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 404) {
            setSubmission(undefined);
            setJobId(undefined);
            setError(data.error);
            window.history.replaceState(null, "", window.location.pathname);
            return;
          }
          throw new Error();
        }
        setSubmission(data);
        setError("");
        if (data.status !== "running") return;
      } catch {
        if (controller.signal.aborted) return;
        setError("Lost the progress connection. Reconnecting automatically.");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1700);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeJob]);

  function addFiles(selected: File[]) {
    const valid = selected.filter((file) => supportedFile(file.name) && file.size > 0);
    const rejected = selected.filter((file) => !valid.includes(file));
    setError(rejected.length ? `Could not add ${rejected.map((file) => file.name).join(", ")}. Use non-empty DOCX, PDF, PNG, JPG, GIF, or WebP files.` : "");
    setFiles((current) => [...current, ...valid]);
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (!submitting) addFiles(Array.from(event.dataTransfer.files));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!files.length || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const body = new FormData(event.currentTarget);
      files.forEach((file, index) => {
        body.append("files", file);
        if (pdfPhotos.includes(file)) body.append("photoPdf", String(index));
      });
      const response = await fetch("/api/jobs", { method: "POST", body });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error ?? "The upload did not start. Try again.");
      setSubmission(data);
      setPhotoId(undefined);
      setJobId(data.id);
      window.history.replaceState(null, "", `?review=${encodeURIComponent(data.id)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The upload did not start. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function updateReview(job: Job, action: "approval" | "package", versionId?: string, decision?: CampaignVersion["approval"]) {
    setSaving(true);
    setError("");
    try {
      const response = action === "approval"
        ? await fetch("/api/jobs", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: job.id, versionId, decision }),
        })
        : await fetch(`/api/jobs?action=package&id=${encodeURIComponent(job.id)}`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSubmission((current) => current && { ...current, jobs: current.jobs.map((item) => item.id === job.id ? data : item) });
      if (action === "approval") { setSelected(undefined); setEditor(undefined); }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The review could not be updated.");
    } finally {
      setSaving(false);
    }
  }

  async function submitRevision(event: React.FormEvent<HTMLFormElement>, job: Job, version: CampaignVersion, mode: "copy" | "feedback") {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const copy = mode === "copy" ? {
      headline: String(form.get("headline")), body: String(form.get("body")), cta: String(form.get("cta")),
      detail_callouts: String(form.get("callouts")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    } : undefined;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/jobs?action=revise", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: job.id, versionId: version.id, scope: form.get("scope"), copy,
          feedback: mode === "feedback" ? form.get("feedback") : undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSubmission((current) => current && { ...current, status: "running",
        jobs: current.jobs.map((item) => item.id === job.id ? data : item) });
      setEditor(undefined);
      setSelected(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The revision could not be started.");
    } finally {
      setSaving(false);
    }
  }

  const version = selectedAsset?.record;
  const hero = assets.find(({ url }) => url);
  const locked = !!job?.campaign?.package.zip_file;
  const completed = job ? steps.filter(({ id }) => job.steps[id] === "completed").length : 0;
  const activeStep = job?.activeStep === undefined
    ? steps.filter(({ id }) => job?.steps[id] === "running").at(-1)?.id
    : job.activeStep;
  const activeIndex = steps.findIndex(({ id }) => id === activeStep);
  const blockedStep = steps.find(({ id }) => job?.steps[id] === "blocked");
  const remaining = steps.find(({ id }) => job?.steps[id] === "pending");
  const progressLabel = activeIndex >= 0
    ? `Step ${activeIndex + 1} of ${steps.length} · ${steps[activeIndex].title}`
    : blockedStep ? `Blocked · ${blockedStep.title}`
    : job?.activity === "Queued for review" ? "Photo queued"
    : remaining ? "Waiting for ZooWork’s next step update"
    : "Waiting for review results";
  const editorial = assets.filter(({ editorialReview, record }) => editorialReview && record?.approval !== "rejected");
  const missing = assets.filter(({ status }) => status === "Preview unavailable");
  const pending = assets.filter(({ record, url, editorialReview }) => !editorialReview && record?.approval === "pending" && url);
  const approved = assets.filter(({ record }) => record?.approval === "approved");
  const emptyReviewReason = job?.campaign && !assets.length ? job.review?.summary : undefined;
  const issues = [...new Set([job?.error, job?.revisionError, emptyReviewReason, ...(job?.review?.blockers ?? [])].filter(Boolean))]
    .filter((message) => !assets.some(({ id, editorialReview, status }) =>
      (editorialReview || status === "Preview unavailable") && message?.startsWith(id + ":")));
  const editing = editor?.jobId === job?.id && editor?.versionId === version?.id ? editor?.mode : undefined;
  const editableJob = job?.status === "finished" && !locked ? job : undefined;
  useEffect(() => {
    if (editing === "copy") captionInput.current?.focus();
  }, [editing]);
  const japanese = version && /^(jp|ja|japan|日本)([-_].*)?$/i.test(version.market) ? "ja" : undefined;
  const sourceUrl = job ? job.sourceAvailable ? `/api/jobs?id=${job.id}&source=1` : undefined : keyArt ? source : undefined;
  const narration = job?.activity.split(/\s+/).slice(0, 59).join(" ");
  const closeFocus = () => { setSelected(undefined); setEditor(undefined); };
  function openAsset(asset: ReviewAsset, origin?: HTMLButtonElement) {
    focusOrigin.current = origin?.querySelector("img")?.getBoundingClientRect();
    setError("");
    setSelected(asset.id);
    setEditor(undefined);
  }

  return (
    <div className="workspace">
      <header className={`masthead${phase === 1 ? " masthead-live" : ""}`}>
        <span className="label">Campaign Localizer</span>
        {phase === 1 && <a className="live-status label" href="#review-progress">{error ? "Reconnecting to review…" : progressLabel} ↓</a>}
        <nav aria-label="Review stages">
          <ol className="phase-list">{phases.map((name, index) =>
            <li key={name} className="label" aria-current={phase === index ? "step" : undefined}>{index + 1} / {name}</li>)}</ol>
        </nav>
      </header>
      <main>
        {phase === 1 && job && <section id="review-progress" className="progress panel" aria-labelledby="review-heading">
          <div className="progress-heading">
            <h1 id="review-heading" ref={heading} tabIndex={-1}>Review in progress</h1>
            <p className="label muted">{completed} of {steps.length} complete</p>
          </div>
          <p className={`label current-step${activeIndex < 0 && blockedStep ? " alert" : ""}`} role="status">{progressLabel}</p>
          <ol className="step-list">{steps.map(({ id, title, description }, index) => {
            const status = job.steps[id];
            const current = id === activeStep;
            return <li key={id} title={description} aria-current={current ? "step" : undefined} data-step-status={status}>
              <span className="label">{index + 1} / {title}</span>
              <span className="step-caption">{status === "running" && !current ? "Started" : statusLabels[status]}</span>
            </li>;
          })}</ol>
          {error ? <p className="alert" role="status">{error} Showing the last reported steps.</p> : <p className="red-block">{narration}</p>}
        </section>}
        {submission && job && submission.jobs.length > 1 && <nav className="photo-tabs" aria-label="Photo reviews">
          {submission.jobs.map((item, index) => <button type="button" key={item.id} aria-pressed={job.id === item.id}
            className="secondary" onClick={() => { setPhotoId(item.id); closeFocus(); if (phase !== 1) setError(""); }}>
            {index + 1} / {item.photo ?? "Photo"} · {item.status === "running"
              ? item.activity === "Queued for review" ? "Queued" : "In review"
              : item.status === "failed" ? "Failed" : "Ready"}
          </button>)}
        </nav>}
        <section className="spread" aria-label={job ? "Campaign spread" : "Campaign intake"}>
          <div className="key-art">
            <div className="corners label"><span>{job?.campaign?.campaign || "Campaign Localizer"}</span><span>Key art</span></div>
            <div className="key-art-image">
              {sourceUrl ? <AssetImage src={sourceUrl} alt={job?.photo ?? keyArt?.name ?? "Uploaded key art"} />
                : <p className="label muted">{job?.photo ? "Source preview unavailable" : "Your key art appears here"}</p>}
            </div>
            <div className="corners label"><span>{job?.photo || keyArt?.name}</span>
              <span>{job?.campaign?.launch_date || job?.options?.launchDate}</span></div>
          </div>
          {!job ? <form className="upload-panel panel" onSubmit={submit} aria-busy={submitting}>
            <p className="label">01 / New review</p>
            <h1 ref={heading} tabIndex={-1}>Upload your campaign.</h1>
            <p className="lead">Add your brief, brand guidelines and key art. Each photo gets its own review and ZIP.</p>
            <section className={`dropzone ${dragging ? "dragging" : ""}`} aria-label="File upload area"
              onDragOver={(event) => { event.preventDefault(); if (!submitting) setDragging(true); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
              <div><h2 className="label">Drop files here</h2><p>DOCX, PDF, PNG, JPG, GIF or WebP</p></div>
              <input ref={picker} type="file" multiple accept={inputTypes} hidden
                onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <button type="button" className="secondary" disabled={submitting} onClick={() => picker.current?.click()}>Browse files</button>
            </section>
            {!!files.length && <ul className="file-list" aria-label="Selected files">
              {files.map((file, index) => <li key={`${file.name}-${index}`}>
                <span className="file-name">{file.name}</span><span className="muted">{fileSize(file.size)}</span>
                {/\.pdf$/i.test(file.name) && <label className="photo-role">
                  <input type="checkbox" checked={pdfPhotos.includes(file)} disabled={submitting}
                    onChange={(event) => setPdfPhotos((current) => event.target.checked ? [...current, file] : current.filter((item) => item !== file))} />
                  Source photo
                </label>}
                <button type="button" className="secondary remove" aria-label={`Remove ${file.name}`} disabled={submitting}
                  onClick={() => {
                    setFiles((current) => current.filter((_, position) => index !== position));
                    setPdfPhotos((current) => current.filter((item) => item !== file));
                  }}>×</button>
              </li>)}
            </ul>}
            <div className="settings">
              <label>Markets <input name="markets" placeholder="Use the brief" maxLength={1800} disabled={submitting} /></label>
              <label>Launch date <input type="date" name="launchDate" disabled={submitting} /></label>
              <p className="muted">Optional. Separate markets with commas.</p>
            </div>
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="panel-footer"><span className="label" role="status">{submitting ? "Uploading files…" : `${files.length} selected`}</span>
              <button type="submit" disabled={!files.length || submitting}>Start review <span aria-hidden="true">→</span></button>
            </div>
          </form> : <div className="hero panel">
            <div className="corners label"><span>{phase === 1 ? "02 / In review" : "03 / Review kit"}</span><span>{assets.length} assets</span></div>
            {phase === 1 ? <h2>Campaign previews</h2> : <h1 ref={heading} tabIndex={-1}>Campaign review</h1>}
            {(issues.length > 0 || editorial.length > 0 || missing.length > 0 || pending.length > 0) && <a className="label attention-link" href="#review-notes">
              {job.error ? "Review interrupted" : "Review notes"} ↓
            </a>}
            {hero?.url ? <button className="hero-image" onClick={(event) => openAsset(hero, event.currentTarget)} aria-label={`Inspect ${hero.label}`}>
              <AssetImage src={hero.url} alt={hero.label} size={hero.size} />
            </button> : <p className="hero-empty label muted">{phase === 1 ? "Previews appear here as ZooWork publishes them" : "No verified previews returned"}</p>}
            <div className="corners label"><span>{hero?.label}</span><span data-status={hero?.status}>{hero?.status}</span></div>
          </div>}
        </section>

        {job && <>
          {phase === 2 && error && !selected && <p className="alert section" role="alert">{error}</p>}
          <section id="review-notes" className="section panel review-notes" aria-labelledby="notes-title">
            <div>
              <h2 id="notes-title">Review notes</h2>
              <div className="review-counts label">
                {pending.length > 0 && <span>{pending.length} ready to approve</span>}
                {editorial.length > 0 && <span>{editorial.length} for editorial review</span>}
                {missing.length > 0 && <span>{missing.length} previews unavailable</span>}
              </div>
              {job.status === "failed" && <button type="button" onClick={() => {
                setSubmission(undefined); setPhotoId(undefined); setJobId(undefined); setError(""); closeFocus();
                window.history.replaceState(null, "", window.location.pathname);
              }}>Rerun from upload</button>}
            </div>
            <div className="notes-body">
              {!!issues.length && <div><h3 className="label alert">Review issues</h3><ul>{issues.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
              {!!editorial.length && <p>Open a marked asset to see its review note and any available draft.</p>}
              {!editorial.length && !missing.length && !issues.length && <p>{pending.length ? "Open an asset in the campaign kit to review and approve it."
                : phase === 1 ? "Editorial notes will appear here as the review progresses." : "No outstanding review notes."}</p>}
              {!!(editorial.length || missing.length) && <details>
                <summary>View notes by asset</summary>
                <ul className="asset-note-list">{[...editorial, ...missing].map((asset) => <li key={asset.id}>
                  <button type="button" className="secondary" onClick={() => openAsset(asset)}>{asset.label}</button>
                  <span className="label" data-status={asset.status}>{asset.status}</span>
                  {asset.reason && <p>{asset.reason}</p>}
                </li>)}</ul>
              </details>}
              {!!job.campaign?.calendar_flags.length && <details><summary>Calendar notes</summary><ul>{job.campaign.calendar_flags.map((flag, index) =>
                <li key={index}>{typeof flag === "string" ? flag : Object.values(flag).map(String).join(" · ")}</li>)}</ul></details>}
            </div>
          </section>

          <Gallery key={job.id} assets={assets} onOpen={openAsset} campaign={job.campaign?.campaign}
            summary={job.review?.summary} running={phase === 1} />

          {job.campaign && phase === 2 && <section className="section panel handoff" aria-labelledby="handoff-title">
            <div><p className="label">{approved.length} approved</p><h2 id="handoff-title">Handoff</h2>
              {locked ? <a className="button" href={`/api/jobs?id=${job.id}&zip=1`} download>Download approved ZIP</a>
                : <button type="button" disabled={saving || !approved.length} onClick={() => void updateReview(job, "package")}>{saving ? "Working…" : "Create approved ZIP"}</button>}
            </div>
            <div className="right-list">
              <p>{locked ? "The approved ZIP is ready to download." : "Only approved assets go into this photo’s ZIP."}</p>
              {approved.length > 0 && ["Social", "Website", "Other"].map((team) => {
                const group = approved.filter(({ channel }) => (channel.startsWith("Instagram") ? "Social" : channel === "Website Banner" ? "Website" : "Other") === team);
                return group.length > 0 && <div key={team}><h3 className="label">{team}</h3><ul>{group.map(({ id, record }) => <li key={id}>{record?.file_name}</li>)}</ul></div>;
              })}
            </div>
          </section>}

          {phase === 2 && <section className="section panel records" aria-label="Review records">
            <h2>Review records</h2>
            <details><summary>Workflow outcomes</summary><ul className="step-list">{steps.map(({ id, title }) => <li key={id}><span>{title}</span>
              <span>{job.steps[id] === "pending" ? "Not reported" : statusLabels[job.steps[id]]}</span></li>)}</ul></details>
            {job.campaign && <details><summary>Campaign manifest</summary><pre>{JSON.stringify(job.campaign, null, 2)}</pre></details>}
            {job.report && <details><summary>Full agent report</summary><pre>{job.report}</pre></details>}
            <div className="panel-footer"><a className="button secondary" href={`/api/jobs?id=${encodeURIComponent(job.id)}&audit=1`} download>Download audit log</a>
              <button type="button" onClick={() => {
                setSubmission(undefined); setPhotoId(undefined); setJobId(undefined); setFiles([]); setPdfPhotos([]); setError(""); closeFocus();
                window.history.replaceState(null, "", window.location.pathname);
              }}>Start a new review <span aria-hidden="true">→</span></button></div>
          </section>}
        </>}
        <dialog className="asset-dialog" ref={focusDialog} aria-labelledby="asset-title" onClose={closeFocus}
          onCancel={(event) => { event.preventDefault(); closeFocus(); }}>
          {selectedAsset && <div className="focus-layout">
            <div className="focus-image panel">
              {selectedAsset.url ? <AssetImage src={selectedAsset.url} alt={selectedAsset.label} size={selectedAsset.size} />
                : <p className="label muted">No verified preview</p>}
            </div>
            <div className="focus-copy panel">
              <div className="corners"><span className="label" data-status={selectedAsset.status}>{selectedAsset.status}</span><button type="button" className="secondary" onClick={closeFocus}>Close</button></div>
              <h2 id="asset-title">{selectedAsset.market} / {selectedAsset.version}</h2>
              <p className="label">{selectedAsset.channel} / {selectedAsset.size}</p>
              {version && <section className="copy-panel" aria-labelledby="copy-title">
                <div className="corners">
                  <h3 className="label" id="copy-title">Caption &amp; copy</h3>
                  {editableJob && <button type="button" disabled={saving} aria-expanded={editing === "copy"}
                    onClick={() => { setError(""); setEditor({ jobId: editableJob.id, versionId: version.id, mode: "copy" }); }}>Edit copy</button>}
                </div>
                {editing !== "copy" && <div className="asset-copy" lang={japanese}>
                  {version.headline && <p><strong>{version.headline}</strong></p>}
                  {version.body && <p>{version.body}</p>}
                  {version.cta && <p>{version.cta}</p>}
                  {!!version.detail_callouts.length && <ul>{version.detail_callouts.map((item, index) => <li key={index}>{item}</li>)}</ul>}
                </div>}
                {editableJob && editing && <form className="version-editor" key={editing} onSubmit={(event) => void submitRevision(event, editableJob, version, editing)}>
                  {editing === "copy" ? <>
                    <label>Headline<input name="headline" lang={japanese} defaultValue={version.headline} maxLength={2000} /></label>
                    <label>Caption / body<textarea ref={captionInput} name="body" lang={japanese} defaultValue={version.body} maxLength={2000} /></label>
                    <label>Call to action<input name="cta" lang={japanese} defaultValue={version.cta} maxLength={2000} /></label>
                    <label>Callouts, one per line<textarea name="callouts" lang={japanese} defaultValue={version.detail_callouts.join("\n")} /></label>
                  </> : <label>Copy or layout feedback<textarea name="feedback" maxLength={3000} required /></label>}
                  <label>Apply to<select name="scope" defaultValue="one">
                    <option value="one">This size only</option>
                    <option value="all">All sizes of this market and version</option>
                  </select></label>
                  <div className="actions"><button type="submit" disabled={saving}>{editing === "copy" ? "Save and rebuild preview" : "Send to ZooWork"}</button>
                    <button className="secondary" type="button" disabled={saving} onClick={() => setEditor(undefined)}>Cancel</button></div>
                </form>}
              </section>}
              {version?.english_back_translation && <div><h3 className="label">Back translation</h3><p>{version.english_back_translation}</p></div>}
              {version && <p className="label">Wordplay confidence / {version.irony_confidence}</p>}
              {selectedAsset.reason && <div><h3 className="label">{selectedAsset.editorialReview ? "What to review" : "Routing"}</h3><p>{selectedAsset.reason}</p></div>}
              {selectedAsset.ruleNote && <div><h3 className="label">Rule checks</h3><p>{selectedAsset.ruleNote}</p></div>}
              {editableJob && version && <>
                {!editing && <div className="actions"><button className="secondary" type="button" disabled={saving}
                  onClick={() => { setError(""); setEditor({ jobId: editableJob.id, versionId: version.id, mode: "feedback" }); }}>Request revision</button></div>}
                {selectedAsset.url && <div className="actions">
                  {!selectedAsset.editorialReview && <button type="button" disabled={saving || version.approval === "approved"}
                    onClick={() => void updateReview(editableJob, "approval", version.id, "approved")}>Approve</button>}
                  <button className="secondary" type="button" disabled={saving || version.approval === "rejected"}
                    onClick={() => void updateReview(editableJob, "approval", version.id, "rejected")}>Reject</button>
                  {version.approval !== "pending" && <button className="secondary" type="button" disabled={saving}
                    onClick={() => void updateReview(editableJob, "approval", version.id, "pending")}>Reset decision</button>}
                </div>}
              </>}
              {error && <p className="alert" role="alert">{error}</p>}
            </div>
          </div>}
        </dialog>
      </main>
      <footer className="page-footer label"><span>Campaign Localizer</span><span>Powered by ZooWork</span></footer>
    </div>
  );
}
