'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cv = require('@u4/opencv4nodejs');
const logger = require('../utils/Logger');
const OverlayPanel = require('../ui/OverlayPanel');

/**
 * Motion Inspector v2.1.
 *
 * Инженерный стенд Motion-конвейера.
 *
 * LIVE:
 *   показывает стадии Motion в реальном времени.
 *
 * FREEZE:
 *   замораживает кадр И полный diagnostics snapshot.
 *   После этого можно переключаться по конкретным рамкам и смотреть
 *   их паспорт: геометрия, стадия, причина reject, пороги, состояние
 *   DetectionStabilizer и наличие Object ID.
 *
 * Inspector не участвует в детекции/трекинге и не меняет их состояние.
 *
 * v2.1:
 * паспорт рисуется поверх исходного Mat. Не создаются дополнительные Mat и
 * hConcat(), что устраняет native crash в @u4/opencv4nodejs при FREEZE.
 */
class MotionInspector {
  constructor(options = {}) {
    this.windowCreated = false;

    this.frozen = false;
    this.frozenFrame = null;
    this.frozenDiagnostics = null;
    this.frozenStableDetections = [];

    this.selectedIndex = 0;
    this.stageFilter = 'ALL';
    this.lastLiveFrame = null;
    this.lastLiveDiagnostics = null;
    this.lastLiveStableDetections = [];

    this.updateConfiguration(options);

    this.colors = {
      reject: new cv.Vec3(0, 165, 255),       // orange
      preMerge: new cv.Vec3(255, 180, 0),     // blue/cyan
      postMerge: new cv.Vec3(255, 0, 255),    // magenta
      finalAccepted: new cv.Vec3(0, 255, 0),  // green
      stabilizerWait: new cv.Vec3(0, 255, 255), // yellow
      stabilizerConfirmed: new cv.Vec3(255, 255, 0),
      objectId: new cv.Vec3(0, 0, 255),       // red
      selected: new cv.Vec3(255, 255, 255),   // white
      white: new cv.Vec3(255, 255, 255),
      yellow: new cv.Vec3(0, 255, 255),
      green: new cv.Vec3(0, 255, 0),
      red: new cv.Vec3(0, 0, 255),
      black: new cv.Vec3(0, 0, 0),
      gray: new cv.Vec3(170, 170, 170),
    };

    this.passportPanel = new OverlayPanel({
      width: this.passportWidth,
      margin: 12,
      padding: 12,
      lineHeight: 23,
      background: new cv.Vec3(12, 12, 12),
      border: new cv.Vec3(220, 220, 220),
      defaultText: this.colors.white,
    });
  }

  updateConfiguration(options = {}) {
    const config = options && typeof options === 'object' ? options : {};

    this.enabled = config.enabled !== false;
    this.showWindow = config.showWindow !== false;
    this.windowName = String(config.windowName || 'MOTION INSPECTOR');
    this.scale = Math.min(1, Math.max(0.25, Number(config.scale) || 0.65));

    this.maxRejectBoxes = Math.max(
      1,
      Math.min(100, Math.trunc(Number(config.maxRejectBoxes) || 30)),
    );

    this.showRejects = config.showRejects !== false;
    this.showPreMerge = config.showPreMerge !== false;
    this.showPostMerge = config.showPostMerge !== false;
    this.showFinalAccepted = config.showFinalAccepted !== false;
    this.showStableDetections = config.showStableDetections !== false;
    this.showStabilizerTracks = config.showStabilizerTracks !== false;
    this.showLegend = config.showLegend !== false;

    this.passportWidth = Math.max(
      360,
      Math.min(720, Math.trunc(Number(config.passportWidth) || 470)),
    );

    this.snapshotDirectory = path.resolve(
      String(
        config.snapshotDirectory ||
        path.join(__dirname, '..', '..', 'output', 'motion-inspector'),
      ),
    );

    if (this.passportPanel) {
      this.passportPanel.updateConfiguration({
        width: this.passportWidth,
      });
    }

    if ((!this.enabled || !this.showWindow) && this.windowCreated) {
      this.#destroyWindow();
    }

    return this.getConfiguration();
  }

