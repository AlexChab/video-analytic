/** Рисует нейтральную сетку, пока реальный видеопоток не подключён. */
function drawGrid(ctx, width, height) {
  ctx.fillStyle = '#03070c';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#101c2b';
  ctx.lineWidth = 1;

  for (let x = 0; x <= width; x += 100) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y <= height; y += 100) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
}

/** Приводит разные варианты bbox из API к единому формату. */
export function normalizeBox(object) {
  const box = object?.bbox || object?.box || object?.rect || object || {};
  const x = Number(box.x ?? box.left ?? 0);
  const y = Number(box.y ?? box.top ?? 0);
  const width = Number(box.width ?? box.w ?? ((box.right ?? x) - x));
  const height = Number(box.height ?? box.h ?? ((box.bottom ?? y) - y));
  return { x, y, width, height };
}

export function getObjectId(object) {
  return object?.id ?? object?.objectId ?? object?.trackId ?? null;
}

function drawCornerFrame(ctx, box, color, lineWidth) {
  const corner = Math.max(16, Math.min(42, Math.min(box.width, box.height) * .28));
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(box.x + corner, box.y); ctx.lineTo(box.x, box.y); ctx.lineTo(box.x, box.y + corner);
  ctx.moveTo(box.x + box.width - corner, box.y); ctx.lineTo(box.x + box.width, box.y); ctx.lineTo(box.x + box.width, box.y + corner);
  ctx.moveTo(box.x, box.y + box.height - corner); ctx.lineTo(box.x, box.y + box.height); ctx.lineTo(box.x + corner, box.y + box.height);
  ctx.moveTo(box.x + box.width - corner, box.y + box.height); ctx.lineTo(box.x + box.width, box.y + box.height); ctx.lineTo(box.x + box.width, box.y + box.height - corner);
  ctx.stroke();
}

/** Красные рамки — обнаружения; зелёная рамка — единственная активная цель. */
function drawObjects(ctx, state) {
  const activeId = state.activeTarget?.targetId;

  for (const object of state.objects) {
    const id = getObjectId(object);
    const box = normalizeBox(object);
    const active = activeId !== null && activeId !== undefined && String(id) === String(activeId);
    const hovered = state.mode === 'SEARCH' && String(id) === String(state.hoveredObjectId);
    const color = active ? '#45e693' : hovered ? '#ffcf63' : '#ff4d5c';

    drawCornerFrame(ctx, box, color, active ? 6 : hovered ? 5 : 4);
    const label = active ? `T${id ?? '?'}` : `${id ?? '?'}`;
    ctx.font = '700 22px Consolas, monospace';
    const labelWidth = ctx.measureText(label).width + 18;
    ctx.fillStyle = active ? 'rgba(14, 104, 63, .92)' : hovered ? 'rgba(126, 92, 16, .92)' : 'rgba(119, 28, 39, .9)';
    ctx.fillRect(box.x, Math.max(0, box.y - 30), labelWidth, 30);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, box.x + 9, Math.max(22, box.y - 8));
  }
}

function drawCenterMarker(ctx, target) {
  if (!target) return;
  const { x, y } = target.frame;
  ctx.strokeStyle = '#45e693';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 18, y); ctx.lineTo(x + 18, y);
  ctx.moveTo(x, y - 18); ctx.lineTo(x, y + 18);
  ctx.stroke();
}

export function renderCanvas(canvas, state) {
  const ctx = canvas.getContext('2d');
  const width = state.config.frameWidth;
  const height = state.config.frameHeight;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  drawGrid(ctx, width, height);
  drawObjects(ctx, state);
  drawCenterMarker(ctx, state.activeTarget);
}

export function getObjectAtPoint(objects, x, y) {
  return [...objects].reverse().find((object) => {
    const box = normalizeBox(object);
    return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
  }) || null;
}
