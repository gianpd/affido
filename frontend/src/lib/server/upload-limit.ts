import { formatBytes } from '#lib/format';

/**
 * The browser upload limit of PRD 0001 §4: 10 MiB.
 *
 * The sandbox enforces the same value in `agent/corpus.ts` (`MAX_UPLOAD_BYTES`).
 * Keep the two equal, otherwise a file the form accepts (or refuses) disagrees
 * with what the ingest endpoint can actually stage.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const MAX_UPLOAD_LABEL = formatBytes(MAX_UPLOAD_BYTES);

/** One message for both paths, the picked file and the pasted text. */
export const UPLOAD_TOO_LARGE = `The file is larger than ${MAX_UPLOAD_LABEL}.`;

/** Directory upload caps of PRD 0003 §6: one tree per request sequence, the
 * same per-file limit as a single upload. The upload action enforces them
 * during its staging loop; the sandbox enforces the per-file limit again. */
export const MAX_DIR_FILES = 200;
export const MAX_DIR_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_DIR_TOTAL_LABEL = formatBytes(MAX_DIR_TOTAL_BYTES);
