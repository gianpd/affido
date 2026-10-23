/**
 * Placement for the citation hover card (RFC 0006 §5.7): above the numbered
 * reference, below it when there is no room, horizontally clamped to the
 * viewport. Pure math over rects, so it is testable without a DOM.
 */

export type TooltipAnchorRect = {
	/** Anchor's top edge, viewport coordinates. */
	top: number;
	/** Anchor's bottom edge (`top + height`). */
	bottom: number;
	/** Anchor's horizontal center. */
	centerX: number;
};

export type TooltipSize = { width: number; height: number };
export type ViewportSize = { width: number; height: number };
export type TooltipPlacement = { top: number; left: number };

export const placeTooltip = (
	anchor: TooltipAnchorRect,
	size: TooltipSize,
	viewport: ViewportSize,
	{ gap = 6, margin = 8 }: { gap?: number; margin?: number } = {}
): TooltipPlacement => {
	const maxLeft = Math.max(margin, viewport.width - size.width - margin);
	const left = Math.min(Math.max(anchor.centerX - size.width / 2, margin), maxLeft);
	// Prefer above the anchor; flip below when the card would leave the viewport.
	const above = anchor.top - size.height - gap;
	return { top: above >= margin ? above : anchor.bottom + gap, left };
};
