#!/usr/bin/env node
// affido UI verification driver. Drives the real SvelteKit app at
// http://localhost:5173 with Playwright chromium and leaves screenshots +
// facts.json in --out. Invoked by .pi/skills/verify-affido-ui/SKILL.md;
// scenario semantics live in .pi/skills/verify-affido-ui/features/.
//
// Every interaction goes through the real UI (forms, buttons, links). Never
// call /api/* directly from here: the point is to prove the user path.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

const resolvePlaywright = () => {
	const candidates = [
		process.env.AFFIDO_FRONTEND,
		path.join(process.cwd(), 'node_modules'),
		path.join(process.cwd(), 'frontend', 'node_modules'),
		path.join(here, '..', '..', '..', 'frontend', 'node_modules')
	].filter(Boolean);
	for (const dir of candidates) {
		try {
			return createRequire(path.join(dir, 'package.json'))('playwright');
		} catch {
			// try next candidate
		}
	};
	console.error('cannot resolve playwright: run from the repo root or frontend/, or set AFFIDO_FRONTEND=<repo>/frontend');
	process.exit(2);
};

const { chromium } = resolvePlaywright();

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith('--'));
if (!scenario) {
	console.error('usage: drive.mjs <signup|login|chat|documents|skills|traces|uploads|logout> [--base URL] [--out DIR] [--state FILE] [--email E] [--password P] [--name N] [--prompt TXT]');
	process.exit(2);
}
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const base = flag('base', 'http://localhost:5173').replace(/\/$/, '');
const out = path.resolve(flag('out', 'verify-runs/adhoc'));
const stateFile = flag('state', '') ? path.resolve(flag('state', '')) : '';
fs.mkdirSync(out, { recursive: true });

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Prefer the run's own credentials (written by signup) so scenarios reusing
// state.json address the same user the cookie belongs to.
const credPath = path.join(out, 'credentials.json');
const cred = fs.existsSync(credPath) ? JSON.parse(fs.readFileSync(credPath, 'utf8')) : {};
const email = flag('email', cred.email ?? `verify-${runId}@affido.test`);
const password = flag('password', cred.password ?? `verify-${runId}-Passw0rd`);
const name = flag('name', cred.name ?? 'UI Verifier');
const prompt = flag('prompt', 'Reply with exactly: READY');
const installBudget = Number(flag('install-budget-ms', '1200000'));

const facts = {
	scenario,
	base,
	startedAt: new Date().toISOString(),
	email,
	url: null,
	title: null,
	steps: [],
	httpErrors: [],
	consoleErrors: [],
	networkFailures: []
};

let failed = null;
const fail = (step, error) => {
	failed = failed ?? { step, message: String(error.message ?? error) };
	console.error(`FAIL ${step}: ${String(error.message ?? error)}`);
};

