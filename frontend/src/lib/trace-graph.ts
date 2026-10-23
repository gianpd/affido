import type { TraceEntry, TraceReport } from '#lib/types';

/**
 * Pure projection of a stored trace report into a decision graph: entries
 * become nodes in swimlanes (user / agent / tools / context) and the semantic
 * transitions between them become labelled edges (verbs). Everything here is
 * derived from the snapshot alone — no sandbox access — so the graph renders
 * offline and stays reproducible.
 */

export type Lane = 'user' | 'agent' | 'tool' | 'context';

export type GraphNode = {
	key: string;
	entryId: number;
	lane: Lane;
	title: string;
	sub: string;
	x: number;
	y: number;
	isDecision: boolean;
	isError: boolean;
	isFinal: boolean;
	isContextCut: boolean;
	/** Call node: index of this call within its assistant entry's calls. */
	callIndex?: number;
	/** Call node: the entry id of the tool result that answered it, once paired. */
	resultEntryId?: number;
	/** Result node: the assistant entry that made the call, and which call it was. */
	callEntryId?: number;
};

/** The verb of one transition: what the agent (or the user) did to get there. */
export type Verb =
	'prompt' | 'call' | 'ran' | 'failed' | 'observed' | 'answer' | 'context' | 'next';

export type GraphEdge = { key: string; from: string; to: string; verb: Verb };

export type DecisionGraph = {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** Alternating background bands, one per user turn. */
	bands: { y: number; height: number; turn: number }[];
	lanes: Record<Lane, number>;
	width: number;
	height: number;
	byKey: Map<string, GraphNode>;
	total: number;
	truncatedBy: number;
};

export type DecisionSummary = {
	turns: number;
	decisionTurns: number;
	calls: number;
	errors: number;
	avgCallsPerDecision: number;
	ranking: { tool: string; calls: number; errors: number }[];
};

export const MAX_GRAPH_ENTRIES = 150;

export const NODE_W = 150;
export const NODE_H = 42;
export const ROW_H = 80;
export const TOP = 28;
export const LANE_X: Record<Lane, number> = { user: 40, agent: 260, tool: 540, context: 900 };
export const CONTEXT_W = 190;

/** Presentational mapping kept next to the verbs so the legend cannot drift. */
export const VERB_STROKE: Record<Verb, string> = {
	prompt: 'stroke-blue-400',
	call: 'stroke-amber-500',
	ran: 'stroke-emerald-500',
	failed: 'stroke-red-500',
	observed: 'stroke-violet-400',
	answer: 'stroke-teal-500',
	context: 'stroke-muted-foreground',
	next: 'stroke-border'
};

export const VERB_LABEL: Record<Verb, string> = {
	prompt: 'prompt',
	call: 'calls',
	ran: 'ran',
	failed: 'failed',
	observed: 'observed',
	answer: 'answer',
	context: 'context',
	next: 'next'
};

export const clip = (text: string, max: number): string =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

type Role = 'user' | 'assistant' | 'toolResult' | 'system' | 'other';

/** Old snapshots carry no `role`/`tools`: recover the role from the entry kind. */
const roleOf = (entry: TraceEntry): Role => {
	if (entry.role) return entry.role;
	switch (entry.kind) {
		case 'pi.user':
			return 'user';
		case 'pi.assistant':
			return 'assistant';
		case 'pi.tool-result':
			return 'toolResult';
		case 'pi.system':
			return 'system';
		default:
			return 'other';
	}
};

/** Old snapshots embed decisions in the summary as `tool:<name>` markers. */
export const toolsOf = (entry: TraceEntry): string[] => {
	if (entry.tools && entry.tools.length > 0) return [...entry.tools];
	const markers = entry.summary.match(/\btool:([\w.-]+)/g) ?? [];
	return markers.map((marker) => marker.slice('tool:'.length));
};

const oldestFirst = (report: TraceReport): TraceEntry[] =>
	[...report.entries.items].sort((a, b) => a.id - b.id);

