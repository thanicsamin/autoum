const input = document.querySelector('#search');
const status = document.querySelector('#status');
chrome.fontSettings.getDefaultFontSize().then(({ pixelSize }) => { document.documentElement.style.fontSize = pixelSize + 'px'; });
chrome.fontSettings.onDefaultFontSizeChanged.addListener(({ pixelSize }) => { document.documentElement.style.fontSize = pixelSize + 'px'; });
document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault(); const text = input.value.trim(); if (!text) return;
  try {
    let address;
    if (/^(https?:|file:|chrome:|about:)/i.test(text)) address = text;
    else if (/^(localhost|(?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]\S*)?$/i.test(text)) address = 'http' + (text.startsWith('localhost') || /^\d/.test(text) ? '' : 's') + '://' + text;
    const tab = await chrome.tabs.getCurrent();
    if (address) await chrome.tabs.update(tab.id, { url: address });
    else await chrome.search.query({ text, tabId: tab.id });
  } catch (error) { status.textContent = error.message; }
});
document.querySelector('#assistant').addEventListener('click', () => {
  chrome.windows.getCurrent().then(window => chrome.sidePanel.open({ windowId: window.id })).catch(error => { status.textContent = error.message; });
});
