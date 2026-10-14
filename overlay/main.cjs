// 🫧 Burbuja del agente (Electron): ventana sin marco, transparente y siempre encima de todas las ventanas que carga
// /overlay.html de AgentOffice. La lanza y la cierra server/browser/overlay.js con `npx electron@<fija> overlay/main.cjs`.
// Salir con código 0 = el usuario la ocultó (✕): AgentOffice no la vuelve a abrir hasta la próxima vez que se navegue.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');

const arg = (name, def) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || def;
const AO_URL = arg('ao-url', 'http://127.0.0.1:7420').replace(/\/$/, '');
const MARGIN = 16;

app.commandLine.appendSwitch('enable-transparent-visuals'); // transparencia en X11
app.commandLine.appendSwitch('disable-gpu'); // sin esto, en algunos Linux el fondo transparente sale negro
if (!app.requestSingleInstanceLock()) app.exit(0);

let win = null;
function create() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 320, h = 120;
  win = new BrowserWindow({
    width: w, height: h, x: workArea.x + workArea.width - w - MARGIN, y: workArea.y + workArea.height - h - MARGIN,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, title: 'AgentOffice · agente',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // por encima también de ventanas a pantalla completa
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Solo la página de la burbuja: nada de navegar a otro sitio ni abrir ventanas.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.showInactive()); // sin robar el foco a lo que estés haciendo
  win.loadURL(`${AO_URL}/overlay.html`);
}

// La página pide el tamaño que necesita; se crece hacia arriba/izquierda desde la esquina donde esté la ventana.
ipcMain.on('overlay:resize', (_, { width, height }) => {
  if (!win) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const w = Math.max(120, Math.min(Math.round(width), wa.width - 2 * MARGIN));
  const h = Math.max(60, Math.min(Math.round(height), wa.height - 2 * MARGIN));
  const right = b.x + b.width, bottom = b.y + b.height;
  win.setBounds({ x: Math.max(wa.x, right - w), y: Math.max(wa.y, bottom - h), width: w, height: h });
});
ipcMain.on('overlay:attention', () => { if (win) { win.showInactive(); win.moveTop(); } }); // pregunta nueva: al frente sin quitar el foco
ipcMain.on('overlay:close', () => app.exit(0));

app.whenReady().then(() => setTimeout(create, 150)); // el retardo evita el fondo negro de la transparencia en Linux
app.on('window-all-closed', () => app.exit(0));
