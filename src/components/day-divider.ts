import { formatDayLabel } from '../utils/format';
import { escapeHtml } from '../utils/storage';

/** Mono-caps date chip between day groups. */
export function renderDayDivider(ts: number): string {
  return `
    <div class="day-divider" role="separator">
      <span class="day-divider-chip">${escapeHtml(formatDayLabel(ts))}</span>
    </div>
  `;
}
