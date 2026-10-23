const utcDate = new Intl.DateTimeFormat('en-GB', {
	dateStyle: 'medium',
	timeStyle: 'short',
	timeZone: 'UTC'
});

/** Deterministic on server and client: always UTC. */
export const formatDate = (value: Date | string | number | null | undefined): string => {
	if (value === null || value === undefined) return '—';
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	return `${utcDate.format(date)} UTC`;
};

export const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
};

export const formatNumber = (value: number): string =>
	new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);

export const formatCost = (value: number): string => {
	if (!Number.isFinite(value) || value <= 0) return '$0.00';
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
};

export const shortId = (value: string, length = 8): string =>
	value.length <= length ? value : value.slice(0, length);