const step = async (label, fn) => {
	const t0 = Date.now();
	try {
		await fn();
		facts.steps.push({ name: label, ms: Date.now() - t0 });
		console.log(`ok   ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
	} catch (error) {
		facts.steps.push({ name: label, ms: Date.now() - t0, error: String(error.message ?? error) });
		throw error;
	}
};

// ── browser ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	storageState: stateFile && fs.existsSync(stateFile) ? stateFile : undefined
});
context.setDefaultNavigationTimeout(120_000);
context.setDefaultTimeout(30_000);
const page = await context.newPage();

let shotNo = 0;
const shot = async (label) => {
	shotNo += 1;
	const file = path.join(out, `${String(shotNo).padStart(2, '0')}-${label}.png`);
	await page.screenshot({ path: file, fullPage: true });
	// Text twin: the page's visible text, so the evidence is checkable even
	// without image reading. Vision agents read the PNG; others read this.
	const text = await page.locator('body').innerText().catch(() => '');
	fs.writeFileSync(`${file.slice(0, -4)}.txt`, text);
	console.log(`shot ${path.relative(process.cwd(), file)}`);
};

page.on('console', (msg) => {
	if (msg.type() === 'error') facts.consoleErrors.push(msg.text().slice(0, 500));
});
page.on('pageerror', (error) => facts.consoleErrors.push(`pageerror: ${String(error)}`.slice(0, 500)));
page.on('requestfailed', (request) => {
	const url = request.url();
	if (url.includes('favicon')) return;
	facts.networkFailures.push(`${request.failure()?.errorText ?? 'failed'} ${url}`.slice(0, 300));
});
page.on('response', (response) => {
	if (response.status() >= 400) {
		facts.httpErrors.push(`${response.status()} ${response.url()}`.slice(0, 300));
	}
});

const url = (p) => `${base}${p}`;

// ── auth helpers ────────────────────────────────────────────────────────────
const doSignup = async () => {
	await page.goto(url('/login'));
	const form = page.locator('form[action*="signUp"]');
	// The tab click can land pre-hydration and do nothing; wait for the
	// target form to actually become visible before filling.
	await page.getByRole('tab', { name: 'Create account' }).click();
	await form.waitFor({ state: 'visible' });
	await form.getByLabel('Name', { exact: true }).fill(name);
	await form.getByLabel('Email', { exact: true }).fill(email);
	await form.getByLabel('Password', { exact: true }).fill(password);
	await form.locator('button[type="submit"]').click();
	await page.waitForURL(/\/dashboard(\?.*)?$/);
	fs.writeFileSync(path.join(out, 'credentials.json'), JSON.stringify({ email, password, name, createdAt: facts.startedAt }, null, '\t'));
};

const doLogin = async () => {
	await page.goto(url('/login'));
	const form = page.locator('form[action*="signIn"]');
	await form.waitFor({ state: 'visible' });
	await form.getByLabel('Email', { exact: true }).fill(email);
	await form.getByLabel('Password', { exact: true }).fill(password);
	await form.locator('button[type="submit"]').click();
	await page.waitForURL(/\/dashboard(\?.*)?$/);
};

const saveState = async () => {
	await context.storageState({ path: path.join(out, 'state.json') });
};

// Signs in when there is no storage state. Redirected to /login?next= means
// the stored session is gone: fall back to the credentials form.
const ensureAuthed = async () => {
	await page.goto(url('/dashboard'));
	if (!page.url().includes('/login')) return;
	if (!stateFile) throw new Error('no --state and not logged in: run the signup scenario first');
	await doLogin();
};

// ── scenarios ───────────────────────────────────────────────────────────────
const scenarios = {
	signup: async () => {
		await step('signup form submits and lands on /dashboard', doSignup);
		await step('save session state', saveState);
		await step('dashboard renders sidebar', async () => {
			await page.getByRole('link', { name: 'Chat', exact: true }).waitFor();
			await shot('dashboard-after-signup');
		});
	},

	login: async () => {
		await step('signin form submits and lands on /dashboard', doLogin);
		await step('save session state', saveState);
		await shot('dashboard-after-login');
	},

	chat: async () => {
		await step('open chat authenticated', ensureAuthed);
		const composer = page.getByPlaceholder('Ask your agent…');
		await step('wait for sandbox to be reachable (first prompt provisions it)', async () => {
			for (let i = 0; i < 50; i += 1) {
				await page.goto(url('/dashboard/chat'));
				if (await composer.isEnabled()) return;
				await page.waitForTimeout(3000);
			}
			throw new Error('composer still disabled: sandbox unreachable after 150s');
		});
		await shot('chat-composer-ready');
		await step('send prompt', async () => {
			await composer.fill(prompt);
			await page.getByRole('button', { name: 'Send message' }).click();
		});
		await step('wait for the agent run to finish', async () => {
			const stop = page.getByRole('button', { name: 'Stop generating' });
			await stop.waitFor({ timeout: 20_000 }).catch(() => {}); // a fast faux reply may skip the stop state
			await stop.waitFor({ state: 'detached', timeout: 300_000 });
			await page.getByText('Agent is working in its sandbox').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
			await page.waitForTimeout(1000); // let the stream settle
		});
		await step('screenshot the conversation', async () => {
			await shot('chat-reply');
		});
		await step('a trace row exists for the prompt', async () => {
			await page.goto(url('/dashboard/traces'));
			const rows = page.locator('a[href^="/dashboard/traces/"]');
			const count = await rows.count();
			if (count === 0) throw new Error('no trace session rows on /dashboard/traces');
			await shot('traces-after-chat');
			await rows.first().click();
			await page.waitForURL(/\/dashboard\/traces\/[^/]+/);
			await shot('trace-detail');
		});
	},

	documents: async () => {
		await step('open documents authenticated', ensureAuthed);
		const title = `Verify note ${runId}`;
		await step('create document through the form', async () => {
			await page.goto(url('/dashboard/documents?new=1'));
			await page.getByLabel('Title', { exact: true }).fill(title);
			await page
				.getByLabel('Paste text')
				.fill('Affido verification note. The quick brown fox jumps over the lazy dog.');
			await page.getByRole('button', { name: 'Save document' }).click();
			await page.waitForURL(/\/dashboard\/documents(\?.*)?$/);
		});
		await step('document appears in the list', async () => {
			await page.getByText(title, { exact: true }).first().waitFor();
			await shot('documents-list');
		});
		await step('document detail dialog opens', async () => {
			// The detail is a modal dialog (Dialog.Root on data.selected), not a
			// navigation: once it opens it intercepts pointer events, so bound the
			// click and assert on the dialog instead.
			await page.getByText(title, { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
			await page.getByRole('dialog').waitFor({ state: 'visible' });
			await page.getByRole('dialog').getByText(title).waitFor();
			await shot('documents-detail');
		});
	},

	skills: async () => {
		await step('open skills authenticated', ensureAuthed);
		await step('marketplace renders', async () => {
			await page.goto(url('/dashboard/skills'));
			await page.getByText('Marketplace').first().waitFor();
			await shot('skills-marketplace');
		});
		const install = page.getByRole('button', { name: 'Install', exact: true }).first();
		if ((await install.count()) === 0) {
			facts.steps.push({ name: 'marketplace has no installable skill', ms: 0 });
			return;
		}
		const badge = () => page.getByText(/^Installed( v[\w.-]+)?$/).first();
		await step('install the first skill and wait for the Installed badge', async () => {
			await install.click();
			// The in-page fetch can hang when the sandbox provisions mid-install
			// (observed: docker network churn breaks the stream). Poll ground
			// truth instead: reload and read the card's installed state.
			const deadline = Date.now() + installBudget; // cold installs measured at 15-20+ min
			let visible = false;
			while (Date.now() < deadline) {
				try {
					await badge().waitFor({ timeout: 30_000 });
					visible = true;
					break;
				} catch {
					await page.goto(url('/dashboard/skills'));
				}
			}
			if (!visible)
				throw new Error(
					`skill not Installed after ${Math.round(installBudget / 60000)} min. ` +
						'Files usually land in the sandbox within seconds; the install POST itself hangs. ' +
						'Check: docker exec oltp psql -U pi -d pi -c \'select * from sandbox_registry\', ' +
						'docker logs <sandbox container>, and whether the badge appears on a later reload.'
				);
			await page.waitForTimeout(1000);
			await shot('skills-installed');
		});
	},

	traces: async () => {
		await step('open traces authenticated', ensureAuthed);
		await step('traces page renders', async () => {
			await page.goto(url('/dashboard/traces'));
			await page.getByText('Traces', { exact: false }).first().waitFor();
			await shot('traces-page');
		});
		const rows = page.locator('a[href^="/dashboard/traces/"]');
		const count = await rows.count();
		facts.steps.push({ name: `trace sessions listed: ${count}`, ms: 0 });
		if (count > 0) {
			await step('open first trace session detail', async () => {
				await rows.first().click();
				await page.waitForURL(/\/dashboard\/traces\/[^/]+/);
				await shot('trace-detail');
			});
		}
	},

	uploads: async () => {
		await step('open uploads authenticated', ensureAuthed);
		await step('uploads page renders', async () => {
			await page.goto(url('/dashboard/uploads'));
			await page.getByText('uploads/', { exact: false }).first().waitFor();
			await shot('uploads-page');
		});
	},

	logout: async () => {
		await step('open dashboard authenticated', ensureAuthed);
		await step('sign out from the user menu', async () => {
			await page.goto(url('/dashboard'));
			// The trigger needs Svelte hydration: a click swallowed pre-hydration
			// does nothing, so poll and re-click until the menu actually opens.
			const trigger = page.locator('[data-sidebar="footer"] button').first();
			for (let i = 0; i < 5 && (await page.locator('[role="menu"]').count()) === 0; i += 1) {
				await trigger.click();
				await page.waitForTimeout(2000);
			}
			await page.getByText('Sign out', { exact: true }).click();
			await page.waitForURL(/\/login/);
			await shot('after-signout');
		});
		await step('dashboard now requires login', async () => {
			await page.goto(url('/dashboard'));
			await page.waitForURL(/\/login/);
		});
	}
};

// ── run ─────────────────────────────────────────────────────────────────────
try {
	if (!scenarios[scenario]) throw new Error(`unknown scenario '${scenario}'`);
	await scenarios[scenario]();
} catch (error) {
	fail(error.step ?? scenario, error);
} finally {
	facts.url = page.url();
	facts.title = await page.title().catch(() => null);
	fs.writeFileSync(path.join(out, `facts-${scenario}.json`), JSON.stringify(facts, null, '\t'));
	await browser.close();
}

if (failed) process.exit(1);
console.log(`PASS ${scenario} -> ${path.relative(process.cwd(), out)}`);
