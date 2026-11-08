export function kitUiClass(classes: string): string {
  return typeof document !== 'undefined' && document.head?.querySelector('style[data-harness-ui]') ? classes : '';
}
