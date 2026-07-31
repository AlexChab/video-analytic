'use strict';

/**
 * ВАЖНО:
 * путь к DLL OpenCV нужно добавить до подключения opencv4nodejs.
 */
const openCvBinPath = 'C:\\project\\opencv\\install-contrib\\x64\\vc17\\bin';

process.env.PATH = `${openCvBinPath};${process.env.PATH}`;

process.env.OPENCV4NODEJS_DISABLE_EXTERNAL_MEM_TRACKING = '1';

const cv = require('@u4/opencv4nodejs');

/**
 * Имя тестового окна.
 */
const windowName = 'Mouse callback smoke test';

/**
 * Безопасно выводит тип свойства.
 *
 * @param {object} object Объект, который проверяем.
 * @param {string} propertyName Название свойства.
 */
function printPropertyType(object, propertyName) {
  const value = object?.[propertyName];

  console.log(`[Проверка] ${propertyName}: ${typeof value}`);
}

/**
 * Выводим основную информацию о сборке.
 */
console.log('======================================');
console.log('Проверка обработчика мыши OpenCV');
console.log('======================================');

// console.log(`[OpenCV] Версия: ${cv.version ?? 'не определена'}`);
/**
 * В этой сборке cv.version является объектом:
 * { major, minor, revision }.
 */
const openCvVersion =
  cv.version && typeof cv.version === 'object'
    ? [cv.version.major, cv.version.minor, cv.version.revision]
        .filter(Number.isFinite)
        .join('.')
    : String(cv.version ?? 'не определена');

console.log(`[OpenCV] Версия: ${openCvVersion}`);

console.log(`[Node.js] Версия: ${process.version}`);

/**
 * Проверяем глобальные функции модуля cv.
 */
console.log('\n[1] Глобальные функции cv:');

printPropertyType(cv, 'setMouseCallback');
printPropertyType(cv, 'namedWindow');
printPropertyType(cv, 'imshow');
printPropertyType(cv, 'waitKey');
printPropertyType(cv, 'destroyWindow');
printPropertyType(cv, 'destroyAllWindows');

/**
 * Проверяем константы событий мыши.
 */
console.log('\n[2] Константы событий мыши:');

const mouseConstants = [
  'EVENT_MOUSEMOVE',
  'EVENT_LBUTTONDOWN',
  'EVENT_LBUTTONUP',
  'EVENT_RBUTTONDOWN',
  'EVENT_RBUTTONUP',
  'EVENT_MBUTTONDOWN',
  'EVENT_MBUTTONUP',
  'EVENT_LBUTTONDBLCLK',
  'EVENT_RBUTTONDBLCLK',
  'EVENT_MOUSEWHEEL',
];

for (const constantName of mouseConstants) {
  console.log(`[Проверка] ${constantName}:`, cv[constantName]);
}

/**
 * Создаём простой тестовый кадр.
 */
const width = 800;
const height = 500;

// const frame = new cv.Mat(height, width, cv.CV_8UC3, new cv.Vec3(35, 35, 35));
/**
 * Создаём чёрный BGR-кадр.
 *
 * Не передаём cv.Vec3 четвёртым аргументом конструктора Mat:
 * в текущей версии Node.js/native-привязки этот аргумент ошибочно
 * обрабатывается как Buffer и приводит к аварийному завершению процесса.
 */
const frame = cv.Mat.zeros(height, width, cv.CV_8UC3);

/**
 * Рисуем инструкции.
 */
frame.putText(
  'Click inside this window',
  new cv.Point2(170, 220),
  cv.FONT_HERSHEY_SIMPLEX,
  1,
  new cv.Vec3(255, 255, 255),
  2,
  cv.LINE_AA,
);

frame.putText(
  'ESC - exit',
  new cv.Point2(315, 280),
  cv.FONT_HERSHEY_SIMPLEX,
  0.7,
  new cv.Vec3(0, 255, 255),
  2,
  cv.LINE_AA,
);

/**
 * Создаём окно.
 *
 * В разных версиях opencv4nodejs окно может создаваться:
 *
 * 1. глобальной функцией cv.namedWindow();
 * 2. автоматически при первом cv.imshow();
 * 3. через класс cv.Window.
 */
let windowObject = null;

if (typeof cv.Window === 'function') {
  try {
    windowObject = new cv.Window(windowName);

    console.log('\n[3] Объект cv.Window успешно создан.');
  } catch (error) {
    console.error('\n[3] Не удалось создать cv.Window:', error.message);
  }
} else {
  console.log('\n[3] Класс cv.Window не экспортируется.');
}

/**
 * Если объект окна создан, проверяем его методы.
 */
