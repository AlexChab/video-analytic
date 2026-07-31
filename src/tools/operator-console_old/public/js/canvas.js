import { getObjectAtPoint, getObjectId } from './renderer.js';

/** Пересчитывает координаты браузера в координаты исходного видеокадра. */
export function eventToFramePoint(event, canvas, frameWidth, frameHeight) {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight);
  const displayedWidth = frameWidth * scale;
  const displayedHeight = frameHeight * scale;
  const offsetX = (rect.width - displayedWidth) / 2;
  const offsetY = (rect.height - displayedHeight) / 2;

  const localX = event.clientX - rect.left - offsetX;
  const localY = event.clientY - rect.top - offsetY;

  if (localX < 0 || localY < 0 || localX > displayedWidth || localY > displayedHeight) {
    return null;
  }

  return {
    x: Math.max(0, Math.min(frameWidth - 1, Math.round(localX / scale))),
    y: Math.max(0, Math.min(frameHeight - 1, Math.round(localY / scale)))
  };
}

/** Подключает события Canvas, не выполняя HTTP-запросы напрямую. */
export function bindCanvas({ canvas, state, onSelectPoint, onSelectObject, onPointerChange, onRender }) {
  canvas.addEventListener('mousemove', (event) => {
    const point = eventToFramePoint(
      event,
      canvas,
      state.config.frameWidth,
      state.config.frameHeight
    );

    state.pointer = point;
    state.hoveredObjectId = null;

    if (point && state.selectionMode === 'ID') {
      state.hoveredObjectId = getObjectId(getObjectAtPoint(state.objects, point.x, point.y));
    }

    onPointerChange(point);
    onRender();
  });

  canvas.addEventListener('mouseleave', () => {
    state.pointer = null;
    state.hoveredObjectId = null;
    onPointerChange(null);
    onRender();
  });

  canvas.addEventListener('click', async (event) => {
    const point = eventToFramePoint(
      event,
      canvas,
      state.config.frameWidth,
      state.config.frameHeight
    );

    if (!point) return;

    if (state.selectionMode === 'POINT') {
      await onSelectPoint(point);
      return;
    }

    const object = getObjectAtPoint(state.objects, point.x, point.y);
    const id = getObjectId(object);
    if (id !== null) await onSelectObject(id);
  });
}