  getConfiguration() {
    return {
      enabled: this.enabled,
      showWindow: this.showWindow,
      windowName: this.windowName,
      scale: this.scale,
      maxRejectBoxes: this.maxRejectBoxes,
      showRejects: this.showRejects,
      showPreMerge: this.showPreMerge,
      showPostMerge: this.showPostMerge,
      showFinalAccepted: this.showFinalAccepted,
      showStableDetections: this.showStableDetections,
      showStabilizerTracks: this.showStabilizerTracks,
      showLegend: this.showLegend,
      passportWidth: this.passportWidth,
      snapshotDirectory: this.snapshotDirectory,
    };
  }

  /**
   * Обрабатывает клавишу, которую уже получил главный cv.waitKey()/waitKeyEx().
   *
   * F9 может иметь разный код в разных HighGUI backend, поэтому также
   * поддерживается клавиша F как надёжный запасной вариант.
   */
  handleKey(keyCode) {
    if (!this.enabled || !Number.isFinite(Number(keyCode))) return false;

    const key = Number(keyCode);
    const lowByte = key & 0xff;

    // Windows/OpenCV waitKeyEx: F9 обычно 0x780000.
    const isF9 =
      key === 0x780000 ||
      key === 7864320 ||
      lowByte === 120 && key > 255;

    if (isF9 || lowByte === 70 || lowByte === 102) {
      this.toggleFreeze();
      return true;
    }

    // TAB — следующий объект.
    if (lowByte === 9) {
      this.selectNext();
      return true;
    }

    // B — предыдущий объект. Надёжнее Shift+TAB в HighGUI.
    if (lowByte === 66 || lowByte === 98) {
      this.selectPrevious();
      return true;
    }

    // S — сохранить frozen snapshot.
    if (lowByte === 83 || lowByte === 115) {
      this.saveSnapshot();
      return true;
    }

    // 0..6 — фильтр стадии.
    const stageByKey = {
      48: 'ALL',
      49: 'REJECT',
      50: 'PRE',
      51: 'MERGE',
      52: 'RAW',
      53: 'STAB',
      54: 'ID',
    };

    if (stageByKey[lowByte]) {
      this.stageFilter = stageByKey[lowByte];
      this.selectedIndex = 0;
      return true;
    }

    return false;
  }

  toggleFreeze() {
    if (!this.frozen) {
      if (!this.lastLiveFrame || !this.lastLiveDiagnostics) return false;

      this.frozenFrame = this.lastLiveFrame.copy();
      this.frozenDiagnostics = this.#clone(this.lastLiveDiagnostics);
      this.frozenStableDetections =
        this.#clone(this.lastLiveStableDetections) ?? [];
      this.frozen = true;
      this.selectedIndex = 0;

      logger.info('[MOTION] Inspector FREEZE: снимок кадра зафиксирован.');
      return true;
    }

    this.frozen = false;
    this.frozenFrame = null;
    this.frozenDiagnostics = null;
    this.frozenStableDetections = [];
    this.selectedIndex = 0;

    logger.info('[MOTION] Inspector LIVE: просмотр продолжен.');
    return true;
  }

  selectNext() {
    if (!this.frozen) return;
    const objects = this.#buildSelectableObjects(
      this.frozenDiagnostics,
      this.frozenStableDetections,
    );
    if (objects.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % objects.length;
  }

