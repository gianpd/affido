// Minimal pi-durable agent inside a container.
//
// It performs five operations:
//   - navigate files in its own workspace       (CodingTools + GET /files, GET /file)
//   - stage uploaded documents in the workspace (POST /ingest, GET /raw, DELETE /ingest)
//   - resume previous sessions                  (SQLite storage + Harness.root + resume())
//   - be paused when idle                       (close the Harness after IDLE_MS without requests)
//   - be activated when called                  (reopen the Harness on the next request)
//
// The storage file and workspace live on volumes, so pause, restart, and reactivation
// all bring back the same root conversation. /health and /status never activate.
//
// The server is assembled from five pieces:
//   - HarnessLifecycle  the durable lifecycle (open, resume, pause) as an interface
//   - DurableHarness    the pi-durable implementation of that interface (harness.ts)
//   - AgentApi          the agent surface the HTTP tools depend on (types.ts)
//   - ContainerAgent    one container's model, registry, workspace, and conversation (agent.ts)
//   - HttpTool          one HTTP operation: a method, a path, and a handler (tools.ts)
//
// This file is the bootstrap: it reads the environment, builds the agent, routes
// each request to the first matching HttpTool, and owns the process lifecycle.

import { createServer } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ContainerAgent } from "./agent.ts";
import { json, HttpError, RawResponse } from "./http.ts";
import { createModel } from "./model.ts";
import { IngestPipeline } from "./ingest.ts";
import {
	ArtifactTool,
	CitationsTool,
	ConfigTool,
	CreateUploadDirTool,
	DeleteArtifactsTool,
	DeleteRawTool,
	DeleteSkillTool,
	DeleteUploadTool,
	DerivedTextTool,
	EntryTool,
	HealthTool,
	HttpTool,
	IngestRawTool,
	InspectTool,
	ListArtifactsTool,
	ListFilesTool,
	ListSkillsTool,
	ListUploadsTool,
	NewSessionTool,
	PauseTool,
	PromptTool,
	RawFileTool,
	ReadFileTool,
	ResetTool,
	SessionTool,
	SkillsFileTool,
	StatusTool,
	SwitchSessionTool,
	UploadFileTool,
	VerifySkillTool,
	WebConfigTool,
} from "./tools.ts";
import type { CitationMode, Log } from "./types.ts";

const context = BACKGROUND_CONTEXT;
const AGENT = process.env.AGENT_NAME ?? "agent";
const WORKSPACE = process.env.WORKSPACE ?? "/workspace";
const SESSION_DB = process.env.SESSION_DB ?? "/data/session.sqlite";
const IDLE_MS = Number(process.env.IDLE_MS ?? 5000);
const PORT = Number(process.env.PORT ?? 8080);

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `undefined` when unset: the runtime then keeps its own default, `off`. */
const parseThinkingLevel = (raw: string | undefined): ModelThinkingLevel | undefined => {
	if (raw === undefined || raw === "") return undefined;
	const level = THINKING_LEVELS.find((candidate) => candidate === raw);
	if (level === undefined) throw new Error(`THINKING_LEVEL must be one of ${THINKING_LEVELS.join(", ")}`);
	return level;
};

/** RFC 0006 §5.9: the mode of `/prompt` requests that omit the `citations` field. */
const parseCitationsDefault = (raw: string | undefined): CitationMode => {
	if (raw === undefined || raw === "") return "off";
	if (raw !== "required" && raw !== "off") throw new Error('CITATIONS_DEFAULT must be "required" or "off"');
	return raw;
};

const log: Log = (...args) => console.log(`[${AGENT}]`, ...args);

const { models, credentials, model } = await createModel();
const agent = new ContainerAgent({
	name: AGENT,
	workspace: WORKSPACE,
	sessionDb: SESSION_DB,
	idleMs: IDLE_MS,
	models,
	credentials,
	model,
	thinkingLevel: parseThinkingLevel(process.env.THINKING_LEVEL),
	citationsDefault: parseCitationsDefault(process.env.CITATIONS_DEFAULT),
	context,
	log,
});

// One pipeline for every staging and deletion entry point (RFC 0014 R1).
const pipeline = new IngestPipeline(WORKSPACE);

const tools: HttpTool[] = [
	new HealthTool(),
	new StatusTool(),
	new SessionTool(),
	new InspectTool(),
	new EntryTool(),
	new ListFilesTool(),
	new ReadFileTool(),
	new IngestRawTool(pipeline),
	new RawFileTool(),
	new DerivedTextTool(),
	new CitationsTool(),
	new DeleteRawTool(pipeline),
	new CreateUploadDirTool(WORKSPACE),
	new UploadFileTool(pipeline),
	new ListUploadsTool(WORKSPACE),
	new DeleteUploadTool(pipeline),
	new SkillsFileTool(WORKSPACE),
	new ListSkillsTool(WORKSPACE),
	new VerifySkillTool(WORKSPACE),
	new DeleteSkillTool(WORKSPACE),
	new ListArtifactsTool(WORKSPACE),
	new ArtifactTool(WORKSPACE),
	new DeleteArtifactsTool(WORKSPACE),
	new PromptTool(),
	new ConfigTool(),
	new WebConfigTool(),
	new NewSessionTool(),
	new SwitchSessionTool(),
	new ResetTool(),
	new PauseTool(),
];

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		const tool = tools.find((candidate) => candidate.matches(req.method ?? "", url.pathname));
		if (tool === undefined) return json(res, 404, { error: "not found" });
		const result = await tool.handle({ req, url, agent });
		// A download is written verbatim (RFC 0009 §5.6); everything else is JSON.
		if (result instanceof RawResponse) {
			res.writeHead(result.status, result.headers);
			res.end(result.body);
			return;
		}
		json(res, 200, result);
	} catch (error) {
		if (error instanceof HttpError) return json(res, error.status, error.body);
		const message = error instanceof Error ? error.message : String(error);
		log("request failed:", message);
		json(res, 500, { error: message });
	}
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		log(`received ${signal}, closing`);
		agent
			.close()
			.catch((error: unknown) => log("close failed:", error))
			.finally(() => process.exit(0));
	});
}

await agent.seedWorkspace();
server.listen(PORT, "0.0.0.0", () => log(`listening on :${PORT}, workspace ${WORKSPACE}, idle ${IDLE_MS}ms`));
