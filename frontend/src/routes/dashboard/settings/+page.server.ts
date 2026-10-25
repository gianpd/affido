import { requireUser } from '#lib/server/auth-helpers';
import {
	ProviderError,
	providerCatalog,
	providerConfig,
	providerErrorMessage,
	type ProviderCatalog,
	type ProviderConfigView
} from '#lib/server/providers';
import type { PageServerLoad } from './$types';

/** The settings page (RFC 0012 §12.3): catalog and current state. The page
 * never receives an API key — the manager answers with fingerprints only. */
export const load: PageServerLoad = async (event) => {
	requireUser(event.locals, event.url);
	let catalog: ProviderCatalog | null = null;
	let config: ProviderConfigView | null = null;
	let error: string | null = null;
	try {
		[config, catalog] = await Promise.all([providerConfig(event), providerCatalog(event)]);
	} catch (cause) {
		// An unreachable manager (or a stack without the agent image) must not
		// break the page: the user sees the reason, and writes surface their own.
		error =
			cause instanceof ProviderError
				? providerErrorMessage(cause)
				: 'The provider catalog is unavailable.';
	}
	return {
		error,
		catalog: catalog ?? { version: 1, providers: [] },
		config: config ?? { selection: null, keys: [] }
	};
};