if (windowObject) {
  console.log('\n[4] Методы объекта окна:');

  printPropertyType(windowObject, 'setMouseCallback');

  printPropertyType(windowObject, 'imshow');

  printPropertyType(windowObject, 'show');

  printPropertyType(windowObject, 'destroy');
}

/**
 * Счётчик полученных событий.
 */
let mouseEventCount = 0;

/**
 * Универсальный обработчик.
 *
 * Возможная сигнатура зависит от конкретной версии обёртки.
 * Обычно ожидаются:
 *
 * event — код события;
 * x, y — координаты курсора;
 * flags — состояние клавиш и кнопок;
 * userdata — дополнительные пользовательские данные.
 */
function mouseHandler(event, x, y, flags, userdata) {
  mouseEventCount += 1;

  console.log(
    '[Мышь] ' +
      `event=${event}, ` +
      `x=${x}, ` +
      `y=${y}, ` +
      `flags=${flags}, ` +
      `userdata=${String(userdata)}, ` +
      `событий=${mouseEventCount}`,
  );

  /**
   * Отдельно отмечаем нажатие левой кнопки.
   */
  if (event === cv.EVENT_LBUTTONDOWN || event === 1) {
    console.log(`[Мышь] Левая кнопка нажата в точке (${x}, ${y})`);
  }

  /**
   * Отдельно отмечаем нажатие правой кнопки.
   */
  if (event === cv.EVENT_RBUTTONDOWN || event === 2) {
    console.log(`[Мышь] Правая кнопка нажата в точке (${x}, ${y})`);
  }
}

/**
 * Определяем доступный способ регистрации обработчика.
 */
let callbackRegistrationMode = null;

try {
  if (typeof cv.setMouseCallback === 'function') {
    /**
     * Вариант №1:
     * глобальная функция OpenCV.
     */
    callbackRegistrationMode = 'cv.setMouseCallback';

    /**
     * Сначала показываем окно, чтобы оно гарантированно существовало.
     */
    cv.imshow(windowName, frame);

    cv.setMouseCallback(windowName, mouseHandler);
  } else if (
    windowObject &&
    typeof windowObject.setMouseCallback === 'function'
  ) {
    /**
     * Вариант №2:
     * метод экземпляра cv.Window.
     */
    callbackRegistrationMode = 'windowObject.setMouseCallback';

    if (typeof windowObject.imshow === 'function') {
      windowObject.imshow(frame);
    } else if (typeof windowObject.show === 'function') {
      windowObject.show(frame);
    } else {
      cv.imshow(windowName, frame);
    }

    windowObject.setMouseCallback(mouseHandler);
  } else {
    console.error('\n[Результат] Обработчик мыши не экспортируется.');

    console.error(
      '[Результат] Не найдены ни ' +
        'cv.setMouseCallback(), ни ' +
        'window.setMouseCallback().',
    );

    /**
     * Выводим похожие имена экспортов.
     * Это поможет обнаружить другое название метода.
     */
    const possibleMouseExports = Object.keys(cv)
      .filter((key) => /mouse|callback|window|highgui/i.test(key))
      .sort();

    console.log('\n[Похожие экспорты cv]:');

    if (possibleMouseExports.length === 0) {
      console.log('Подходящие экспорты не найдены.');
    } else {
      for (const key of possibleMouseExports) {
        console.log(`- ${key}: ${typeof cv[key]}`);
      }
    }

    process.exitCode = 2;
  }
} catch (error) {
  console.error('\n[Ошибка] Регистрация обработчика завершилась ошибкой:');

  console.error(error);

  process.exitCode = 1;
}

if (callbackRegistrationMode) {
  console.log(
    '\n[Результат] Найден способ регистрации:',
    callbackRegistrationMode,
  );

  console.log(
    '[Действие] Нажмите левой и правой кнопкой ' + 'мыши внутри окна.',
  );

  console.log('[Действие] Для завершения нажмите ESC.');

  /**
   * Поддерживаем обработку событий HighGUI.
   *
   * Без waitKey() окно OpenCV может отображаться,
   * но события мыши и клавиатуры не будут обрабатываться.
   */
  let running = true;

  while (running) {
    const key = cv.waitKey(20);

    /**
     * Код 27 соответствует клавише ESC.
     */
    if (key === 27) {
      running = false;
    }
  }
}

/**
 * Корректно закрываем тестовое окно.
 */
try {
  if (typeof cv.destroyWindow === 'function') {
    cv.destroyWindow(windowName);
  } else if (windowObject && typeof windowObject.destroy === 'function') {
    windowObject.destroy();
  } else if (typeof cv.destroyAllWindows === 'function') {
    cv.destroyAllWindows();
  }
} catch (error) {
  console.error('[Завершение] Ошибка закрытия окна:', error.message);
}

console.log(`[Завершение] Получено событий мыши: ${mouseEventCount}`);
