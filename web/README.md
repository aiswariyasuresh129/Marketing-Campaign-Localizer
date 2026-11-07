# Campaign Localizer

A local Next.js and TypeScript interface for brand-agnostic campaign reviews. The server starts a non-interactive PowerShell 7 worker for each submitted photo. Each photo gets a separate review with the shared documents, private previews, approval decisions, and a downloadable ZIP.

## Run locally

From the repository root in PowerShell, run the launcher. It uses existing dependencies, starts in the correct directory, and can use the bundled Node.js and PowerShell runtimes when they are outside PATH.

```powershell
.\Start-CampaignLocalizer.ps1
```

Enter the ZooWork key at the hidden prompt and open [http://127.0.0.1:3000](http://127.0.0.1:3000). Keep the terminal open during reviews. The launcher defaults to this project's provisioned agent. To use a different agent or skip the prompt, configure `ZOOWORK_AGENT_ID` and `ZOOWORK_API_KEY` in the server environment or in an ignored `web/.env.local`. Set `ZOOWORK_PWSH` if the server needs a specific PowerShell 7 executable.

On a fresh checkout, install dependencies first with `npm ci` from the `web` folder using a Node.js installation that includes npm.

The app accepts DOCX, PDF, PNG, JPEG, GIF, and WebP without a workflow-level file-count cap. Image files each start one review. Mark a PDF as **Source photo** when it contains the intended image. The remaining documents are shared. Leave Markets and Launch date blank to use the brief.

The review shows ZooWork checkpoints, routing decisions and verified previews as they arrive. Open a frame in the campaign kit to inspect the copy, see cited rules, request a revision or make an approval decision. The app keeps raster key art in the ignored `web/.review-data/sources` directory so it can display the original upload when a review is reopened.

Edit the per-review instructions in `scripts/CampaignReviewPrompt.md`. The agent takes brand, market, color, copy, and format requirements from the supplied documents. Missing required HEX values hold only the affected versions.

## Match and audit

Register the review tools once for the agent from the repository root, using PowerShell 7. Pass `-AgentId` when using a different agent.

```powershell
.\Register-ZooWorkReviewTools.ps1
```

The app uses the bundled Node.js runtime's SQLite support and stores reservations and append-only audit events in the ignored `web/.review-data/reviews.sqlite` file. Keep that directory to retain history across app restarts. The worker reads ZooWork tool requests and sends them over its process pipes to the local app. It does not require a public callback or database server.

The app reserves eligible assets before rendering and verifies preview artifact IDs against the reserved ZooWork session and path. An identical eligible asset can reuse a ready preview. This does not clear an asset's creative, calendar, or format requirements. Download the recorded events as JSON from the results screen.

Approve or reject versions individually, then select **Create approved ZIP** for that photo. The local app creates the archive from verified PNGs and writes the final `manifest.json`. The approval list is locked once the ZIP is created. Held, pending, and rejected images are excluded.
