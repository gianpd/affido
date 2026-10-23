import MarkdownIt from 'markdown-it';

/**
 * One parser for agent answers. Raw HTML stays escaped (`html: false`), so
 * `{@html}` on the result cannot run markup a model copied out of a document.
 */
const markdown = new MarkdownIt({
	html: false,
	linkify: true,
	breaks: true
});

const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
	const token = tokens[index];
	if (token) {
		token.attrSet('target', '_blank');
		token.attrSet('rel', 'noopener noreferrer');
	}
	return defaultLinkOpen
		? defaultLinkOpen(tokens, index, options, env, renderer)
		: renderer.renderToken(tokens, index, options);
};

const BRACKET_GROUP = /\[([^[[\]]*cit_[0-9a-f]{6,}[^[[\]]*)\]/g;
const TOKEN = /cit_[0-9a-f]{6,}/g;

/**
 * Render `[cit_…]` tokens as numbered superscript references (RFC 0006 §5.7).
 * The numbers follow `citations`, the ordered id list from the message's
 * `data-citations` part, so a token without a citation cannot be numbered.
 * The bracket text itself survives markdown as plain text, so the substitution
 * runs on the rendered HTML and is the only markup added on top of markdown-it.
 */
export const renderCitationRefs = (html: string, citations: readonly string[]): string =>
	html.replace(BRACKET_GROUP, (_match, group: string) => {
		const tokens = [...String(group).matchAll(TOKEN)].map((match) => match[0]);
		const sups = tokens
			.map((token) => {
				const index = citations.indexOf(token);
				if (index === -1) return null; // unreported token: leave it unnumbered
				return `<sup class="citation-ref"><a href="#cite-${token}" data-citation="${token}" aria-label="Citation ${index + 1}">${index + 1}</a></sup>`;
			})
			.filter((sup): sup is string => sup !== null);
		return sups.length > 0 ? sups.join(' ') : `[${group}]`;
	});

export const renderMarkdown = (
	text: string,
	options?: { citations?: readonly string[] }
): string => {
	const html = markdown.render(text);
	return options?.citations === undefined ? html : renderCitationRefs(html, options.citations);
};
