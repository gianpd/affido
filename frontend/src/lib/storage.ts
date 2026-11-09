/** Pure projections of `GET /storage` (RFC 0022). The pie chart and the alert
 * are derived from the sandbox report, with no sandbox access from the browser. */
import type { StorageReport } from './types';

export type StorageAlert = { title: string; description: string };

/** Fraction of the quota already used, clamped to [0, 1]. */
export const storageUsedFraction = (report: StorageReport): number => {
	const quota = Math.max(report.quotaBytes, 1);
	const used = Math.min(Math.max(report.usedBytes, 0), quota);
	return used / quota;
};

/** One pie wedge between two fractions of the circle, starting at 12 o'clock.
 * Only wedges smaller than the full circle are drawn: 0% and 100% are a circle
 * in the caller, because an SVG arc cannot close a 360-degree sweep. */
export const pieSlice = (start: number, end: number): string => {
	const point = (fraction: number) => {
		const angle = 2 * Math.PI * fraction - Math.PI / 2;
		return { x: Math.cos(angle), y: Math.sin(angle) };
	};
	const first = point(start);
	const last = point(end);
	const large = end - start > 0.5 ? 1 : 0;
	return `M 0 0 L ${first.x.toFixed(5)} ${first.y.toFixed(5)} A 1 1 0 ${large} 1 ${last.x.toFixed(5)} ${last.y.toFixed(5)} Z`;
};

/** Token of the used wedge: the destructive tone once the alert is critical. */
export const storageUsedColor = (report: StorageReport): string =>
	report.state === 'critical' || report.state === 'full' ? 'var(--destructive)' : 'var(--chart-1)';

/** The UI alert. `ok` shows no alert; the other three states tell the user what
 * to delete, because the sandbox refuses writes with 507 when it is full. */
export const storageAlert = (report: StorageReport): StorageAlert | null => {
	switch (report.state) {
		case 'full':
			return {
				title: 'Storage quota reached',
				description:
					'The agent has no space left. Uploads and model writes are refused (507) until you delete documents, uploads or artifacts.'
			};
		case 'critical':
			return {
				title: 'Storage almost full',
				description:
					'Less than 5% of the agent quota is left. Delete files before the agent refuses new writes.'
			};
		case 'warning':
			return {
				title: 'Storage is filling up',
				description:
					'More than 80% of the agent quota is used. Review documents, uploads and artifacts.'
			};
		default:
			return null;
	}
};

/** True when the host filesystem, not the logical quota, is the binding limit. */
export const hostIsBinding = (report: StorageReport): boolean =>
	report.hostFreeBytes !== null &&
	report.hostFreeBytes < Math.max(0, report.quotaBytes - report.usedBytes);