export const buildDecisionGraph = (report: TraceReport): DecisionGraph => {
	const entries = oldestFirst(report).slice(-MAX_GRAPH_ENTRIES);
	const truncatedBy =
		report.entries.items.length - Math.min(report.entries.items.length, MAX_GRAPH_ENTRIES);

	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const incoming = new Set<string>();

	let lastUser: GraphNode | undefined;
	let lastFinal: GraphNode | undefined;
	const pendingCalls: { node: GraphNode; tool: string }[] = [];
	let unobservedResults: GraphNode[] = [];
	let prevAnchor: GraphNode | undefined;
	let turn = 0;
	let maxParallel = 1;
	const turnOf = new Map<number, number>();

	const addEdge = (from: GraphNode, to: GraphNode, verb: Verb) => {
		edges.push({ key: `${from.key}->${to.key}:${verb}`, from: from.key, to: to.key, verb });
		incoming.add(to.key);
	};

	entries.forEach((entry, index) => {
		const y = TOP + index * ROW_H;
		const role = roleOf(entry);
		if (role === 'user') turn++;
		turnOf.set(entry.id, turn);

		const base = {
			key: `e${entry.id}`,
			entryId: entry.id,
			y,
			isDecision: false,
			isError: false,
			isFinal: false,
			isContextCut: false
		};

		if (role === 'user') {
			const node: GraphNode = {
				...base,
				lane: 'user',
				title: clip(entry.summary || 'user', 26),
				sub: `#${entry.id} prompt`,
				x: LANE_X.user
			};
			nodes.push(node);
			if (lastFinal) addEdge(lastFinal, node, 'answer');
			lastUser = node;
			lastFinal = undefined;
		} else if (role === 'assistant') {
			const tools = toolsOf(entry);
			const node: GraphNode = {
				...base,
				lane: 'agent',
				title: entry.model ?? 'assistant',
				sub:
					tools.length > 0
						? `${tools.length} call${tools.length > 1 ? 's' : ''}`
						: (entry.stopReason ?? 'reply'),
				x: LANE_X.agent,
				isDecision: tools.length > 0,
				isFinal: tools.length === 0
			};
			nodes.push(node);
			if (lastUser) {
				addEdge(lastUser, node, 'prompt');
				lastUser = undefined;
			}
			for (const result of unobservedResults) addEdge(result, node, 'observed');
			unobservedResults = [];
			if (tools.length === 0) {
				lastFinal = node;
			} else {
				maxParallel = Math.max(maxParallel, tools.length);
				tools.forEach((tool, callIndex) => {
					const call: GraphNode = {
						key: `c${entry.id}-${callIndex}`,
						entryId: entry.id,
						lane: 'tool',
						title: tool,
						sub: `call #${entry.id}`,
						x: LANE_X.tool + callIndex * (NODE_W + 24),
						y,
						isDecision: true,
						isError: false,
						isFinal: false,
						isContextCut: false,
						callIndex
					};
					nodes.push(call);
					addEdge(node, call, 'call');
					pendingCalls.push({ node: call, tool });
				});
			}
		} else if (role === 'toolResult') {
			const matched = pendingCalls.shift();
			const node: GraphNode = {
				...base,
				lane: 'tool',
				title: entry.toolName ?? matched?.tool ?? 'result',
				sub: entry.isError
					? 'error'
					: entry.durationMs !== undefined
						? `${entry.durationMs} ms`
						: `#${entry.id}`,
				x: matched ? matched.node.x : LANE_X.tool,
				isError: entry.isError === true
			};
			nodes.push(node);
			if (matched) {
				addEdge(matched.node, node, entry.isError ? 'failed' : 'ran');
				// Record the pairing so the panel can show the call's params next to its result.
				matched.node.resultEntryId = entry.id;
				node.callEntryId = matched.node.entryId;
				node.callIndex = matched.node.callIndex;
			}
			unobservedResults.push(node);
		} else {
			const node: GraphNode = {
				...base,
				lane: 'context',
				title: clip(entry.kind.replace(/^pi\./, ''), 22),
				sub: clip(entry.summary || `#${entry.id}`, 30),
				x: LANE_X.context,
				isContextCut: true
			};
			nodes.push(node);
		}

		const anchor = nodes[nodes.length - 1];
		if (prevAnchor && anchor && !incoming.has(anchor.key)) addEdge(prevAnchor, anchor, 'next');
		if (anchor) prevAnchor = anchor;
	});

	// Turn bands: one background band per contiguous user-turn row range.
	const bands: { y: number; height: number; turn: number }[] = [];
	for (let i = 0; i < entries.length; i++) {
		const current = turnOf.get(entries[i]!.id) ?? 0;
		const start = i;
		while (i + 1 < entries.length && (turnOf.get(entries[i + 1]!.id) ?? 0) === current) i++;
		bands.push({
			y: TOP + start * ROW_H - NODE_H / 2 - 6,
			height: (i - start + 1) * ROW_H,
			turn: current
		});
	}

	// Parallel calls extend the tool lane to the right; the context lane starts after them.
	const lanes: Record<Lane, number> = {
		...LANE_X,
		context: Math.max(LANE_X.context, LANE_X.tool + maxParallel * (NODE_W + 24) + 40)
	};
	for (const node of nodes) if (node.lane === 'context') node.x = lanes.context;

	const width = Math.max(...nodes.map((node) => node.x + NODE_W), lanes.context + CONTEXT_W);
	const height = TOP + entries.length * ROW_H + NODE_H;

	return {
		nodes,
		edges,
		bands,
		lanes,
		width,
		height,
		byKey: new Map(nodes.map((node) => [node.key, node])),
		total: report.entries.items.length,
		truncatedBy
	};
};

export const summarizeDecisions = (report: TraceReport): DecisionSummary => {
	const entries = oldestFirst(report);
	let turns = 0;
	let decisionTurns = 0;
	let calls = 0;
	let errors = 0;
	const perTool = new Map<string, { calls: number; errors: number }>();
	for (const entry of entries) {
		const role = roleOf(entry);
		if (role === 'user') turns++;
		if (role === 'assistant') {
			const tools = toolsOf(entry);
			if (tools.length > 0) {
				decisionTurns++;
				calls += tools.length;
			}
		}
		if (role === 'toolResult') {
			const tool = entry.toolName ?? 'result';
			const stat = perTool.get(tool) ?? { calls: 0, errors: 0 };
			stat.calls++;
			if (entry.isError) {
				stat.errors++;
				errors++;
			}
			perTool.set(tool, stat);
		}
	}
	return {
		turns,
		decisionTurns,
		calls,
		errors,
		avgCallsPerDecision: decisionTurns === 0 ? 0 : calls / decisionTurns,
		ranking: [...perTool.entries()]
			.map(([tool, stat]) => ({ tool, ...stat }))
			.sort((a, b) => b.calls - a.calls)
	};
};

/** Label each captured session with its position in its conversation's capture history (1 = newest). */
export const captureOrdinals = (
	sessions: { id: string; conversationId: number }[]
): Record<string, string> => {
	const seen: Record<number, number> = {};
	const total: Record<number, number> = {};
	for (const session of sessions)
		total[session.conversationId] = (total[session.conversationId] ?? 0) + 1;
	const out: Record<string, string> = {};
	for (const session of sessions) {
		const next = (seen[session.conversationId] ?? 0) + 1;
		seen[session.conversationId] = next;
		out[session.id] = `${next}/${total[session.conversationId]}`;
	}
	return out;
};
