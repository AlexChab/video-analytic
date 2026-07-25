const { app, BrowserWindow } = require('electron');

function createWindow() {
  const win = new BrowserWindow({ width: 800, height: 600 });
  win.loadFile('index.html'); // или win.loadURL('http://localhost:3000')
}

app.whenReady().then(createWindow);
