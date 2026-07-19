const dialogFocusRestorers = new WeakMap<HTMLDialogElement, () => void>();

export function showModal(
  dialog: HTMLDialogElement,
  initialFocus?: HTMLElement | null,
  onCancel?: () => void,
  openerAction?: string | null,
): void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const stableOpenerAction = openerAction ?? opener?.dataset.action;
  const restoreFocus = (): void => {
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus();
      else if (stableOpenerAction) {
        document.querySelector<HTMLElement>(`[data-action="${stableOpenerAction}"]`)?.focus();
      }
    });
  };
  dialogFocusRestorers.set(dialog, restoreFocus);
  dialog.showModal();
  (initialFocus ?? firstFocusable(dialog))?.focus();
  dialog.addEventListener('cancel', (event) => {
    if (!onCancel) return;
    event.preventDefault();
    onCancel();
    restoreFocus();
  });
  dialog.addEventListener('close', restoreFocus, { once: true });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? current <= 0 ? focusable.length - 1 : current - 1
      : current >= focusable.length - 1 ? 0 : current + 1;
    event.preventDefault();
    focusable[next].focus();
  });
}

export function closeModal(dialog: HTMLDialogElement): void {
  const restoreFocus = dialogFocusRestorers.get(dialog);
  dialog.close();
  dialog.remove();
  restoreFocus?.();
  dialogFocusRestorers.delete(dialog);
}

function firstFocusable(dialog: HTMLDialogElement): HTMLElement | null {
  return focusableElements(dialog)[0] ?? null;
}

function focusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
}
