// FT-118 · Popup: ceder/quitar la pestaña actual y emparejar con AgentOffice.
const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);

async function paint() {
  const s = await send({ type: 'status' });
  $('st').textContent = `${s.connected ? '🟢 conectada' : '⚪ sin conexión'} · ${s.cededIds.length} pestaña(s) cedida(s)${s.error ? ' · ' + s.error : ''}`;
  if (!$('url').value) $('url').value = s.url;
  $('cede').disabled = !s.connected;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('revoke').disabled = !s.cededIds.includes(tab?.id);
}
$('cede').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await send({ type: 'cede', tabId: tab.id });
  if (r.error) $('st').textContent = r.error; else await paint();
};
$('revoke').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await send({ type: 'revoke', tabId: tab.id });
  await paint();
};
$('connect').onclick = async () => {
  await send({ type: 'connect', url: $('url').value.trim(), code: $('code').value.trim() });
  $('code').value = '';
  setTimeout(paint, 800);
};
paint();
