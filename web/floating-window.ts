export type WindowSize = { width: number; height: number };
export type WindowPoint = { x: number; y: number };
export const defaultChatSize: WindowSize = { width: 440, height: 690 };

export function fitWindow(
  size: WindowSize,
  position: WindowPoint,
  viewport: WindowSize,
) {
  const maxWidth = Math.max(1, viewport.width - 24);
  const maxHeight = Math.max(1, viewport.height - 84);
  const boundedSize = {
    width: Math.max(Math.min(320, maxWidth), Math.min(size.width, maxWidth)),
    height: Math.max(
      Math.min(320, maxHeight),
      Math.min(size.height, maxHeight),
    ),
  };
  return {
    size: boundedSize,
    position: {
      x: Math.max(
        12,
        Math.min(position.x, viewport.width - boundedSize.width - 12),
      ),
      y: Math.max(
        12,
        Math.min(position.y, viewport.height - boundedSize.height - 72),
      ),
    },
  };
}

/** Move the selected edges while keeping the opposite corner anchored. */
export function resizeWindow(
  size: WindowSize,
  position: WindowPoint,
  delta: WindowPoint,
  left: boolean,
  viewport: WindowSize,
) {
  const fitted = fitWindow(size, position, viewport);
  const right = fitted.position.x + fitted.size.width;
  const maxWidth = Math.max(
    1,
    left ? right - 12 : viewport.width - fitted.position.x - 12,
  );
  const maxHeight = Math.max(1, viewport.height - fitted.position.y - 72);
  const bounded = {
    width: Math.max(
      Math.min(320, maxWidth),
      Math.min(fitted.size.width + (left ? -delta.x : delta.x), maxWidth),
    ),
    height: Math.max(
      Math.min(320, maxHeight),
      Math.min(fitted.size.height + delta.y, maxHeight),
    ),
  };
  return {
    size: bounded,
    position: {
      x: left ? right - bounded.width : fitted.position.x,
      y: fitted.position.y,
    },
  };
}
