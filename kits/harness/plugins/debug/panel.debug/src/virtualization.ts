export const ROW_HEIGHT = 38;
export const OVERSCAN = 8;

export type VirtualWindow = {
  start: number;
  end: number;
  top: number;
  bottom: number;
};

export type RowHeightMap = Map<string, number>;

export function getVirtualWindow(
  messages: { id: string }[],
  scrollTop: number,
  viewportHeight: number,
  rowHeights: RowHeightMap,
  estimatedRowHeight = ROW_HEIGHT,
  overscan = OVERSCAN,
): VirtualWindow {
  const total = messages.length;
  if (total <= 0) return { start: 0, end: 0, top: 0, bottom: 0 };

  const heightAt = (index: number): number =>
    rowHeights.get(messages[index].id) ?? estimatedRowHeight;

  let offset = 0;
  let firstVisible = total;
  for (let index = 0; index < total; index += 1) {
    const rowBottom = offset + heightAt(index);
    if (rowBottom > scrollTop) {
      firstVisible = index;
      break;
    }
    offset = rowBottom;
  }
  if (firstVisible === total) firstVisible = total - 1;

  const start = Math.max(0, firstVisible - overscan);

  let top = 0;
  for (let index = 0; index < start; index += 1) {
    top += heightAt(index);
  }

  let end = start;
  let endOffset = top;
  const viewportBottom = scrollTop + viewportHeight;
  for (let index = start; index < total; index += 1) {
    if (endOffset >= viewportBottom) {
      end = index;
      break;
    }
    endOffset += heightAt(index);
    end = index + 1;
  }
  end = Math.min(total, end + overscan);

  let bottom = 0;
  for (let index = end; index < total; index += 1) {
    bottom += heightAt(index);
  }

  return { start, end, top, bottom };
}

export function shouldFollowLatest(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 12,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold;
}
