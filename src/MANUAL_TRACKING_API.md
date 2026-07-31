# Ручное сопровождение через HTTP API

По умолчанию проект запускается в режиме `MANUAL_TRACKING`.
До команды API красные рамки объектов не выводятся. Детектор работает скрыто,
назначает объектам ID и публикует их через API.

Адрес API: `http://127.0.0.1:8081`

## Получить состояние и список объектов

```powershell
Invoke-RestMethod http://127.0.0.1:8081/api/tracking/status
```

```powershell
Invoke-RestMethod http://127.0.0.1:8081/api/tracking/objects
```

## Захватить объект по ID

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"id":3}' `
  http://127.0.0.1:8081/api/tracking/target/id
```

## Захватить объект по координатам исходного RTSP-кадра

Для кадра 1920x1080 допустимы X=0..1919 и Y=0..1079.

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"x":960,"y":540}' `
  http://127.0.0.1:8081/api/tracking/target/point
```

Если точка находится внутри рамки объекта, выбирается этот объект. Иначе берётся
ближайший объект в радиусе `manualPointMaxDistance`.

## Сбросить активную цель

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8081/api/tracking/reset
```

## Полностью выключить слежение

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8081/api/tracking/disable
```

## Снова разрешить слежение

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8081/api/tracking/enable
```

Команда выбора по ID или координатам также автоматически включает слежение.
