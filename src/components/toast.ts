const TOAST_DURATION = 3000;

let activeToast: HTMLElement | null = null;
let hideTimeout: ReturnType<typeof setTimeout> | null = null;

function dismiss(toast: HTMLElement): void {
  toast.classList.remove('visible');
  toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  if (activeToast === toast) activeToast = null;
}

/**
 * Show a toast notification. Pass an `action` to render an inline button
 * (used for the 5s delete-undo); the toast stays up for `duration`.
 */
export function showToast(
  message: string,
  type: 'info' | 'error' = 'info',
  action?: { label: string; onClick: () => void; duration?: number },
): void {
  // Remove existing toast
  if (activeToast) {
    activeToast.remove();
    if (hideTimeout) clearTimeout(hideTimeout);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      if (hideTimeout) clearTimeout(hideTimeout);
      dismiss(toast);
    });
    toast.appendChild(btn);
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  activeToast = toast;
  hideTimeout = setTimeout(() => dismiss(toast), action?.duration ?? TOAST_DURATION);
}