  selectPrevious() {
    if (!this.frozen) return;
    const objects = this.#buildSelectableObjects(
      this.frozenDiagnostics,
      this.frozenStableDetections,
    );
    if (objects.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex - 1 + objects.length) % objects.length;
  }

  process(frame, diagnostics, stableDetections = []) {
    if (!this.enabled || !this.showWindow || !frame || !diagnostics?.enabled) {
      return;
    }

    try {
      if (!this.frozen) {
        this.lastLiveFrame = frame.copy();
        this.lastLiveDiagnostics = this.#clone(diagnostics);
        this.lastLiveStableDetections = this.#clone(stableDetections) ?? [];
      }

      const sourceFrame = this.frozen
        ? this.frozenFrame
        : frame;

      const sourceDiagnostics = this.frozen
        ? this.frozenDiagnostics
        : diagnostics;

      const sourceStableDetections = this.frozen
        ? this.frozenStableDetections
        : stableDetections;

      if (!sourceFrame || !sourceDiagnostics) return;

      const preview = sourceFrame.copy();
      const data = sourceDiagnostics.inspector ?? {};

      this.#drawPipeline(
        preview,
        sourceDiagnostics,
        sourceStableDetections,
      );

      const selectable = this.#buildSelectableObjects(
        sourceDiagnostics,
        sourceStableDetections,
      );

      const selected = this.frozen && selectable.length > 0
        ? selectable[
          Math.min(this.selectedIndex, selectable.length - 1)
        ]
        : null;

      if (selected) {
        this.#drawSelected(preview, selected);
      }

      if (this.showLegend) {
        this.#drawTopPanel(
          preview,
          sourceDiagnostics,
          sourceStableDetections.length,
          selectable.length,
        );
      }

      if (this.frozen) {
        this.#drawPassportOverlay(
          preview,
          selected,
          sourceDiagnostics,
          selectable.length,
        );
      }

      const output = this.scale < 0.999
        ? preview.resize(
          Math.max(1, Math.round(preview.rows * this.scale)),
          Math.max(1, Math.round(preview.cols * this.scale)),
          0,
          0,
          cv.INTER_AREA,
        )
        : preview;

      this.#ensureWindow();
      cv.imshow(this.windowName, output);
    } catch (error) {
      logger.warn?.(
        `[MOTION] Inspector временно недоступен: ${error.message}`,
      );
    }
  }

  saveSnapshot() {
    if (!this.frozen || !this.frozenFrame || !this.frozenDiagnostics) {
      logger.info(
        '[MOTION] Snapshot не сохранён: сначала включите FREEZE (F9/F).',
      );
      return null;
    }

    try {
      fs.mkdirSync(this.snapshotDirectory, { recursive: true });

      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-');

      const baseName = `motion_${stamp}`;
      const jpgPath = path.join(this.snapshotDirectory, `${baseName}.jpg`);
      const jsonPath = path.join(this.snapshotDirectory, `${baseName}.json`);

      cv.imwrite(jpgPath, this.frozenFrame);

      const payload = {
        schema: 'motion-inspector-snapshot-v1',
        createdAt: new Date().toISOString(),
        stageFilter: this.stageFilter,
        diagnostics: this.frozenDiagnostics,
        stableDetections: this.frozenStableDetections,
      };

      fs.writeFileSync(
        jsonPath,
        JSON.stringify(payload, null, 2),
        'utf8',
      );

      logger.info(
        `[MOTION] Engineering Snapshot сохранён: ${jpgPath}; ${jsonPath}`,
      );

      return { jpgPath, jsonPath };
    } catch (error) {
      logger.error?.(
        `[MOTION] Ошибка сохранения Engineering Snapshot: ${error.message}`,
      );
      return null;
    }
  }

  dispose() {
    this.lastLiveFrame = null;
    this.frozenFrame = null;
    this.#destroyWindow();
  }

  #drawPipeline(frame, diagnostics, stableDetections) {
    const data = diagnostics.inspector ?? {};

    if (this.#stageVisible('PRE') && this.showPreMerge) {
      this.#drawBoxes(frame, data.preMerge, this.colors.preMerge, 'PRE');
    }

    if (this.#stageVisible('MERGE') && this.showPostMerge) {
      this.#drawBoxes(
        frame,
        data.postMerge,
        this.colors.postMerge,
        'MERGE',
      );
    }

    if (this.#stageVisible('RAW') && this.showFinalAccepted) {
      this.#drawBoxes(
        frame,
        data.finalAccepted,
        this.colors.finalAccepted,
        'RAW',
      );
    }

    if (this.#stageVisible('REJECT') && this.showRejects) {
      const rejects = Array.isArray(data.rejects)
        ? data.rejects.slice(0, this.maxRejectBoxes)
        : [];

      rejects.forEach((box) => {
        this.#drawBox(
          frame,
          box,
          this.colors.reject,
          `REJ:${box.reason}`,
          1,
        );
      });
    }

    if (this.#stageVisible('STAB') && this.showStabilizerTracks) {
      const tracks = Array.isArray(data.stabilizerTracks)
        ? data.stabilizerTracks
        : [];

      tracks.forEach((track) => {
        const box = {
          ...(track.box ?? {}),
          trackId: track.trackId,
        };
        const color = track.confirmed
          ? this.colors.stabilizerConfirmed
          : this.colors.stabilizerWait;
        const state = track.confirmed ? 'OK' : 'WAIT';

        this.#drawBox(
          frame,
          box,
          color,
          `STAB:${track.trackId} ${state} ${track.seenFrames}/${track.requiredConfirmFrames}`,
          track.confirmed ? 2 : 1,
        );
      });
    }

    if (this.#stageVisible('ID') && this.showStableDetections) {
      this.#drawBoxes(
        frame,
        stableDetections,
        this.colors.objectId,
        'ID',
        2,
        true,
      );
    }
  }

  #buildSelectableObjects(diagnostics, stableDetections) {
    if (!diagnostics?.inspector) return [];

    const data = diagnostics.inspector;
    const result = [];

    const add = (stage, boxes, extra = {}) => {
      if (!this.#stageVisible(stage) || !Array.isArray(boxes)) return;
      boxes.forEach((box, index) => {
        if (!box || Number(box.width) <= 0 || Number(box.height) <= 0) return;
        result.push({
          inspectId: `${stage}-${index + 1}`,
          stage,
          index,
          box: {
            x: Number(box.x ?? box.box?.x ?? 0),
            y: Number(box.y ?? box.box?.y ?? 0),
            width: Number(box.width ?? box.box?.width ?? 0),
            height: Number(box.height ?? box.box?.height ?? 0),
            area: Number(
              box.area ??
              box.box?.area ??
              (Number(box.width ?? box.box?.width ?? 0) *
               Number(box.height ?? box.box?.height ?? 0)),
            ),
          },
          source: box,
          ...extra,
        });
      });
    };

    add('REJECT', data.rejects);
    add('PRE', data.preMerge);
    add('MERGE', data.postMerge);
    add('RAW', data.finalAccepted);

    const tracks = Array.isArray(data.stabilizerTracks)
      ? data.stabilizerTracks
      : [];

    tracks.forEach((track, index) => {
      if (!this.#stageVisible('STAB') || !track?.box) return;
      add('STAB', [{
        ...track.box,
        ...track,
      }], {
        stabilizerTrack: track,
        index,
      });
    });

    add('ID', stableDetections);

    return result;
  }

  /**
   * Паспорт рисуется прямо поверх существующего preview.
   *
   * Здесь принципиально нет:
   *   создание дополнительного Mat
   *   hConcat(...)
   *
   * Именно старое создание отдельной панели через конструктор Mat приводило к native
   * assertion val->IsArrayBufferView() в текущей Windows-сборке OpenCV.
   */
  #drawPassportOverlay(frame, selected, diagnostics, count) {
    const lines = this.#passportLines(
      selected,
      diagnostics,
      count,
    );

    const panelRect = this.passportPanel.draw(
      frame,
      lines,
      {
        width: this.passportWidth,
      },
    );

    /*
     * Для выбранной рамки рисуем тонкий "указатель" к паспорту.
     * Никаких дополнительных Mat — только line() на текущем preview.
     */
    if (selected && panelRect) {
      const b = selected.box;
      const fromX = Math.round(
        Number(b.x) + Number(b.width) / 2,
      );
      const fromY = Math.round(
        Number(b.y) + Number(b.height) / 2,
      );

      const toX = Math.round(panelRect.x);
      const toY = Math.round(
        Math.min(
          panelRect.y + panelRect.height - 16,
          Math.max(
            panelRect.y + 16,
            fromY,
          ),
        ),
      );

      if (
        Number.isFinite(fromX) &&
        Number.isFinite(fromY) &&
        fromX < panelRect.x
      ) {
        frame.drawLine(
          new cv.Point2(fromX, fromY),
          new cv.Point2(toX, toY),
          this.colors.selected,
          1,
          cv.LINE_AA,
        );
      }
    }
  }

  #passportLines(selected, diagnostics, count) {
    const thresholds = diagnostics?.thresholds ?? {};
    const lines = [
      {
        text: `MOTION OBJECT PASSPORT`,
        color: this.colors.yellow,
        header: true,
      },
      {
        text: `MODE=FREEZE FILTER=${this.stageFilter}`,
        color: this.colors.white,
      },
      {
        text: `SELECTED ${count > 0 ? this.selectedIndex + 1 : 0}/${count}`,
        color: this.colors.white,
      },
      {
        text: 'TAB=NEXT  B=PREV  0..6=FILTER',
        color: this.colors.gray,
      },
      {
        text: 'F9/F=LIVE  S=SAVE SNAPSHOT',
        color: this.colors.gray,
      },
    ];

    if (!selected) {
      lines.push({
        text: 'NO SELECTABLE BOXES',
        color: this.colors.red,
      });
      return lines;
    }

    const b = selected.box;
    const aspect = b.height > 0 ? b.width / b.height : 0;

    lines.push(
      { text: `ID=${selected.inspectId}`, color: this.colors.selected, header: true },
      { text: `STAGE=${selected.stage}`, color: this.#colorForStage(selected.stage) },
      { text: `x=${Math.round(b.x)} y=${Math.round(b.y)}` },
      { text: `w=${Math.round(b.width)} h=${Math.round(b.height)}` },
      { text: `area=${Math.round(b.area)}` },
      { text: `aspect=${aspect.toFixed(3)}` },
    );

    if (selected.stage === 'REJECT') {
      const src = selected.source ?? {};
      lines.push(
        { text: `REASON=${src.reason ?? '-'}`, color: this.colors.reject, header: true },
        { text: `REJECT_STAGE=${src.stage ?? '-'}` },
        {
          text: `contourArea=${Number(src.contourArea ?? 0).toFixed(1)}`,
        },
      );
    }

    lines.push(
      { text: 'FILTER CHECK', color: this.colors.yellow, header: true },
      this.#checkMin('BOX_AREA', b.area, thresholds.minBoxArea),
      this.#checkMin('WIDTH', b.width, thresholds.minWidth),
      this.#checkMin('HEIGHT', b.height, thresholds.minHeight),
      this.#checkRange(
        'ASPECT',
        aspect,
        thresholds.minAspectRatio,
        thresholds.maxAspectRatio,
      ),
    );

    if (Number.isFinite(Number(thresholds.minContourArea))) {
      const contourArea = Number(selected.source?.contourArea);
      if (Number.isFinite(contourArea) && contourArea > 0) {
        lines.push(
          this.#checkMin(
            'CONTOUR',
            contourArea,
            thresholds.minContourArea,
          ),
        );
      }
    }

    const match = this.#findMatchingStabilizerTrack(selected, diagnostics);

    lines.push({
      text: 'STABILIZER',
      color: this.colors.yellow,
      header: true,
    });

    if (!match) {
      lines.push({
        text: selected.stage === 'RAW'
          ? 'MATCH=NO -> NO RED ID YET'
          : 'MATCH=NO',
        color: this.colors.red,
      });
    } else {
      lines.push(
        { text: `track=${match.trackId}` },
        {
          text:
            `seen=${match.seenFrames}/${match.requiredConfirmFrames} ` +
            `${match.confirmed ? 'CONFIRMED' : 'WAIT'}`,
          color: match.confirmed
            ? this.colors.green
            : this.colors.yellow,
        },
        { text: `matched=${match.matched ? 'YES' : 'NO'} lost=${match.lostFrames}` },
        { text: `state=${match.state}` },
      );

      if (!match.confirmed) {
        lines.push({
          text: 'RED BOX BLOCKED BY CONFIRM_FRAMES',
          color: this.colors.red,
        });
      }
    }

    const objectMatch = this.#findMatchingObjectId(selected, diagnostics);

    lines.push({
      text: 'OBJECT ID',
      color: this.colors.yellow,
      header: true,
    });

    if (objectMatch) {
      lines.push({
        text: `ID=${objectMatch.id ?? '-'} PRESENT`,
        color: this.colors.green,
      });
    } else {
      lines.push({
        text: 'ID=NO',
        color: this.colors.red,
      });
    }

    return lines;
  }

  #checkMin(name, value, limit) {
    const actual = Number(value);
    const threshold = Number(limit);

    if (!Number.isFinite(threshold)) {
      return { text: `${name}: n/a`, color: this.colors.gray };
    }

    const pass = actual >= threshold;
    return {
      text:
        `${name}: ${actual.toFixed(1)} ` +
        `${pass ? '>=' : '<'} ${threshold.toFixed(1)} ` +
        `${pass ? 'PASS' : 'FAIL'}`,
      color: pass ? this.colors.green : this.colors.red,
    };
  }

  #checkRange(name, value, min, max) {
    const actual = Number(value);
    const lower = Number(min);
    const upper = Number(max);

    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
      return { text: `${name}: n/a`, color: this.colors.gray };
    }

    const pass = actual >= lower && actual <= upper;
    return {
      text:
        `${name}: ${actual.toFixed(3)} ` +
        `[${lower.toFixed(3)}..${upper.toFixed(3)}] ` +
        `${pass ? 'PASS' : 'FAIL'}`,
      color: pass ? this.colors.green : this.colors.red,
    };
  }

  #findMatchingStabilizerTrack(selected, diagnostics) {
    const tracks = diagnostics?.inspector?.stabilizerTracks;
    if (!Array.isArray(tracks) || !selected?.box) return null;

    let best = null;
    let bestScore = -Infinity;

    for (const track of tracks) {
      if (!track?.box) continue;
      const iou = this.#iou(selected.box, track.box);
      const distance = this.#centerDistance(selected.box, track.box);
      const score = iou * 1000 - distance;

      if (score > bestScore && (iou > 0.01 || distance < 120)) {
        best = track;
        bestScore = score;
      }
    }

    return best;
  }

  #findMatchingObjectId(selected, diagnostics) {
    const objects = diagnostics?.inspector?.objectIds;
    if (!Array.isArray(objects) || !selected?.box) return null;

    let best = null;
    let bestScore = -Infinity;

    for (const object of objects) {
      const iou = this.#iou(selected.box, object);
      const distance = this.#centerDistance(selected.box, object);
      const score = iou * 1000 - distance;

      if (score > bestScore && (iou > 0.01 || distance < 120)) {
        best = object;
        bestScore = score;
      }
    }

    return best;
  }

  #drawTopPanel(frame, diagnostics, stableCount, selectableCount) {
    const f = diagnostics.frame ?? {};
    const r = f.rejected ?? {};
    const i = diagnostics.inspector ?? {};

    const width = Math.min(frame.cols - 20, 900);
    const height = this.frozen ? 206 : 176;

    frame.drawRectangle(
      new cv.Point2(10, 10),
      new cv.Point2(10 + width, 10 + height),
      this.colors.black,
      -1,
      cv.LINE_8,
    );

    const tracks = Array.isArray(i.stabilizerTracks)
      ? i.stabilizerTracks
      : [];
    const waiting = tracks.filter((item) => !item.confirmed).length;

    const lines = [
      `MOTION INSPECTOR ${this.frozen ? '[FREEZE]' : '[LIVE]'} contours=${f.contours ?? 0}`,
      `PIPE pre=${i.preMerge?.length ?? 0} merge=${i.postMerge?.length ?? 0} ` +
        `raw=${i.finalAccepted?.length ?? 0} stab=${tracks.length} id=${stableCount}`,
      `STABILIZER waiting=${waiting} confirm=${tracks.length - waiting}`,
      `REJECT contour=${r.CONTOUR_AREA ?? 0} box=${r.BOX_AREA ?? 0} ` +
        `w=${r.WIDTH ?? 0} h=${r.HEIGHT ?? 0} asp=${r.ASPECT ?? 0} max=${r.MAX_AREA ?? 0}`,
      this.frozen
        ? `SELECT ${Math.min(this.selectedIndex + 1, Math.max(0, selectableCount))}/${selectableCount} ` +
          `FILTER=${this.stageFilter}  TAB next / B prev / 0..6 stage`
        : 'F9 or F = FREEZE',
      this.frozen
        ? 'S = SAVE JSON+JPG    F9/F = RESUME'
        : 'BLUE PRE | MAGENTA MERGE | GREEN RAW | YELLOW STAB | RED ID | ORANGE REJECT',
    ];

    lines.forEach((text, index) => {
      frame.putText(
        text,
        new cv.Point2(22, 38 + index * 28),
        cv.FONT_HERSHEY_SIMPLEX,
        index === 0 ? 0.58 : 0.44,
        index === 0 ? this.colors.yellow : this.colors.white,
        index === 0 ? 2 : 1,
        cv.LINE_AA,
      );
    });
  }

  #drawSelected(frame, selected) {
    this.#drawBox(
      frame,
      selected.box,
      this.colors.selected,
      `SELECTED ${selected.inspectId}`,
      4,
    );
  }

  #drawBoxes(frame, boxes, color, label, thickness = 1, showId = false) {
    if (!Array.isArray(boxes)) return;

    boxes.forEach((box) => {
      const suffix = showId && box.id !== undefined ? `:${box.id}` : '';
      this.#drawBox(frame, box, color, `${label}${suffix}`, thickness);
    });
  }

  #drawBox(frame, box, color, label, thickness = 1) {
    const x = Math.max(0, Math.round(Number(box.x) || 0));
    const y = Math.max(0, Math.round(Number(box.y) || 0));
    const width = Math.max(1, Math.round(Number(box.width) || 1));
    const height = Math.max(1, Math.round(Number(box.height) || 1));

    frame.drawRectangle(
      new cv.Point2(x, y),
      new cv.Point2(
        Math.min(frame.cols - 1, x + width),
        Math.min(frame.rows - 1, y + height),
      ),
      color,
      thickness,
      cv.LINE_AA,
    );

    if (label) {
      frame.putText(
        label,
        new cv.Point2(x, Math.max(14, y - 4)),
        cv.FONT_HERSHEY_SIMPLEX,
        0.36,
        color,
        1,
        cv.LINE_AA,
      );
    }
  }

  #stageVisible(stage) {
    return this.stageFilter === 'ALL' || this.stageFilter === stage;
  }

  #colorForStage(stage) {
    const map = {
      REJECT: this.colors.reject,
      PRE: this.colors.preMerge,
      MERGE: this.colors.postMerge,
      RAW: this.colors.finalAccepted,
      STAB: this.colors.stabilizerWait,
      ID: this.colors.objectId,
    };

    return map[stage] ?? this.colors.white;
  }

  #iou(a, b) {
    const ax2 = Number(a.x) + Number(a.width);
    const ay2 = Number(a.y) + Number(a.height);
    const bx2 = Number(b.x) + Number(b.width);
    const by2 = Number(b.y) + Number(b.height);

    const x1 = Math.max(Number(a.x), Number(b.x));
    const y1 = Math.max(Number(a.y), Number(b.y));
    const x2 = Math.min(ax2, bx2);
    const y2 = Math.min(ay2, by2);

    const intersection =
      Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

    if (intersection <= 0) return 0;

    const areaA = Number(a.width) * Number(a.height);
    const areaB = Number(b.width) * Number(b.height);
    const union = areaA + areaB - intersection;

    return union > 0 ? intersection / union : 0;
  }

  #centerDistance(a, b) {
    const ax = Number(a.x) + Number(a.width) / 2;
    const ay = Number(a.y) + Number(a.height) / 2;
    const bx = Number(b.x) + Number(b.width) / 2;
    const by = Number(b.y) + Number(b.height) / 2;

    return Math.hypot(ax - bx, ay - by);
  }

  #clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  #ensureWindow() {
    if (this.windowCreated) return;

    if (typeof cv.namedWindow === 'function') {
      cv.namedWindow(this.windowName, cv.WINDOW_NORMAL);
    }

    this.windowCreated = true;
  }

  #destroyWindow() {
    if (!this.windowCreated) return;

    try {
      if (typeof cv.destroyWindow === 'function') {
        cv.destroyWindow(this.windowName);
      }
    } catch {
      // Окно могло быть закрыто вручную.
    }

    this.windowCreated = false;
  }
}

module.exports = MotionInspector;
