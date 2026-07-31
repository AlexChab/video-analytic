/** Рисует фон-сетку, чтобы координаты были понятны даже без видеокадра. */
function drawGrid(ctx, width, height) {
  ctx.fillStyle = '#060b11';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#142235';
  ctx.lineWidth = 1;
  const step = 100;

  for (let x = 0; x <= width; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y <= height; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
}

function normalizeBox(object) {
  const box = object.bbox || object.box || object.rect || object;
  const x = Number(box.x ?? box.left ?? 0);
  const y = Number(box.y ?? box.top ?? 0);
  const width = Number(box.width ?? box.w ?? ((box.right ?? x) - x));
  const height = Number(box.height ?? box.h ?? ((box.bottom ?? y) - y));
  return { x, y, width, height };
}

/** Отрисовывает обнаруженные объекты и выделяет выбранный/наведённый объект. */
function drawObjects(ctx, objects, selectedObjectId, hoveredObjectId) {
  for (const object of objects) {
    const id = object.id ?? object.objectId ?? object.trackId;
    const box = normalizeBox(object);
    const selected = String(id) === String(selectedObjectId);
    const hovered = String(id) === String(hoveredObjectId);

    ctx.strokeStyle = selected ? '#35d07f' : hovered ? '#ffd166' : '#ff5d68';
    ctx.lineWidth = selected ? 5 : hovered ? 4 : 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    const label = `ID ${id ?? '?'}`;
    ctx.font = '24px Segoe UI, Arial';
    const labelWidth = ctx.measureText(label).width + 16;
    ctx.fillStyle = selected ? '#17673f' : hovered ? '#785f12' : '#7b2630';
    ctx.fillRect(box.x, Math.max(0, box.y - 32), labelWidth, 32);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, box.x + 8, Math.max(24, box.y - 8));
  }
}

function drawSelectedPoint(ctx, point) {
  if (!point) return;
  ctx.strokeStyle = '#50a7ff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 18, 0, Math.PI * 2);
  ctx.moveTo(point.x - 28, point.y); ctx.lineTo(point.x + 28, point.y);
  ctx.moveTo(point.x, point.y - 28); ctx.lineTo(point.x, point.y + 28);
  ctx.stroke();
}

function drawOverlay(ctx, width, status, mode) {
  const lines = [
    `MODE: ${mode}`,
    `STATE: ${status?.state ?? status?.status ?? 'UNKNOWN'}`,
    `TARGET: ${status?.targetId ?? status?.selectedId ?? status?.target?.id ?? '—'}`
  ];

  ctx.font = '25px Consolas, monospace';
  const maxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
  ctx.fillStyle = 'rgba(4, 9, 15, .78)';
  ctx.fillRect(width - maxWidth - 42, 18, maxWidth + 24, lines.length * 34 + 18);
  ctx.fillStyle = '#dceaff';
  lines.forEach((line, index) => ctx.fillText(line, width - maxWidth - 30, 49 + index * 34));
}

/** Полная перерисовка Canvas по текущему состоянию приложения. */
export function renderCanvas(canvas, state) {
  const ctx = canvas.getContext('2d');
  const width = state.config.frameWidth;
  const height = state.config.frameHeight;

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  drawGrid(ctx, width, height);
  drawObjects(ctx, state.objects, state.selectedObjectId, state.hoveredObjectId);
  drawSelectedPoint(ctx, state.selectedPoint);
  drawOverlay(ctx, width, state.trackingStatus, state.selectionMode);
}

export function getObjectAtPoint(objects, x, y) {
  return [...objects].reverse().find((object) => {
    const box = normalizeBox(object);
    return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
  }) || null;
}

export function getObjectId(object) {
  return object?.id ?? object?.objectId ?? object?.trackId ?? null;
}
